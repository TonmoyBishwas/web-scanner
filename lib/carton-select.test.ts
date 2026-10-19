import { describe, expect, it } from 'vitest';
import { canSelect, selectedForDelete, toggleSelected, withoutSelected } from './carton-select';
import { ScanLedger, type LedgerOp, type LedgerTransport, type ServerCarton } from './scan-ledger';

type Row = { barcode: string; weight: number; scanned_at: string; item?: string };

const row = (barcode: string, item = 'thighs'): Row => ({ barcode, weight: 10, scanned_at: `t-${barcode}`, item });
const NONE: ReadonlySet<string> = new Set();

/** The server side as scan_carton_push / the GET route behave (as in scan-ledger.test.ts). */
function fakeServer() {
  const rows = new Map<string, ServerCarton>();
  const sent: LedgerOp[] = [];
  const t: LedgerTransport = {
    async push(_token, ops: LedgerOp[]) {
      sent.push(...ops);
      return ops.map((op) => {
        const k = `${op.pallet}|${op.key}`;
        const cur = rows.get(k);
        const applied = !cur || op.ver > cur.ver;
        if (applied) rows.set(k, { pallet: op.pallet, key: op.key, row: op.deleted ? null : op.row, deleted: op.deleted, ver: op.ver });
        const now = rows.get(k)!;
        return { pallet: op.pallet, key: op.key, ver: now.ver, applied, deleted: now.deleted };
      });
    },
    async pull(_token, pallet) {
      return [...rows.values()].filter((r) => r.pallet === pallet).map((r) => ({ ...r }));
    },
  };
  return {
    t,
    sent,
    live: (pallet: number) => [...rows.values()].filter((r) => r.pallet === pallet && !r.deleted).map((r) => r.key).sort(),
    dead: (pallet: number) => [...rows.values()].filter((r) => r.pallet === pallet && r.deleted).map((r) => r.key).sort(),
  };
}

let clock = 1_900_000_000_000;
const now = () => (clock += 11);

describe('toggleSelected', () => {
  it('ticks and unticks by barcode', () => {
    let picked = toggleSelected(NONE, 'A', NONE);
    picked = toggleSelected(picked, 'B', NONE);
    expect([...picked].sort()).toEqual(['A', 'B']);
    picked = toggleSelected(picked, 'A', NONE);
    expect([...picked]).toEqual(['B']);
  });

  it('never ticks a booked carton', () => {
    const booked = new Set(['A']);
    expect(canSelect('A', booked)).toBe(false);
    expect([...toggleSelected(NONE, 'A', booked)]).toEqual([]);
  });

  it('never ticks an empty barcode', () => {
    expect(canSelect('', NONE)).toBe(false);
  });
});

describe('selectedForDelete', () => {
  const list = [row('A'), row('B', 'wings'), row('C'), row('D')];

  it('nothing picked → nothing deleted', () => {
    expect(selectedForDelete(list, NONE, NONE)).toEqual([]);
  });

  it('several picks, in list order, the "Scanning now" card included', () => {
    // D is the newest scan = the "Scanning now" card.
    expect(selectedForDelete(list, new Set(['D', 'A', 'C']), NONE)).toEqual(['A', 'C', 'D']);
  });

  it('a pick no longer on the list (removed on another screen) is skipped', () => {
    expect(selectedForDelete(list, new Set(['A', 'Z']), NONE)).toEqual(['A']);
  });

  it('a booked carton is never deleted, even if it was picked', () => {
    expect(selectedForDelete(list, new Set(['A', 'B']), new Set(['B']))).toEqual(['A']);
  });

  it('a carton hidden by the By-item filter is never deleted', () => {
    const onlyThighs = (r: Row) => r.item === 'thighs';
    expect(selectedForDelete(list, new Set(['A', 'B']), NONE, onlyThighs)).toEqual(['A']);
  });

  it('a pick survives a new scan landing on top of it', () => {
    const picked = toggleSelected(NONE, 'D', NONE); // D was "Scanning now"
    const grown = [...list, row('E')];              // E is now
    expect(selectedForDelete(grown, picked, NONE)).toEqual(['D']);
  });
});

describe('Delete selected → server tombstones', () => {
  it('every deleted carton goes through ScanLedger.observe as a tombstone; the rest stay', async () => {
    const s = fakeServer();
    const L = new ScanLedger('tok', 'tab', null, s.t, () => {}, now);
    let list: Row[] = [];
    L.observe(1, list);
    for (const code of ['A', 'B', 'C', 'D', 'E']) {
      list = [...list, row(code)];
      L.observe(1, list);
    }
    await L.flush();
    expect(s.live(1)).toEqual(['A', 'B', 'C', 'D', 'E']);

    // Selection mode: tick B, D and E (E = "Scanning now"), Delete selected.
    let picked: ReadonlySet<string> = NONE;
    for (const code of ['B', 'D', 'E']) picked = toggleSelected(picked, code, NONE);
    const gone = selectedForDelete(list, picked, NONE);
    list = withoutSelected(list, gone);
    L.observe(1, list); // the page's persist effect

    expect([...L.pendingRemovals(1)].sort()).toEqual(['B', 'D', 'E']);
    await L.flush();
    expect(s.live(1)).toEqual(['A', 'C']);
    expect(s.dead(1)).toEqual(['B', 'D', 'E']);
    const tombs = s.sent.filter((op) => op.deleted).map((op) => op.key).sort();
    expect(tombs).toEqual(['B', 'D', 'E']);
  });

  it('a booked carton in the picks is never sent as a tombstone', async () => {
    const s = fakeServer();
    const L = new ScanLedger('tok', 'tab', null, s.t, () => {}, now);
    let list: Row[] = [row('A'), row('B')];
    L.observe(0, []);
    L.observe(0, list);
    await L.flush();
    const gone = selectedForDelete(list, new Set(['A', 'B']), new Set(['A']));
    list = withoutSelected(list, gone);
    L.observe(0, list);
    await L.flush();
    expect(s.live(0)).toEqual(['A']);
    expect(s.sent.filter((op) => op.deleted).map((op) => op.key)).toEqual(['B']);
  });
});
