import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signReceiptFormLink } from './receipt-form-link';
import type { PriorityState, PriorityStatus } from './priority-status';
import { erpOf, unmappedCodes, v3Outcome, V3_STATUS_TIMEOUT_MS, type V3OutcomeInput } from './receive-v3-status';
import { readPollAnswer, readStatusAnswer, readSubmitAnswer } from './receive-v3-client';

/**
 * The receive form v3 status screen (flag receive_form_v3): the outcome
 * mapping (spec 10.4), the server reads behind GET
 * /api/receipt-form/{id}/status and the boot data (note photos, ERP, bot
 * number), and the page's readers of the API's answers. In-memory tables;
 * nothing reaches a database.
 */

// ── v3Outcome (pure) ──────────────────────────────────────────────────────

const NOW = new Date('2026-11-06T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const input = (over: Partial<V3OutcomeInput>): V3OutcomeInput => ({
  erp: 'priority', formStatus: 'done', priority: null, outbox: null, submittedAt: ago(10_000), now: NOW, ...over,
});
const st = (state: PriorityState, extra: Partial<PriorityStatus> = {}): PriorityStatus => ({ state, ...extra });

describe('v3Outcome (spec 10.4)', () => {
  it('no ERP and the form done → success, no Priority needed', () => {
    expect(v3Outcome(input({ erp: 'none' }))).toEqual({ outcome: 'success', docno: null, office_lines: null });
  });

  it('form not done → pending; failed → failed', () => {
    for (const s of ['open', 'submitted', 'processing']) expect(v3Outcome(input({ formStatus: s })).outcome).toBe('pending');
    expect(v3Outcome(input({ formStatus: 'submitted', erp: 'none' })).outcome).toBe('pending');
    expect(v3Outcome(input({ formStatus: 'failed' })).outcome).toBe('failed');
  });

  it('received → success with the GR; partial when the outbox lists unmapped codes', () => {
    expect(v3Outcome(input({ priority: st('received', { docno: 'GR26000181' }) }))).toEqual({
      outcome: 'success', docno: 'GR26000181', office_lines: null,
    });
    expect(
      v3Outcome(input({ priority: st('received', { docno: 'GR26000181' }), outbox: { unmapped_codes: ['92031', '92032', '', 7] } })),
    ).toEqual({ outcome: 'partial', docno: 'GR26000181', office_lines: 2 });
    expect(v3Outcome(input({ priority: st('received', { docno: 'GR1' }), outbox: { unmapped_codes: [] } })).outcome).toBe('success');
  });

  it('already → success (docno when known)', () => {
    expect(v3Outcome(input({ priority: st('already') }))).toEqual({ outcome: 'success', docno: null, office_lines: null });
  });

  it.each(['failed', 'expired', 'cancelled'] as PriorityState[])('%s → failed (no docno)', (s) => {
    expect(v3Outcome(input({ priority: st(s, { docno: 'GR9' }) }))).toEqual({ outcome: 'failed', docno: null, office_lines: null });
  });

  it.each(['held', 'test', 'off', 'unconfirmed', 'noWriteback'] as PriorityState[])('%s → timeout', (s) => {
    expect(v3Outcome(input({ priority: st(s) })).outcome).toBe('timeout');
  });

  it.each(['checking', 'closing', 'waitingPo', 'waiting', 'sending', 'awaiting', 'unknown'] as PriorityState[])(
    '%s → pending, timeout after 150 s from the save',
    (s) => {
      expect(v3Outcome(input({ priority: st(s), submittedAt: ago(V3_STATUS_TIMEOUT_MS - 1000) })).outcome).toBe('pending');
      expect(v3Outcome(input({ priority: st(s), submittedAt: ago(V3_STATUS_TIMEOUT_MS + 1000) })).outcome).toBe('timeout');
      expect(v3Outcome(input({ priority: st(s), submittedAt: null })).outcome).toBe('pending');
    },
  );

  it('erpOf / unmappedCodes', () => {
    expect(erpOf('priority')).toBe('priority');
    expect(erpOf('Priority')).toBe('priority');
    expect(erpOf('sap')).toBe('priority');
    expect(erpOf(null)).toBe('none');
    expect(erpOf('')).toBe('none');
    expect(erpOf(' NONE ')).toBe('none');
    expect(unmappedCodes(null)).toEqual([]);
    expect(unmappedCodes({ unmapped_codes: 'x' })).toEqual([]);
  });
});

