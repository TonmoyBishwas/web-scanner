import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signLabelsLink } from './label-link';

/**
 * The carton-label routes against an in-memory Supabase: session scoping of
 * DELETE ?batch= and GET print ?batches= (2026-10-15), the Delete sheet's
 * session clear, and the signed pending-labels link. Nothing reaches a
 * database. The fake applies eq / neq / in / gt filters for real, so a
 * route that forgets a filter touches rows it must not.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Make the next carton_labels UPDATE fail like the CHECK before the 'void' migration. */
let voidRefused = false;

function fakeFrom(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'delete' | 'update' = 'select';
  let patch: Row = {};
  let single = false;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; };
  chain.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return chain; };
  chain.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return chain; };
  chain.gt = (c: string, v: string) => { filters.push((r) => String(r[c]) > v); return chain; };
  chain.delete = () => { op = 'delete'; return chain; };
  chain.update = (p: Row) => { op = 'update'; patch = p; return chain; };
  chain.maybeSingle = () => { single = true; return chain; };
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    const rows = db[table] ?? [];
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    let result: unknown;
    if (op === 'update' && table === 'carton_labels' && patch.status === 'void' && voidRefused) {
      result = { data: null, error: { code: '23514', message: 'violates check constraint' } };
    } else if (op === 'delete') {
      db[table] = rows.filter((r) => !hit.includes(r));
      result = { data: hit, error: null };
    } else if (op === 'update') {
      for (const r of hit) Object.assign(r, patch);
      result = { data: hit, error: null, count: hit.length };
    } else {
      result = { data: single ? hit[0] ?? null : hit, error: null };
    }
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => fakeFrom(t) } }));

const labelsRoute = await import('@/app/api/carton-labels/route');
const printRoute = await import('@/app/api/carton-labels/print/route');
const pendingRoute = await import('@/app/api/carton-labels/pending/route');

const FUTURE = '2999-01-01T00:00:00.000Z';
const label = (id: string, over: Row = {}): Row => ({
  id, batch_id: 'bA', barcode: `28261015${id.padStart(8, '0')}`, serial: `C-${id}`, session_token: 'tokA',
  document_number: 'IN1', status: 'created', origin: 'identical', pallet_number: 2, print_count: 0,
  created_at: '2026-10-15T09:00:00Z', ...over,
});

const req = (path: string, init?: RequestInit) => new NextRequest(`http://scanner.test${path}`, init as never);

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.LPN_SECRET;
  process.env.LPN_SECRET = 'test-secret';
  voidRefused = false;
  db.scan_sessions = [
    { token: 'tokA', expires_at: FUTURE, data: { document_number: 'IN1', chat_id: 1, completed_pallets: [{ barcodes: ['2826101500000009'] }] } },
    { token: 'tokB', expires_at: FUTURE, data: { document_number: 'IN2', chat_id: 2 } },
  ];
  db.box_inventory = [];
  db.carton_labels = [
    label('1'),
    label('2'),
    label('3', { origin: 'new_carton', batch_id: 'bN' }),
    label('4', { status: 'printed', batch_id: 'bP', print_count: 1 }),
    label('5', { pallet_number: 1, batch_id: 'b1' }),
    label('9', { status: 'printed', batch_id: 'bP' }), // booked on a closed pallet (session row)
    label('7', { session_token: 'tokB', document_number: 'IN2', batch_id: 'bB' }),
  ];
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.LPN_SECRET;
  else process.env.LPN_SECRET = savedSecret;
});

const ids = () => db.carton_labels.map((r) => r.id).sort();

