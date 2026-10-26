import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Units-carton mode against an in-memory Supabase (lib/units-cartons.ts):
 * the session GET's `features.units_mode` from scanner_flags, and the units
 * save of POST /api/carton-labels. Nothing reaches a database.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Make reads of this table fail like a relation that does not exist yet. */
let missingTable: string | null = null;

function fakeFrom(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'insert' | 'update' = 'select';
  let inserted: Row[] = [];
  let single = false;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; };
  chain.gt = (c: string, v: string) => { filters.push((r) => String(r[c]) > v); return chain; };
  chain.lt = (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return chain; };
  chain.update = () => { op = 'update'; return chain; };
  chain.insert = (rows: Row[]) => { op = 'insert'; inserted = rows.map((r, i) => ({ id: `n${(db[table]?.length ?? 0) + i}`, ...r })); return chain; };
  chain.maybeSingle = () => { single = true; return chain; };
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    let result: unknown;
    if (missingTable === table) {
      result = { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
    } else if (op === 'insert') {
      db[table] = [...(db[table] ?? []), ...inserted];
      result = { data: inserted, error: null };
    } else if (op === 'update') {
      result = { data: [], error: null };
    } else {
      const hit = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      result = { data: single ? hit[0] ?? null : hit, error: null };
    }
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => fakeFrom(t) } }));

const sessionRoute = await import('@/app/api/multi-pallet-session/route');
const labelsRoute = await import('@/app/api/carton-labels/route');

const FUTURE = '2999-01-01T00:00:00.000Z';
const req = (path: string, init?: RequestInit) => new NextRequest(`http://scanner.test${path}`, init as never);
const post = (body: Row) => labelsRoute.POST(req('/api/carton-labels', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

let clock = Date.parse('2026-10-27T08:00:00Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Past the flag cache (30 s) between tests.
  clock += 60_000;
  vi.setSystemTime(clock);
  missingTable = null;
  db.scan_sessions = [
    { token: 'tokT', kind: 'multi_pallet', expires_at: FUTURE, data: { token: 'tokT', chat_id: '999000000001', document_number: '008955', ocr_data: [] } },
    { token: 'tokR', kind: 'multi_pallet', expires_at: FUTURE, data: { token: 'tokR', chat_id: '972500000000', document_number: 'IN9', ocr_data: [] } },
  ];
  db.scanner_flags = [{ flag: 'units_mode', enabled_all: false, chat_ids: ['999000000001', '999000000030'] }];
  db.carton_labels = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/multi-pallet-session features.units_mode', () => {
  const get = async (token: string) => (await sessionRoute.GET(req(`/api/multi-pallet-session?token=${token}`))).json();

  it('on for a listed test chat, off for a real one', async () => {
    expect((await get('tokT')).features).toEqual({ units_mode: true });
    expect((await get('tokR')).features).toEqual({ units_mode: false });
  });

  it('enabled_all turns it on for everyone', async () => {
    db.scanner_flags[0].enabled_all = true;
    expect((await get('tokR')).features).toEqual({ units_mode: true });
  });

  it('no row, or no table yet: off, and the session still loads', async () => {
    db.scanner_flags = [];
    const a = await get('tokT');
    expect(a.features).toEqual({ units_mode: false });
    expect(a.document_number).toBe('008955');
    vi.setSystemTime(clock += 60_000);
    missingTable = 'scanner_flags';
    const b = await get('tokT');
    expect(b.features).toEqual({ units_mode: false });
    expect(b.document_number).toBe('008955');
  });

  it('is never stored on the session', async () => {
    await get('tokT');
    expect(db.scan_sessions[0].data).not.toHaveProperty('features');
  });
});

describe('POST /api/carton-labels — a units save', () => {
  const units = {
    token: 'tokT', origin: 'new_carton', pallet_number: 0, item_code: 'KK117', item_name_hebrew: 'מנה',
    item_name_english: 'Meal', weight_kg: null, quantity: 7, units_per_carton: 18,
    splits: [{ quantity: 4, expiry_date: '2026-11-12' }, { quantity: 3, expiry_date: '2026-11-20' }],
    print_barcode: true, batch_id: '11111111-1111-4111-8111-111111111111',
  };

  it('mints one label per carton: no weight, the units, each split its expiry, one batch', async () => {
    const res = await post(units);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.labels).toHaveLength(7);
    expect(new Set(data.labels.map((l: Row) => l.batch_id)).size).toBe(1);
    expect(data.labels.every((l: Row) => l.weight_kg === null && l.units_per_carton === 18 && l.pallet_number === 0)).toBe(true);
    expect(data.labels.map((l: Row) => l.expiry_date)).toEqual([
      '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-20', '2026-11-20', '2026-11-20',
    ]);
    expect(new Set(data.labels.map((l: Row) => l.barcode)).size).toBe(7);
  });

  it('a retry of the same save returns the same batch', async () => {
    const first = await (await post(units)).json();
    const again = await (await post(units)).json();
    expect(again.batch_id).toBe(first.batch_id);
    expect(db.carton_labels).toHaveLength(7);
  });

  it('refuses splits that do not add up, a weight, or a pallet', async () => {
    expect((await post({ ...units, quantity: 8 })).status).toBe(400);
    expect((await post({ ...units, weight_kg: 12 })).status).toBe(400);
    expect((await post({ ...units, pallet_number: 2 })).status).toBe(400);
    expect((await post({ ...units, units_per_carton: 0 })).status).toBe(400);
    expect(db.carton_labels).toHaveLength(0);
  });

  it('a kg save never carries units_per_carton', async () => {
    const res = await post({
      token: 'tokT', pallet_number: 0, item_code: 'KK117', item_name_hebrew: 'מנה', weight_kg: 12.5, quantity: 2,
      expiry_date: '2026-11-12', print_barcode: true,
    });
    expect(res.status).toBe(200);
    expect(db.carton_labels).toHaveLength(2);
    expect(db.carton_labels.every((l) => !('units_per_carton' in l) && l.weight_kg === 12.5)).toBe(true);
  });
});