// ── The page's readers of the API (pure) ─────────────────────────────────

describe('readSubmitAnswer (spec 8.1)', () => {
  it('saved', () => {
    expect(readSubmitAnswer(200, { ok: true, status: 'done', saved_lines: 18 })).toEqual({ kind: 'saved', http: 200, error: null });
  });
  it('lines_changed with the new lines', () => {
    const r = readSubmitAnswer(409, { ok: false, error: 'lines_changed', rev: 2, lines: [{ index: 1, code: 'c', name_he: 'x', qty: 1 }] });
    expect(r).toMatchObject({ kind: 'lines_changed', rev: 2, http: 409, error: 'lines_changed' });
    expect(r.kind === 'lines_changed' && r.lines[0]).toMatchObject({ index: 1, code: 'c', qty: 1 });
  });
  it('not_open (closed / done) with the reason and the newer link', () => {
    expect(
      readSubmitAnswer(409, { ok: false, error: 'not_open', status: 'closed', closed_reason: 'replaced', newer: { id: 'b', href: '/receive/b?exp=1&sig=2' } }),
    ).toMatchObject({ kind: 'not_open', status: 'closed', closed_reason: 'replaced', newer: { id: 'b', href: '/receive/b?exp=1&sig=2' } });
    expect(readSubmitAnswer(409, { ok: false, error: 'not_open', status: 'done' })).toMatchObject({ kind: 'not_open', status: 'done', newer: null });
    // A newer link that is not ours is dropped.
    expect(readSubmitAnswer(409, { error: 'not_open', status: 'closed', newer: { id: 'b', href: 'https://evil.test/' } })).toMatchObject({ newer: null });
    // The bot closed it on this tap (form_replaced).
    expect(readSubmitAnswer(409, { ok: false, error: 'form_replaced', status: 'closed', closed_reason: 'replaced' })).toMatchObject({ kind: 'not_open' });
  });
  it('in flight / failed', () => {
    expect(readSubmitAnswer(409, { error: 'not_open', status: 'processing' }).kind).toBe('in_flight');
    expect(readSubmitAnswer(502, { error: 'bot_unreachable', status: 'submitted' }).kind).toBe('in_flight');
    expect(readSubmitAnswer(409, { error: 'not_open', status: 'failed' }).kind).toBe('failed');
  });
  it('link invalid: 401 / 404 / 410', () => {
    expect(readSubmitAnswer(401, { error: 'link_invalid' }).kind).toBe('link_invalid');
    expect(readSubmitAnswer(404, { error: 'not_found' }).kind).toBe('link_invalid');
    expect(readSubmitAnswer(410, { error: 'expired' }).kind).toBe('link_invalid');
  });
  it('errors: invalid, bot, the bot\'s message, generic', () => {
    expect(readSubmitAnswer(422, { error: 'invalid' })).toMatchObject({ kind: 'error', reason: 'invalid', message: null });
    expect(readSubmitAnswer(502, { error: 'bot_unreachable', status: 'open' })).toMatchObject({ kind: 'error', reason: 'bot' });
    expect(readSubmitAnswer(502, { error: 'bot_not_configured' })).toMatchObject({ kind: 'error', reason: 'bot' });
    expect(readSubmitAnswer(500, { error: 'page_pending', message: ' wait ', status: 'open' })).toMatchObject({ kind: 'error', reason: 'generic', message: 'wait' });
    expect(readSubmitAnswer(500, null)).toMatchObject({ kind: 'error', reason: 'generic', message: null, error: null });
  });
});

