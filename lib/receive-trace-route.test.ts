import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signReceiptFormLink } from './receipt-form-link';

/**
 * POST /api/receipt-form/{id}/events against in-memory tables: the signed
 * link gates it, rows land as page 'receive' / token = form id / the form's
 * chat, unknown event names and kinds are dropped, and the kill switch
 * answers enabled:false.
 */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { receipt_forms: [], scanner_events: [] };
let insertError: string | null = null;

function fakeFrom(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain);
  chain.maybeSingle = () => Promise.resolve({ data: tables[table].find((r) => filters.every((f) => f(r))) ?? null, error: null });
  chain.insert = (rows: Row[]) => {
    if (insertError) return Promise.resolve({ error: { message: insertError } });
    tables[table].push(...rows);
    return Promise.resolve({ error: null });
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => fakeFrom(t) } }));

const { POST } = await import('@/app/api/receipt-form/[id]/events/route');

const SECRET = 'test-secret';
const A = '11111111-2222-3333-4444-555555555555';
const EXP = String(Math.floor(Date.now() / 1000) + 3600);
const SIG = signReceiptFormLink(A, EXP, SECRET);

const post = (body: unknown, id = A) =>
  POST(
    new NextRequest(`http://scanner.test/api/receipt-form/${id}/events`, {
      method: 'POST',
      // sendBeacon's Blob: the route must not depend on the header.
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const ev = (event: string, over: Row = {}) => ({ ts: Date.now(), seq: 0, kind: 'ui', event, data: { line: 2 }, ...over });

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { s: process.env.ADMIN_LINK_SECRET, k: process.env.RECEIVE_TRACE_DISABLED };
  process.env.ADMIN_LINK_SECRET = SECRET;
  delete process.env.RECEIVE_TRACE_DISABLED;
  tables.receipt_forms = [{ id: A, chat_id: '972500000001', status: 'open' }];
  tables.scanner_events = [];
  insertError = null;
});
afterEach(() => {
  if (saved.s === undefined) delete process.env.ADMIN_LINK_SECRET;
  else process.env.ADMIN_LINK_SECRET = saved.s;
  if (saved.k === undefined) delete process.env.RECEIVE_TRACE_DISABLED;
  else process.env.RECEIVE_TRACE_DISABLED = saved.k;
});

describe('POST /api/receipt-form/{id}/events', () => {
  it('stores known receive events under the form, its chat, and the load id', async () => {
    const res = await post({
      exp: EXP, sig: SIG, load_id: 'load-1',
      events: [ev('receive_field_change', { seq: 4 }), ev('receive_load', { kind: 'lifecycle', seq: 0 })],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, enabled: true });
    expect(tables.scanner_events).toHaveLength(2);
    expect(tables.scanner_events[0]).toMatchObject({
      page: 'receive', token: A, chat_id: '972500000001', load_id: 'load-1', seq: 4, kind: 'ui',
      event: 'receive_field_change', data: { line: 2 },
    });
  });

  it('drops unknown event names, kinds and malformed rows', async () => {
    const res = await post({
      exp: EXP, sig: SIG, load_id: 'load-1',
      events: [ev('scan_accepted'), ev('receive_tab', { kind: 'server' }), ev('receive_tab', { ts: 'x' }), null, ev('receive_tab')],
    });
    expect(await res.json()).toEqual({ accepted: 1, enabled: true });
    expect(tables.scanner_events.map((r) => r.event)).toEqual(['receive_tab']);
  });

  it('a bad link is 401 and stores nothing', async () => {
    const res = await post({ exp: EXP, sig: 'deadbeef', load_id: 'l', events: [ev('receive_tab')] });
    expect(res.status).toBe(401);
    expect(tables.scanner_events).toHaveLength(0);
  });

  it('an unknown form is 404; an empty batch / bad JSON is 400', async () => {
    const B = '66666666-7777-8888-9999-000000000000';
    const sigB = signReceiptFormLink(B, EXP, SECRET);
    expect((await post({ exp: EXP, sig: sigB, load_id: 'l', events: [ev('receive_tab')] }, B)).status).toBe(404);
    expect((await post({ exp: EXP, sig: SIG, load_id: 'l', events: [] })).status).toBe(400);
    expect((await post('{nope')).status).toBe(400);
  });

  it('RECEIVE_TRACE_DISABLED answers enabled:false and stores nothing', async () => {
    process.env.RECEIVE_TRACE_DISABLED = '1';
    const res = await post({ exp: EXP, sig: SIG, load_id: 'l', events: [ev('receive_tab')] });
    expect(await res.json()).toEqual({ accepted: 0, enabled: false });
    expect(tables.scanner_events).toHaveLength(0);
  });

  it('an insert failure is a 500 (the page retries)', async () => {
    insertError = 'boom';
    const res = await post({ exp: EXP, sig: SIG, load_id: 'l', events: [ev('receive_tab')] });
    expect(res.status).toBe(500);
  });

  it('a phone clock days off is stored at the server time', async () => {
    await post({ exp: EXP, sig: SIG, load_id: 'l', events: [ev('receive_tab', { ts: Date.now() - 30 * 24 * 3600_000 })] });
    const ts = Date.parse(String(tables.scanner_events[0].ts));
    expect(Math.abs(ts - Date.now())).toBeLessThan(5_000);
  });
});
