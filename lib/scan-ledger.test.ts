import { describe, expect, it } from 'vitest';
import {
  diffList, LedgerUnavailableError, mergeServer, outboxKey, ScanLedger,
  type LedgerOp, type LedgerStore, type LedgerTransport, type ServerCarton,
} from './scan-ledger';

type Row = { barcode: string; weight: number; scanned_at: string; ocr_status?: string; image_data?: string };

/** The server side exactly as scan_carton_push / the GET route behave. */
function fakeServer() {
  const rows = new Map<string, ServerCarton>();
  let online = true;
  const t: LedgerTransport = {
    async push(_token, ops: LedgerOp[]) {
      if (!online) throw new Error('offline');
      return ops.map((op) => {
        const k = `${op.pallet}|${op.key}`;
        const cur = rows.get(k);
        const applied = !cur || op.ver > cur.ver;
        if (applied) {
          rows.set(k, { pallet: op.pallet, key: op.key, row: op.deleted ? null : op.row, deleted: op.deleted, ver: op.ver });
        }
        const now = rows.get(k)!;
        return { pallet: op.pallet, key: op.key, ver: now.ver, applied, deleted: now.deleted };
      });
    },
    async pull(_token, pallet) {
      if (!online) throw new Error('offline');
      return [...rows.values()].filter((r) => r.pallet === pallet).map((r) => ({ ...r }));
    },
  };
  return {
    t,
    live: (pallet: number) => [...rows.values()].filter((r) => r.pallet === pallet && !r.deleted).map((r) => r.key).sort(),
    setOnline: (v: boolean) => { online = v; },
  };
}

function memStore(): LedgerStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

let clock = 1_800_000_000_000;
const now = () => (clock += 7);
let skew = 0; // ms the next page's clock is off by

/** One page load: the ledger plus the list the page holds, wired the way
 *  page.tsx wires them (observe on every change, merge on every pull). */
function page(token: string, tab: string, store: LedgerStore | null, t: LedgerTransport, restored: Row[] = []) {
  const off = skew;
  const L = new ScanLedger(token, tab, store, t, () => {}, () => now() + off);
  let list: Row[] = [...restored];
  L.observe(1, list); // first state = baseline (the page's restore)
  const set = (next: Row[]) => { list = next; L.observe(1, list); };
  return {
    L,
    get list() { return list; },
    keys: () => list.map((r) => r.barcode).sort(),
    scan: (barcode: string, weight = 10) => set([...list, { barcode, weight, scanned_at: new Date(now()).toISOString() }]),
    edit: (barcode: string, weight: number) => set(list.map((r) => (r.barcode === barcode ? { ...r, weight } : r))),
    remove: (barcode: string) => set(list.filter((r) => r.barcode !== barcode)),
    async sync() {
      await L.flush();
      const rows = await L.pull(1);
      const removals = L.pendingRemovals(1);
      const m = mergeServer(list.filter((r) => !removals.has(r.barcode)), L.versionsOf(1), rows);
      L.adopt(1, m.list, m.vers, m.push, m.taken);
      list = m.list;
      L.observe(1, list);
      await L.flush();
    },
  };
}

describe('diffList', () => {
  it('reports new, changed and removed cartons; ignores the photo bytes', () => {
    const known = new Map<string, string>();
    const a = { barcode: 'A', weight: 1, scanned_at: 'x' };
    expect(diffList(known, [a]).upserts.map((r) => r.barcode)).toEqual(['A']);
    const p = page('t', 'tab', null, fakeServer().t);
    p.scan('A');
    expect(p.L.pendingCount()).toBe(1);
    const withPhoto = { ...p.list[0], image_data: 'data:...' };
    const k2 = new Map([['A', JSON.stringify(Object.entries(p.list[0]).sort())]]);
    expect(diffList(k2, [withPhoto]).upserts).toHaveLength(0);
    expect(diffList(k2, []).removed).toEqual(['A']);
  });
});

