import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signReceiptFormLink } from './receipt-form-link';

/**
 * GET + POST /api/receipt-form/{id} against an in-memory receipt_forms table
 * (two-page notes, 20/10): the poll's answer, `lines_changed` before
 * validation, the claim filtered by header.rev, the closed-reason / newer
 * link, and the scanner_events rows. Nothing here reaches a database or the bot.
 */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { receipt_forms: [], scanner_events: [] };

/** `header->>rev` / plain columns. */
function col(row: Row, path: string): unknown {
  const m = /^(\w+)->>?(\w+)$/.exec(path);
  if (!m) return row[path];
  const o = row[m[1]] as Record<string, unknown> | null;
  const v = o && typeof o === 'object' ? o[m[2]] : undefined;
  if (v === undefined || v === null) return null;
  return path.includes('->>') ? String(v) : v;
}

function fakeFrom(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let single = false;
  let limit = Infinity;
  let order: { key: string; asc: boolean } | null = null;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => (filters.push((r) => col(r, k) === v), chain);
  chain.neq = (k: string, v: unknown) => (filters.push((r) => col(r, k) !== v), chain);
  chain.gt = (k: string, v: string) => (filters.push((r) => String(col(r, k)) > v), chain);
  chain.is = (k: string, v: null) => (filters.push((r) => col(r, k) === v), chain);
  chain.order = (key: string, o: { ascending: boolean }) => ((order = { key, asc: o.ascending }), chain);
  chain.limit = (n: number) => ((limit = n), chain);
  chain.maybeSingle = () => ((single = true), chain);
  chain.update = (p: Row) => ((patch = p), chain);
  chain.insert = (row: Row) => {
    tables[table].push(row);
    return Promise.resolve({ error: null });
  };
  chain.then = (resolve: (v: unknown) => unknown) => {
    let rows = tables[table].filter((r) => filters.every((f) => f(r)));
    if (patch) for (const r of rows) Object.assign(r, patch);
    if (order) {
      const { key, asc } = order;
      rows = [...rows].sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : 1) * (asc ? 1 : -1));
    }
    rows = rows.slice(0, limit).map((r) => ({ ...r }));
    return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => fakeFrom(t) } }));

const { GET, POST } = await import('@/app/api/receipt-form/[id]/route');

const SECRET = 'test-secret';
const A = '11111111-2222-3333-4444-555555555555';
const B = '66666666-7777-8888-9999-000000000000';
const DELIVERY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXP = String(Math.floor(Date.now() / 1000) + 3600);
const SIG = signReceiptFormLink(A, EXP, SECRET);
const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const line = (index: number, extra: Row = {}) => ({
  index, code: `C${index}`, name_he: `פריט ${index}`, name_en: '', qty: 2, unit: 'units', unit_label: "יח'",
  weighed: false, cartons: 2, packaging: 'carton', needs_expiry: false, ...extra,
});
const ans = (index: number) => ({
  index, received_qty: 2, cartons: 2, packaging: 'carton', expiry_date: null, no_expiry: false, gap: null, gap_note: null,
});

function form(over: Row = {}): Row {
  return {
    id: A, delivery_id: DELIVERY, chat_id: '972500000001', status: 'open', language: 'Hebrew',
    header: { supplier: 'בני דרום', invoice_number: '2607073', line_count: 2, rev: 1 },
    lines: [line(1), line(2)], result: null, expires_at: later(48), created_at: '2026-10-20T07:15:00Z',
    ...over,
  };
}

