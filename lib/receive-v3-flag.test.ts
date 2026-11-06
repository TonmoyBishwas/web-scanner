import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signReceiptFormLink } from './receipt-form-link';
import { normalizeFormHeader, normalizeFormLines } from './receipt-form';

/**
 * The receive form v3 flag (06/11): public.scanner_flags 'receive_form_v3'
 * for the form's chat AND the delivery's supplier VAT in
 * RECEIVE_FORM_V3_SUPPLIER_VATS (default Bnei Darom 570052894). Off on any
 * doubt. GET /api/receipt-form/{id} adds `features.receive_form_v3` only
 * when on — off, its answer is byte for byte today's. POST checks v3 bodies
 * with validateV3. Against in-memory tables; nothing reaches a database.
 */
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  receipt_forms: [],
  scanner_events: [],
  deliveries: [],
  scanner_flags: [
    { flag: 'receive_redesign', enabled_all: false, chat_ids: ['999000000001'] },
    { flag: 'receive_form_v3', enabled_all: false, chat_ids: ['999000000002', '999000000003'] },
  ],
};
/** Tables whose reads fail (a DB error). */
const failing = new Set<string>();
/** Every table read, in order. */
const reads: string[] = [];

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
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => (filters.push((r) => col(r, k) === v), chain);
  chain.neq = (k: string, v: unknown) => (filters.push((r) => col(r, k) !== v), chain);
  chain.gt = (k: string, v: string) => (filters.push((r) => String(col(r, k)) > v), chain);
  chain.is = (k: string, v: null) => (filters.push((r) => col(r, k) === v), chain);
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = () => ((single = true), chain);
  chain.update = (p: Row) => ((patch = p), chain);
  chain.insert = (row: Row) => {
    tables[table].push(row);
    return Promise.resolve({ error: null });
  };
  chain.then = (resolve: (v: unknown) => unknown) => {
    if (!patch) reads.push(table);
    if (failing.has(table)) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
    const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (patch) for (const r of rows) Object.assign(r, patch);
    const out = rows.map((r) => ({ ...r }));
    return Promise.resolve({ data: single ? out[0] ?? null : out, error: null }).then(resolve);
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => fakeFrom(t) } }));

const flags = await import('./scanner-flags');
const { GET, POST } = await import('@/app/api/receipt-form/[id]/route');

// ── parseV3SupplierVats / receiveFormV3Gate (pure, injected reads) ────────

describe('parseV3SupplierVats', () => {
  it('unset or empty → Bnei Darom', () => {
    expect(flags.parseV3SupplierVats(undefined)).toEqual(['570052894']);
    expect(flags.parseV3SupplierVats('')).toEqual(['570052894']);
    expect(flags.parseV3SupplierVats(' , ')).toEqual(['570052894']);
  });
  it('a comma list, trimmed, empty entries dropped', () => {
    expect(flags.parseV3SupplierVats(' 1 , ,2,')).toEqual(['1', '2']);
  });
  it("'all' in any case = any supplier", () => {
    expect(flags.parseV3SupplierVats('all')).toBe('all');
    expect(flags.parseV3SupplierVats(' ALL ')).toBe('all');
  });
});