describe('ScanLedger', () => {
  it('every scan reaches the server', async () => {
    const s = fakeServer();
    const p = page('tok', 'A', memStore(), s.t);
    for (let i = 0; i < 75; i += 1) p.scan(`C${i}`);
    await p.L.flush();
    expect(s.live(1)).toHaveLength(75);
    expect(p.L.pendingCount()).toBe(0);
  });

  it('the 18/10 case: two tabs scanning different cartons add up, nothing is overwritten', async () => {
    const s = fakeServer();
    const store = memStore();
    const a = page('tok', 'A', store, s.t);
    for (let i = 0; i < 38; i += 1) a.scan(`A${i}`);
    await a.sync();
    const b = page('tok', 'B', store, s.t, a.list); // second tab restores the 38
    await b.sync();
    for (let i = 0; i < 31; i += 1) b.scan(`B${i}`);
    await b.sync();
    a.scan('A-late'); // back in the stale tab
    await a.sync();
    await b.sync();
    expect(s.live(1)).toHaveLength(70);
    expect(a.keys()).toEqual(s.live(1));
    expect(b.keys()).toEqual(s.live(1));
  });

  it('a carton removed in one tab does not come back from a stale tab or a reload', async () => {
    const s = fakeServer();
    const store = memStore();
    const a = page('tok', 'A', store, s.t);
    a.scan('X'); a.scan('Y');
    await a.sync();
    const stale = page('tok', 'B', store, s.t, a.list); // holds X and Y
    a.remove('X');
    await a.sync();
    await stale.sync();
    expect(stale.keys()).toEqual(['Y']);
    expect(s.live(1)).toEqual(['Y']);
    const reload = page('tok', 'C', store, s.t, [...stale.list, { barcode: 'X', weight: 10, scanned_at: 'old' }]);
    await reload.sync();
    expect(reload.keys()).toEqual(['Y']);
  });

  it('a removed carton scanned again is counted again', async () => {
    const s = fakeServer();
    const a = page('tok', 'A', memStore(), s.t);
    a.scan('X');
    await a.sync();
    a.remove('X');
    await a.sync();
    a.scan('X');
    await a.sync();
    expect(s.live(1)).toEqual(['X']);
    expect(a.keys()).toEqual(['X']);
  });

  it('offline scans wait on the phone and are sent when the network is back', async () => {
    const s = fakeServer();
    const store = memStore();
    const a = page('tok', 'A', store, s.t);
    a.scan('ONLINE');
    await a.L.flush();
    s.setOnline(false);
    for (let i = 0; i < 5; i += 1) a.scan(`OFF${i}`);
    expect(await a.L.flush()).toBe(false);
    expect(a.L.pendingCount()).toBe(5);
    expect(store.map.get(outboxKey('tok', 'A'))).toContain('OFF4');
    s.setOnline(true);
    expect(await a.L.flush()).toBe(true);
    expect(s.live(1)).toHaveLength(6);
  });

  it('browser killed while offline: the next page load sends what was waiting, once', async () => {
    const s = fakeServer();
    const store = memStore();
    const a = page('tok', 'A', store, s.t);
    s.setOnline(false);
    a.scan('K1'); a.scan('K2');
    await a.L.flush();
    // killed: only localStorage survives (cached list + A's outbox)
    s.setOnline(true);
    const b = page('tok', 'B', store, s.t, a.list);
    await b.sync();
    expect(s.live(1)).toEqual(['K1', 'K2']);
    expect(b.keys()).toEqual(['K1', 'K2']);
    expect(store.map.has(outboxKey('tok', 'A'))).toBe(false);
  });

  it('a list cached before the server copy existed is uploaded on the first sync', async () => {
    const s = fakeServer();
    const legacy: Row[] = [{ barcode: 'L1', weight: 9, scanned_at: 'a' }, { barcode: 'L2', weight: 9, scanned_at: 'b' }];
    const p = page('tok', 'A', memStore(), s.t, legacy);
    expect(p.L.pendingCount()).toBe(0); // the restore itself queues nothing
    await p.sync();
    expect(s.live(1)).toEqual(['L1', 'L2']);
  });

  it('the same carton edited in two tabs keeps the later edit', async () => {
    const s = fakeServer();
    const store = memStore();
    const a = page('tok', 'A', store, s.t);
    a.scan('W', 10);
    await a.sync();
    const b = page('tok', 'B', store, s.t, a.list);
    await b.sync();
    a.edit('W', 11);
    await a.sync();
    b.edit('W', 12);
    await b.sync();
    await a.sync();
    expect(a.list.find((r) => r.barcode === 'W')?.weight).toBe(12);
    expect(b.list.find((r) => r.barcode === 'W')?.weight).toBe(12);
  });

  it('a change made while a pull is merged is still sent', async () => {
    const s = fakeServer();
    const a = page('tok', 'A', memStore(), s.t);
    a.scan('Q', 10);
    await a.sync();
    // OCR result lands in the same moment as a merge (not yet observed)
    const rows = await a.L.pull(1);
    const edited = a.list.map((r) => ({ ...r, weight: 10.5 }));
    const m = mergeServer(edited, a.L.versionsOf(1), rows);
    a.L.adopt(1, m.list, m.vers, m.push, m.taken);
    a.L.observe(1, m.list);
    await a.L.flush();
    const back = await a.L.pull(1);
    expect(back.find((r) => r.key === 'Q')?.row?.weight).toBe(10.5);
  });

  it('a provisional id replaced by the real barcode moves the carton', async () => {
    const s = fakeServer();
    const a = page('tok', 'A', memStore(), s.t);
    a.scan('MANUAL-1');
    await a.sync();
    a.remove('MANUAL-1');
    a.scan('7290002195832012270127630052027');
    await a.sync();
    expect(s.live(1)).toEqual(['7290002195832012270127630052027']);
  });

  it('a confirmed pallet cleared for the next one removes nothing on the server', async () => {
    const s = fakeServer();
    const a = page('tok', 'A', memStore(), s.t);
    a.scan('P1'); a.scan('P2');
    await a.sync();
    a.L.close(1);
    a.L.observe(1, []);
    await a.L.flush();
    expect(s.live(1)).toEqual(['P1', 'P2']);
  });

  it('a photo held on this phone survives a merge', () => {
    const local: Row[] = [{ barcode: 'I', weight: 1, scanned_at: 'a', image_data: 'data:img', ocr_status: 'processing' }];
    const server: ServerCarton[] = [{ pallet: 1, key: 'I', deleted: false, ver: 5, row: { barcode: 'I', weight: 2, scanned_at: 'a', ocr_status: 'done' } }];
    const m = mergeServer(local, new Map(), server);
    expect(m.list[0]).toMatchObject({ weight: 2, image_data: 'data:img', ocr_status: 'done' });
  });

  it('a phone whose clock is behind still re-adds a carton removed on a phone whose clock is ahead', async () => {
    const s = fakeServer();
    skew = 120_000;
    const ahead = page('tok', 'A', memStore(), s.t);
    skew = 0;
    ahead.scan('X');
    await ahead.sync();
    ahead.remove('X');
    await ahead.sync();
    // the other phone saw the removal, then the worker scans X there
    skew = -120_000;
    const behind = page('tok', 'B', memStore(), s.t);
    skew = 0;
    await behind.sync();
    behind.scan('X');
    await behind.sync();
    expect(s.live(1)).toEqual(['X']);
    expect(behind.keys()).toEqual(['X']);
  });

  it('a scan that raced with a later-stamped removal wins (offline phone)', async () => {
    const s = fakeServer();
    const c0 = page('tok', 'C', memStore(), s.t);
    c0.scan('Z');
    await c0.sync();
    const b = page('tok', 'B', memStore(), s.t);
    await b.sync();
    s.setOnline(false);
    b.remove('Z');
    b.scan('Z');              // B (offline) re-scans the carton in hand
    s.setOnline(true);
    skew = 300_000;
    const c = page('tok', 'C2', memStore(), s.t, c0.list); // a clock 5 min ahead
    skew = 0;
    await c.sync();
    c.remove('Z');
    await c.sync();           // tombstone stamped +5 min
    await b.sync();           // B's scan is refused as older, re-sent above the tombstone
    expect(s.live(1)).toEqual(['Z']);
    expect(b.keys()).toEqual(['Z']);
  });

  it('a change the server refuses is not resent forever', async () => {
    let calls = 0;
    const t: LedgerTransport = {
      async push(_token, ops) { calls += 1; return ops.map((o) => ({ pallet: o.pallet, key: o.key, ver: 0, rejected: 'bad_op' })); },
      async pull() { return []; },
    };
    const events: string[] = [];
    const L = new ScanLedger('tok', 'A', memStore(), t, () => {}, now, (e) => events.push(e.kind));
    L.observe(1, []);
    L.observe(1, [{ barcode: 'BAD' }]);
    expect(await L.flush()).toBe(true);
    expect(L.pendingCount()).toBe(0);
    expect(calls).toBe(1);
    expect(events).toEqual(['dropped']);
  });

  it('server copy not deployed: changes wait on the phone, status says unavailable, nothing fails loudly', async () => {
    const t: LedgerTransport = {
      async push() { throw new LedgerUnavailableError(); },
      async pull() { throw new LedgerUnavailableError(); },
    };
    const seen: Array<{ unavailable?: boolean; failing: boolean }> = [];
    const store = memStore();
    const L = new ScanLedger('tok', 'A', store, t, (st) => seen.push(st), now);
    L.observe(1, []);
    L.observe(1, [{ barcode: 'W1' }]);
    expect(await L.flush()).toBe(false);
    expect(seen.at(-1)).toMatchObject({ unavailable: true, failing: false });
    expect(store.map.get(outboxKey('tok', 'A'))).toContain('W1');
    await expect(L.pull(1)).rejects.toBeInstanceOf(LedgerUnavailableError);
  });

  it('a late re-send never beats a newer removal made elsewhere', async () => {
    const s = fakeServer();
    const store = memStore();
    const a = page('tok', 'A', store, s.t);
    a.scan('R');
    await a.sync();
    const b = page('tok', 'B', memStore(), s.t, a.list);
    await b.sync();
    // B pulls, then (before B merges) A removes R
    const stale = await b.L.pull(1);
    a.remove('R');
    await a.sync();
    const m = mergeServer(b.list, b.L.versionsOf(1), stale);
    b.L.adopt(1, m.list, m.vers, m.push, m.taken);
    await b.L.flush();
    await b.sync();
    expect(s.live(1)).toEqual([]);
    expect(b.keys()).toEqual([]);
  });
});