describe('DELETE /api/carton-labels?batch= is scoped to the caller session', () => {
  it("another session's batch: 403, nothing deleted", async () => {
    const res = await labelsRoute.DELETE(req('/api/carton-labels?token=tokB&batch=bA', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('labels_not_yours');
    expect(ids()).toEqual(['1', '2', '3', '4', '5', '7', '9']);
  });

  it('its own batch is deleted', async () => {
    const res = await labelsRoute.DELETE(req('/api/carton-labels?token=tokB&batch=bB', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(1);
    expect(ids()).not.toContain('7');
  });
});

describe('GET /api/carton-labels/print', () => {
  it('a token reaches only its own batches', async () => {
    const res = await printRoute.GET(req('/api/carton-labels/print?token=tokB&batches=bA,bB'));
    const body = await res.json();
    expect(body.labels.map((l: Row) => l.id)).toEqual(['7']);
  });

  it("scope=all (the Labels screen's all-jobs reprint) reaches other sessions", async () => {
    const res = await printRoute.GET(req('/api/carton-labels/print?token=tokB&batches=bA&scope=all'));
    expect((await res.json()).labels.length).toBe(2);
  });

  it('doc + sig reaches only that delivery note, no session needed', async () => {
    const sig = signLabelsLink('IN2', 'test-secret');
    const res = await printRoute.GET(req(`/api/carton-labels/print?doc=IN2&sig=${sig}&ids=1,7`));
    expect((await res.json()).labels.map((l: Row) => l.id)).toEqual(['7']);
  });

  it('a wrong sig is 401', async () => {
    const sig = signLabelsLink('IN1', 'test-secret');
    const res = await printRoute.GET(req(`/api/carton-labels/print?doc=IN2&sig=${sig}&ids=7`));
    expect(res.status).toBe(401);
  });

  it('POST with doc + sig marks only that note’s labels printed', async () => {
    const sig = signLabelsLink('IN2', 'test-secret');
    const res = await printRoute.POST(req('/api/carton-labels/print', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: 'IN2', sig, ids: ['1', '7'], via: 'sheet' }),
    }));
    expect((await res.json()).updated).toBe(1);
    expect(db.carton_labels.find((r) => r.id === '7')?.status).toBe('printed');
    expect(db.carton_labels.find((r) => r.id === '1')?.status).toBe('created');
  });
});

describe('DELETE /api/carton-labels?scope=session (the Delete sheet)', () => {
  const clear = (q: string, token = 'tokA') =>
    labelsRoute.DELETE(req(`/api/carton-labels?token=${token}&scope=session&${q}`, { method: 'DELETE' }));

  it('rows: unprinted identical labels of that pallet only', async () => {
    const body = await (await clear('pallet=2&labels=rows')).json();
    expect(body.count).toBe(2);
    expect(ids()).toEqual(['3', '4', '5', '7', '9']);
  });

  it('unprinted: New carton labels too, other pallets and sessions untouched', async () => {
    const body = await (await clear('pallet=2&labels=unprinted')).json();
    expect(body.count).toBe(3);
    expect(body.before.map((b: Row) => b.status)).toEqual(['created', 'created', 'created']);
    expect(ids()).toEqual(['4', '5', '7', '9']);
  });

  it('void_printed: printed unbooked labels become void, the booked one stays printed', async () => {
    const body = await (await clear('pallet=2&labels=void_printed')).json();
    expect(body).toMatchObject({ action: 'voided', count: 1 });
    expect(db.carton_labels.find((r) => r.id === '4')?.status).toBe('void');
    expect(db.carton_labels.find((r) => r.id === '9')?.status).toBe('printed');
  });

  it("void_printed before the 'void' migration: deleted instead, booked still kept", async () => {
    voidRefused = true;
    const body = await (await clear('pallet=2&labels=void_printed')).json();
    expect(body).toMatchObject({ action: 'deleted', count: 1 });
    expect(ids()).toEqual(['1', '2', '3', '5', '7', '9']);
  });

  it('a carton already in box_inventory is never touched', async () => {
    db.box_inventory = [{ barcode: db.carton_labels[0].barcode }];
    await clear('pallet=2&labels=unprinted');
    expect(ids()).toContain('1');
  });

  it('bad parameters are 400; another session clears only its own', async () => {
    expect((await clear('pallet=2&labels=everything')).status).toBe(400);
    expect((await clear('labels=rows')).status).toBe(400);
    const body = await (await clear('pallet=2&labels=unprinted', 'tokB')).json();
    expect(body.count).toBe(1);
    expect(ids()).toEqual(['1', '2', '3', '4', '5', '9']);
  });
});

describe('GET /api/carton-labels/pending', () => {
  it('lists the note’s created labels grouped by pallet', async () => {
    const sig = signLabelsLink('IN1', 'test-secret');
    const body = await (await pendingRoute.GET(req(`/api/carton-labels/pending?doc=IN1&sig=${sig}`))).json();
    expect(body.success).toBe(true);
    expect(body.labels.map((l: Row) => l.id).sort()).toEqual(['1', '2', '3', '5']);
    expect(body.pallets.map((g: { pallet_number: number }) => g.pallet_number).sort()).toEqual([1, 2]);
  });

  it('refuses a missing or foreign signature', async () => {
    expect((await pendingRoute.GET(req('/api/carton-labels/pending?doc=IN1'))).status).toBe(401);
    const other = signLabelsLink('IN2', 'test-secret');
    expect((await pendingRoute.GET(req(`/api/carton-labels/pending?doc=IN1&sig=${other}`))).status).toBe(401);
  });
});