describe('receiveFormV3Gate', () => {
  const on = { enabled_all: false, chat_ids: ['42'] };
  const gate = (
    row: Row | null | (() => Promise<Row | null>),
    vat: string | null | (() => Promise<string | null>),
    vats: readonly string[] | 'all' = ['570052894'],
  ) => {
    const lookup = vi.fn(typeof vat === 'function' ? vat : async () => vat);
    const g = flags.receiveFormV3Gate(
      typeof row === 'function' ? row : async () => row,
      lookup,
      () => vats,
    );
    return { g, lookup };
  };

  it('chat listed + VAT listed → on', async () => {
    expect(await gate(on, '570052894').g('42', 'd1')).toBe(true);
  });
  it('enabled_all + VAT listed → on for any chat', async () => {
    expect(await gate({ enabled_all: true, chat_ids: [] }, '570052894').g('7', 'd1')).toBe(true);
  });
  it('missing row → off, and the VAT is not even read', async () => {
    const { g, lookup } = gate(null, '570052894');
    expect(await g('42', 'd1')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('a row that cannot be read (throws) → off', async () => {
    expect(await gate(async () => { throw new Error('db'); }, '570052894').g('42', 'd1')).toBe(false);
  });
  it('chat not listed → off', async () => {
    expect(await gate(on, '570052894').g('43', 'd1')).toBe(false);
  });
  it('VAT not listed, null VAT, no delivery, failed lookup → off', async () => {
    expect(await gate(on, '511111111').g('42', 'd1')).toBe(false);
    expect(await gate(on, null).g('42', 'd1')).toBe(false);
    expect(await gate(on, '570052894').g('42', null)).toBe(false);
    expect(await gate(on, async () => { throw new Error('db'); }).g('42', 'd1')).toBe(false);
  });
  it("'all' → on whatever the supplier, without reading it (a null VAT, no delivery)", async () => {
    const { g, lookup } = gate(on, null, 'all');
    expect(await g('42', null)).toBe(true);
    expect(await g('42', 'd1')).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(await gate(on, null, 'all').g('43', 'd1')).toBe(false);
  });
  it('a found VAT is cached per delivery; a null one is asked again', async () => {
    const found = gate(on, '570052894');
    await found.g('42', 'd1');
    await found.g('42', 'd1');
    expect(found.lookup).toHaveBeenCalledTimes(1);
    const missing = gate(on, null);
    await missing.g('42', 'd1');
    await missing.g('42', 'd1');
    expect(missing.lookup).toHaveBeenCalledTimes(2);
  });
});

// ── receiveFormV3On + the routes, against the in-memory tables ───────────

const SECRET = 'test-secret';
const A = '11111111-2222-3333-4444-555555555555';
const EXP = String(Math.floor(Date.now() / 1000) + 3600);
const SIG = signReceiptFormLink(A, EXP, SECRET);
const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const line = (index: number, extra: Row = {}) => ({
  index, code: `C${index}`, name_he: `פריט ${index}`, name_en: '', qty: 2, unit: 'units', unit_label: "יח'",
  weighed: false, cartons: 2, packaging: 'carton', needs_expiry: false, ...extra,
});
function form(over: Row = {}): Row {
  return {
    id: A, delivery_id: 'dlv-bnei-darom', chat_id: '972500000001', status: 'open', language: 'Hebrew',
    header: { supplier: 'בני דרום', invoice_number: '88010195', line_count: 2, rev: 1 },
    lines: [line(1), line(2)], result: null, expires_at: later(48), created_at: '2026-11-06T07:15:00Z',
    ...over,
  };
}
const params = (id = A) => ({ params: Promise.resolve({ id }) });
const get = () => GET(new NextRequest(`http://scanner.test/api/receipt-form/${A}?exp=${EXP}&sig=${SIG}&rev=1`), params());
const post = (body: Row) =>
  POST(
    new NextRequest(`http://scanner.test/api/receipt-form/${A}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(),
  );

const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();
beforeEach(() => {
  for (const k of ['ADMIN_LINK_SECRET', 'TELEGRAM_BOT_WEBHOOK_URL', 'RECEIVE_FORM_V3_SUPPLIER_VATS']) saved[k] = process.env[k];
  process.env.ADMIN_LINK_SECRET = SECRET;
  process.env.TELEGRAM_BOT_WEBHOOK_URL = 'http://bot.test';
  delete process.env.RECEIVE_FORM_V3_SUPPLIER_VATS;
  tables.receipt_forms = [];
  tables.scanner_events = [];
  tables.deliveries = [
    { id: 'dlv-bnei-darom', supplier_vat: '570052894' },
    { id: 'dlv-other', supplier_vat: '511111111' },
    { id: 'dlv-no-vat', supplier_vat: null },
  ];
  failing.clear();
  reads.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 'done', saved_lines: 2 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('receiveFormV3On (scanner_flags + deliveries.supplier_vat)', () => {
  it('a listed harness chat on a Bnei Darom delivery → on; env unset = Bnei Darom', async () => {
    expect(await flags.receiveFormV3On('999000000002', 'dlv-bnei-darom')).toBe(true);
  });
  it('another supplier, a null VAT, a missing delivery → off', async () => {
    expect(await flags.receiveFormV3On('999000000002', 'dlv-other')).toBe(false);
    expect(await flags.receiveFormV3On('999000000002', 'dlv-no-vat')).toBe(false);
    expect(await flags.receiveFormV3On('999000000002', 'dlv-missing')).toBe(false);
    expect(await flags.receiveFormV3On('999000000002', null)).toBe(false);
  });
  it('a chat not on the row → off', async () => {
    expect(await flags.receiveFormV3On('972500000001', 'dlv-bnei-darom')).toBe(false);
  });
  it('RECEIVE_FORM_V3_SUPPLIER_VATS lists the other supplier / all', async () => {
    process.env.RECEIVE_FORM_V3_SUPPLIER_VATS = '511111111, 570052894';
    expect(await flags.receiveFormV3On('999000000002', 'dlv-other')).toBe(true);
    process.env.RECEIVE_FORM_V3_SUPPLIER_VATS = 'all';
    expect(await flags.receiveFormV3On('999000000002', 'dlv-no-vat')).toBe(true);
    process.env.RECEIVE_FORM_V3_SUPPLIER_VATS = '511111111';
    expect(await flags.receiveFormV3On('999000000002', 'dlv-bnei-darom')).toBe(false);
  });
  it('a failed deliveries read → off', async () => {
    failing.add('deliveries');
    expect(await flags.receiveFormV3On('999000000002', 'dlv-no-vat')).toBe(false);
  });
});

describe('GET /api/receipt-form/{id}: features.receive_form_v3', () => {
  it('flag off: the answer is byte for byte today\'s (no receive_form_v3 key), and no delivery read', async () => {
    tables.receipt_forms.push(form());
    const res = await get();
    const text = await res.text();
    const row = tables.receipt_forms[0];
    const lines = normalizeFormLines(row.lines);
    const today = {
      ok: true,
      status: 'open',
      rev: 1,
      line_count: 2,
      lines,
      header: normalizeFormHeader(row.header, lines.length),
      closed_reason: null,
      newer: null,
      expired: false,
      features: { receive_redesign: false },
    };
    expect(text).toBe(JSON.stringify(today));
    expect(reads).not.toContain('deliveries');
  });

  it('flag on for the chat but another supplier: no key', async () => {
    tables.receipt_forms.push(form({ chat_id: '999000000002', delivery_id: 'dlv-other' }));
    const j = await (await get()).json();
    expect(j.features).toEqual({ receive_redesign: false });
  });

  it('flag on for the chat and Bnei Darom: receive_form_v3 true (the redesign key unchanged)', async () => {
    tables.receipt_forms.push(form({ chat_id: '999000000002' }));
    const j = await (await get()).json();
    expect(j.features).toEqual({ receive_redesign: false, receive_form_v3: true });
  });

  it('an English-language form keeps today\'s answer (the v3 English is not reviewed), without reading the flag row', async () => {
    tables.receipt_forms.push(form({ chat_id: '999000000002', language: 'English' }));
    const j = await (await get()).json();
    expect(j.features).toEqual({ receive_redesign: false });
    expect(await flags.receiveFormV3OnForm({ chat_id: '999000000002', delivery_id: 'dlv-bnei-darom', language: 'English' })).toBe(false);
    expect(await flags.receiveFormV3OnForm({ chat_id: '999000000002', delivery_id: 'dlv-bnei-darom', language: 'Hebrew' })).toBe(true);
  });

  it('a flag row that cannot be read (DB error) is off', async () => {
    // The real row is cached 30 s per instance, so a fresh reader stands in for the failed read.
    const fresh = flags.receiveFormV3Gate(
      flags.cachedFlagRow(async () => {
        throw new Error('boom');
      }),
      async () => '570052894',
      () => ['570052894'],
    );
    expect(await fresh('999000000003', 'dlv-bnei-darom')).toBe(false);
  });
});

describe('POST /api/receipt-form/{id}: v3 bodies', () => {
  const ans = (index: number, extra: Row = {}) => ({
    index, received_qty: 2, cartons: 2, packaging: 'carton', expiry_date: null, no_expiry: false, gap: null, gap_note: null, ...extra,
  });

  it("today's body is untouched (no v3 check, no v3_errors), even with the flag on", async () => {
    tables.receipt_forms.push(form({ chat_id: '999000000002' }));
    const res = await post({ exp: EXP, sig: SIG, rev: 1, answers: { pallets: 51, lines: [ans(1), ans(2)], extras: [] } });
    expect(res.status).toBe(200); // 51 is within today's limit (999); the bot itself refuses > 50
    expect(tables.receipt_forms[0].answers).toEqual({ pallets: 51, lines: [ans(1), ans(2)], extras: [] });
  });

  it('a v3 body that breaks a v3 rule → 422 with v3_errors; nothing claimed, the bot not called', async () => {
    tables.receipt_forms.push(form());
    const res = await post({
      exp: EXP, sig: SIG, rev: 1,
      answers: { pallets: 51, lines: [ans(1, { pallet: 1 }), ans(2, { pallet: null })], extras: [], form_version: 3, loose_lines: 0 },
    });
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.error).toBe('invalid');
    expect(j.errors.ok).toBe(true);
    expect(j.v3_errors).toEqual({ ok: false, lines: { 2: ['pallet_missing'] }, form: ['pallets_range'] });
    expect(tables.receipt_forms[0].status).toBe('open');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tables.scanner_events.at(-1)).toMatchObject({ event: 'receive_submit' });
    expect((tables.scanner_events.at(-1)!.data as Row).outcome).toBe('invalid');
  });

  it('a legacy-invalid v3 body → 422 with both errors and v3_errors', async () => {
    tables.receipt_forms.push(form());
    const res = await post({
      exp: EXP, sig: SIG, rev: 1,
      answers: { pallets: 1, lines: [ans(1, { pallet: 1, received_qty: 1 }), ans(2, { pallet: 1 })], extras: [], form_version: 3, loose_lines: 0 },
    });
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.errors.lines).toEqual({ 1: ['gap_missing'] });
    expect(j.v3_errors.ok).toBe(true);
  });

  it('a good v3 body is claimed and stored with its v3 keys (the bot reads only the legacy ones)', async () => {
    tables.receipt_forms.push(form());
    const answers = {
      pallets: 2,
      lines: [
        ans(1, { pallet: 2, expiry_date: '2027-05-12', split_unit: 'packages', splits: [{ qty: 1, expiry_date: '2027-06-20' }, { qty: 1, expiry_date: '2027-05-12' }] }),
        ans(2, { pallet: null, loose_qty: 1 }),
      ],
      extras: [],
      form_version: 3,
      loose_lines: 1,
    };
    const res = await post({ exp: EXP, sig: SIG, rev: 1, answers });
    expect(res.status).toBe(200);
    expect(tables.receipt_forms[0].status).toBe('submitted');
    expect(tables.receipt_forms[0].answers).toEqual(answers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a v3 body with a wrong type → 400 bad_answers', async () => {
    tables.receipt_forms.push(form());
    const res = await post({
      exp: EXP, sig: SIG, rev: 1,
      answers: { pallets: 1, lines: [ans(1, { pallet: 'one' }), ans(2)], extras: [], form_version: 3 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_answers');
  });
});