describe('readPollAnswer / readStatusAnswer', () => {
  it('poll: a good answer, else null', () => {
    expect(readPollAnswer(200, { ok: true, status: 'open', rev: 2, lines: [], closed_reason: null, newer: null })).toEqual({
      status: 'open', rev: 2, lines: [], closed_reason: null, newer: null, v3: null,
    });
    // features.receive_form_v3 is sent only when on: present → true, absent from a features object → false.
    const open = { ok: true, status: 'open', rev: 2, lines: [] };
    expect(readPollAnswer(200, { ...open, features: { receive_redesign: false, receive_form_v3: true } })?.v3).toBe(true);
    expect(readPollAnswer(200, { ...open, features: { receive_redesign: false } })?.v3).toBe(false);
    expect(readPollAnswer(200, { ...open, features: null })?.v3).toBeNull();
    expect(readPollAnswer(401, { ok: false })).toBeNull();
    expect(readPollAnswer(200, { ok: false })).toBeNull();
  });
  it('status: a good answer, else null', () => {
    const good = { ok: true, erp: 'priority', form_status: 'done', outcome: 'partial', docno: 'GR1', office_lines: 3, submitted_at: 'x' };
    expect(readStatusAnswer(200, good)).toEqual(good);
    expect(readStatusAnswer(200, { ...good, outcome: 'weird' })).toBeNull();
    expect(readStatusAnswer(500, good)).toBeNull();
    expect(readStatusAnswer(200, { ...good, office_lines: null, erp: 'none' })).toMatchObject({ office_lines: null, erp: 'none' });
  });
});

// ── The server reads (in-memory tables) ──────────────────────────────────

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const writes: string[] = [];
const rpcCalls: string[] = [];

function fakeFrom(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let single = false;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain);
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = () => ((single = true), chain);
  for (const w of ['update', 'insert', 'upsert', 'delete']) {
    chain[w] = () => {
      writes.push(`${w} ${table}`);
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown) => {
    const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
    return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    rpc: (name: string) => {
      rpcCalls.push(name);
      return Promise.resolve({ data: { decision: 'send' }, error: null });
    },
  },
}));

const server = await import('./receive-v3-server');
const { GET } = await import('@/app/api/receipt-form/[id]/status/route');

const SB = 'https://vkeqzvwnqkuuwurgjjkd.supabase.co';
const PHOTO = `${SB}/storage/v1/object/public/warehouse-images/invoices/a.jpg`;
const A = '11111111-2222-3333-4444-555555555555';
const SECRET = 'test-secret';
const EXP = String(Math.floor(Date.now() / 1000) + 3600);
const SIG = signReceiptFormLink(A, EXP, SECRET);

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['SUPABASE_URL', 'BOT_WA_NUMBER', 'ADMIN_LINK_SECRET']) saved[k] = process.env[k];
  process.env.SUPABASE_URL = SB;
  process.env.ADMIN_LINK_SECRET = SECRET;
  delete process.env.BOT_WA_NUMBER;
  writes.length = 0;
  rpcCalls.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    receipt_forms: [
      {
        id: A, delivery_id: 'd1', chat_id: '999000000002', status: 'done', language: 'Hebrew', header: {}, lines: [],
        result: null, expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: null,
        submitted_at: new Date(Date.now() - 20_000).toISOString(), done_at: null,
      },
    ],
    deliveries: [{ id: 'd1', invoice_image_url: PHOTO, tenant_id: 't1', status: 'Complete', received_by_chat_id: 972500000001 }],
    tenants: [{ id: 't1', erp: 'priority' }],
    invoice_ocr_results: [
      { delivery_id: 'd1', invoice_image_url: PHOTO, created_at: '2026-11-06T07:00:00Z' },
      { delivery_id: 'd1', invoice_image_url: `${SB}/storage/v1/object/public/warehouse-images/invoices/b.jpg`, created_at: '2026-11-06T07:01:00Z' },
      { delivery_id: 'd1', invoice_image_url: 'https://evil.test/c.jpg', created_at: '2026-11-06T07:02:00Z' },
    ],
    users: [{ chat_id: 972500000001, env: 'Prod' }],
    priority_push_outbox: [{ delivery_id: 'd1', status: 'delivered', unmapped_codes: ['92031'] }],
    priority_goods_receipts: [{ delivery_id: 'd1', docno: 'GR26000181', origin: 'priority', statdes: 'טיוטא', synced_at: '2026-11-06T08:00:00Z' }],
    priority_push_config: [{ id: 1, enabled: true, url: 'https://hook.test/secret' }],
    delivery_po_links: [],
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('notePhotoUrls / botWaNumberOf', () => {
  it('own-origin https only, de-duplicated, in order', () => {
    expect(server.notePhotoUrls([PHOTO, null, '', PHOTO, 'http://vkeqzvwnqkuuwurgjjkd.supabase.co/x.jpg', 'https://evil.test/x', 'not a url', `${SB}/b.jpg`], SB)).toEqual([
      PHOTO,
      `${SB}/b.jpg`,
    ]);
    expect(server.notePhotoUrls([PHOTO], undefined)).toEqual([]);
    expect(server.notePhotoUrls([PHOTO], 'junk')).toEqual([]);
  });
  it('the bot number: digits only, empty → null', () => {
    expect(server.botWaNumberOf('+972 50-123-4567')).toBe('972501234567');
    expect(server.botWaNumberOf('')).toBeNull();
    expect(server.botWaNumberOf(undefined)).toBeNull();
  });
});