const params = (id = A) => ({ params: Promise.resolve({ id }) });
const get = (q: string, id = A) => GET(new NextRequest(`http://scanner.test/api/receipt-form/${id}?${q}`), params(id));
const post = (body: Row, id = A) =>
  POST(
    new NextRequest(`http://scanner.test/api/receipt-form/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id),
  );

let savedSecret: string | undefined;
let savedBot: string | undefined;
const fetchMock = vi.fn();
beforeEach(() => {
  savedSecret = process.env.ADMIN_LINK_SECRET;
  savedBot = process.env.TELEGRAM_BOT_WEBHOOK_URL;
  process.env.ADMIN_LINK_SECRET = SECRET;
  process.env.TELEGRAM_BOT_WEBHOOK_URL = 'http://bot.test';
  tables.receipt_forms = [];
  tables.scanner_events = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 'done', saved_lines: 2 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedSecret === undefined) delete process.env.ADMIN_LINK_SECRET;
  else process.env.ADMIN_LINK_SECRET = savedSecret;
  if (savedBot === undefined) delete process.env.TELEGRAM_BOT_WEBHOOK_URL;
  else process.env.TELEGRAM_BOT_WEBHOOK_URL = savedBot;
});

describe('GET /api/receipt-form/{id} (the poll)', () => {
  it('refuses a bad link', async () => {
    tables.receipt_forms.push(form());
    expect((await get(`exp=${EXP}&sig=${'0'.repeat(64)}`)).status).toBe(401);
  });

  it('returns status, rev and lines; an unchanged poll writes no event', async () => {
    tables.receipt_forms.push(form());
    const res = await get(`exp=${EXP}&sig=${SIG}&rev=1`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, status: 'open', rev: 1, line_count: 2, closed_reason: null, newer: null, expired: false });
    expect(j.lines).toHaveLength(2);
    expect(j.lines[0]).toMatchObject({ per_pack: null, inner: null });
    expect(tables.scanner_events).toHaveLength(0);
  });

  it('a form without rev is rev 1; a grown form is logged once per poll that sees it', async () => {
    tables.receipt_forms.push(form({ header: { line_count: 3, rev: 2 }, lines: [line(1), line(2), line(3)] }));
    const j = await (await get(`exp=${EXP}&sig=${SIG}&rev=1`)).json();
    expect(j).toMatchObject({ rev: 2, line_count: 3 });
    expect(tables.scanner_events).toHaveLength(1);
    expect(tables.scanner_events[0]).toMatchObject({ page: 'receive', token: A, chat_id: '972500000001', event: 'receive_poll_changed' });

    tables.receipt_forms[0].header = {};
    expect((await (await get(`exp=${EXP}&sig=${SIG}`)).json()).rev).toBe(1);
  });

  it('a replaced form links to its open successor (same delivery + chat), signed', async () => {
    tables.receipt_forms.push(form({ status: 'closed', result: { closed_reason: 'replaced', by: B } }));
    tables.receipt_forms.push(form({ id: B, created_at: '2026-10-20T07:20:00Z' }));
    const j = await (await get(`exp=${EXP}&sig=${SIG}&rev=1`)).json();
    expect(j.closed_reason).toBe('replaced');
    expect(j.newer.id).toBe(B);
    const u = new URL(j.newer.href, 'http://scanner.test');
    expect(u.pathname).toBe(`/receive/${B}`);
    expect(u.searchParams.get('sig')).toBe(signReceiptFormLink(B, u.searchParams.get('exp')!, SECRET));
  });

  it('no newer link for another chat, or a successor that is not open', async () => {
    tables.receipt_forms.push(form({ status: 'closed', result: { closed_reason: 'replaced', by: B } }));
    tables.receipt_forms.push(form({ id: B, chat_id: '972599999999' }));
    expect((await (await get(`exp=${EXP}&sig=${SIG}`)).json()).newer).toBeNull();
    tables.receipt_forms[1].chat_id = '972500000001';
    tables.receipt_forms[1].status = 'done';
    expect((await (await get(`exp=${EXP}&sig=${SIG}`)).json()).newer).toBeNull();
  });

  it('without result.by, the newest open form of the same delivery stands in', async () => {
    tables.receipt_forms.push(form({ status: 'closed', result: { closed_reason: 'replaced' } }));
    tables.receipt_forms.push(form({ id: B, created_at: '2026-10-20T07:20:00Z' }));
    expect((await (await get(`exp=${EXP}&sig=${SIG}`)).json()).newer.id).toBe(B);
  });

  it('cancelled: the reason, no link', async () => {
    tables.receipt_forms.push(form({ status: 'closed', result: { closed_reason: 'cancelled' } }));
    expect(await (await get(`exp=${EXP}&sig=${SIG}`)).json()).toMatchObject({ status: 'closed', closed_reason: 'cancelled', newer: null });
  });
});

describe('POST /api/receipt-form/{id} with rev', () => {
  it('a page added since the page loaded → 409 lines_changed with the lines, before validation', async () => {
    tables.receipt_forms.push(form({ header: { rev: 2, line_count: 3 }, lines: [line(1), line(2), line(3)] }));
    // answers for 2 lines only — would be a 422 lines_mismatch without the rev check
    const res = await post({ exp: EXP, sig: SIG, rev: 1, answers: { pallets: null, lines: [ans(1), ans(2)], extras: [] } });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j).toMatchObject({ error: 'lines_changed', rev: 2, line_count: 3 });
    expect(j.lines).toHaveLength(3);
    expect(tables.receipt_forms[0].status).toBe('open');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tables.scanner_events.map((e) => (e.data as Row).outcome)).toEqual(['lines_changed']);
  });

  it('same rev → claimed (filtered on header.rev) and booked', async () => {
    tables.receipt_forms.push(form());
    const res = await post({ exp: EXP, sig: SIG, rev: 1, answers: { pallets: null, lines: [ans(1), ans(2)], extras: [] } });
    expect(res.status).toBe(200);
    expect(tables.receipt_forms[0].status).toBe('submitted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tables.scanner_events.map((e) => (e.data as Row).outcome)).toEqual(['claimed', 'done']);
  });

  it('a form with no rev in its header (bot before 20/10) still claims; a page without rev (old page) too', async () => {
    tables.receipt_forms.push(form({ header: { line_count: 2 } }));
    const res = await post({ exp: EXP, sig: SIG, answers: { pallets: null, lines: [ans(1), ans(2)], extras: [] } });
    expect(res.status).toBe(200);
    expect(tables.receipt_forms[0].status).toBe('submitted');
  });

  it('a closed form → 409 not_open with the reason', async () => {
    tables.receipt_forms.push(form({ status: 'closed', result: { closed_reason: 'reset' } }));
    const res = await post({ exp: EXP, sig: SIG, rev: 1, answers: { pallets: null, lines: [ans(1), ans(2)], extras: [] } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_open', status: 'closed', closed_reason: 'reset', newer: null });
  });
});

describe('review 20/10', () => {
  it('a bot refusal that closed the form (form_replaced) carries the reason and the newer link', async () => {
    tables.receipt_forms.push(form());
    tables.receipt_forms.push(form({ id: B, created_at: '2026-10-20T07:20:00Z' }));
    // The bot claims the row, finds a newer link in the chat, and closes this one.
    fetchMock.mockImplementation(async () => {
      Object.assign(tables.receipt_forms[0], {
        status: 'closed',
        result: { ok: false, error: 'form_replaced', final: 'closed', closed_reason: 'replaced', by: B },
      });
      return new Response(
        JSON.stringify({ ok: false, error: 'form_replaced', final: 'closed', closed_reason: 'replaced', by: B, message: 'x', status: 'closed' }),
        { status: 409 },
      );
    });
    const res = await post({ exp: EXP, sig: SIG, rev: 1, answers: { pallets: null, lines: [ans(1), ans(2)], extras: [] } });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j).toMatchObject({ error: 'form_replaced', status: 'closed', closed_reason: 'replaced' });
    expect(j.newer.id).toBe(B);
  });

  it('a bot refusal that leaves the form open has no closed_reason', async () => {
    tables.receipt_forms.push(form());
    fetchMock.mockImplementation(async () => {
      tables.receipt_forms[0].status = 'open';
      return new Response(JSON.stringify({ ok: false, error: 'page_pending', message: 'm', status: 'open' }), { status: 500 });
    });
    const j = await (await post({ exp: EXP, sig: SIG, rev: 1, answers: { pallets: null, lines: [ans(1), ans(2)], extras: [] } })).json();
    expect(j).toMatchObject({ error: 'page_pending', message: 'm', status: 'open' });
    expect(j.closed_reason).toBeUndefined();
  });

  it('replacedFormIds: the closed forms that name this one as `by`, same chat only', async () => {
    const { replacedFormIds } = await import('./receipt-form-server');
    const C = 'cccccccc-2222-3333-4444-555555555555';
    tables.receipt_forms.push(form({ status: 'closed', result: { closed_reason: 'replaced', by: B } }));
    tables.receipt_forms.push(form({ id: C, status: 'closed', chat_id: '972599999999', result: { closed_reason: 'replaced', by: B } }));
    tables.receipt_forms.push(form({ id: B, created_at: '2026-10-20T07:20:00Z' }));
    const row = { ...tables.receipt_forms[2] } as unknown as Parameters<typeof replacedFormIds>[0];
    expect(await replacedFormIds(row)).toEqual([A]);
  });
});