describe('loadV3Boot (spec 10.5–10.7)', () => {
  it('photos (delivery first, then the OCR pages, own origin only), ERP, bot number, today', async () => {
    process.env.BOT_WA_NUMBER = '+972-50-000-0000';
    const boot = await server.loadV3Boot({ delivery_id: 'd1' });
    expect(boot.notePhotos).toEqual([PHOTO, `${SB}/storage/v1/object/public/warehouse-images/invoices/b.jpg`]);
    expect(boot.erp).toBe('priority');
    expect(boot.botWaNumber).toBe('972500000000');
    expect(boot.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(writes).toEqual([]);
  });
  it('a tenant without ERP → none; a missing delivery / tenant → priority; no photos → []', async () => {
    tables.tenants = [{ id: 't1', erp: null }];
    expect((await server.loadV3Boot({ delivery_id: 'd1' })).erp).toBe('none');
    tables.tenants = [];
    expect((await server.loadV3Boot({ delivery_id: 'd1' })).erp).toBe('priority');
    const none = await server.loadV3Boot({ delivery_id: null });
    expect(none).toMatchObject({ notePhotos: [], erp: 'priority', botWaNumber: null });
  });
});

describe('GET /api/receipt-form/{id}/status', () => {
  const get = (q = `exp=${EXP}&sig=${SIG}`) =>
    GET(new NextRequest(`http://scanner.test/api/receipt-form/${A}/status?${q}`), { params: Promise.resolve({ id: A }) });

  it('a bad link → 401; an unknown form → 404', async () => {
    expect((await get(`exp=${EXP}&sig=${'0'.repeat(64)}`)).status).toBe(401);
    tables.receipt_forms = [];
    expect((await get()).status).toBe(404);
  });

  it('a received GR with an unmapped line → partial, read-only, no-store, the push URL never leaves', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('hook.test');
    const j = JSON.parse(text);
    expect(j).toMatchObject({ ok: true, erp: 'priority', form_status: 'done', outcome: 'partial', docno: 'GR26000181', office_lines: 1 });
    expect(typeof j.submitted_at).toBe('string');
    expect(writes).toEqual([]);
  });

  it('a Test user is never pushed → timeout', async () => {
    tables.users = [{ chat_id: 972500000001, env: 'Test' }];
    tables.priority_goods_receipts = [];
    tables.priority_push_outbox = [{ delivery_id: 'd1', status: 'skipped', response_error: 'skipped: Test user' }];
    expect((await (await get()).json()).outcome).toBe('timeout');
  });

  it('queued on a live push → priority_push_explain is read (read-only) → pending', async () => {
    tables.priority_goods_receipts = [];
    tables.priority_push_outbox = [{ delivery_id: 'd1', status: 'queued', queued_at: new Date().toISOString() }];
    expect((await (await get()).json()).outcome).toBe('pending');
    expect(rpcCalls).toEqual(['priority_push_explain']);
  });

  it('no ERP → success without any Priority read', async () => {
    tables.tenants = [{ id: 't1', erp: 'none' }];
    tables.priority_push_outbox = [];
    const j = await (await get()).json();
    expect(j).toMatchObject({ erp: 'none', outcome: 'success', docno: null });
  });

  it('a form still being saved → pending, Priority not read', async () => {
    tables.receipt_forms[0].status = 'processing';
    expect((await (await get()).json())).toMatchObject({ form_status: 'processing', outcome: 'pending' });
    expect(rpcCalls).toEqual([]);
  });
});
