import { describe, it, expect } from 'vitest';
import {
  buildSlots, canClaim, claimNext, releaseSlot, reassignSlot,
  addSlot, markDone, closeShort, isComplete, openCount, poolAvailableFor,
  type SplitState,
} from './pallet-slots';

const NOW = '2026-08-05T10:00:00.000Z';

/** 10 pallets: Yossi reserves 5, David 3, Manager 2. Nothing claimed yet. */
function tenPallets(): SplitState {
  return {
    roster: [
      { chat_id: 'yossi', nickname: 'Yossi', quota: 5 },
      { chat_id: 'david', nickname: 'David', quota: 3 },
      { chat_id: 'mgr', nickname: 'Me', quota: 2 },
    ],
    pallets: buildSlots(10),
    loose: null,
  };
}

/** 10 pallets, only Yossi (5) and David (3) reserve — 2 are unreserved. */
function withSpareCapacity(): SplitState {
  const s = tenPallets();
  s.roster = s.roster.filter((r) => r.chat_id !== 'mgr');
  return s;
}

/**
 * 10 pallets, one quota-less worker. Used where ONE person legitimately takes
 * every pallet — which `tenPallets()` cannot express: its quotas (5+3+2) reserve
 * the full capacity, so Yossi is correctly blocked at his 6th claim to protect
 * David's and the manager's shares.
 */
function soloWorker(): SplitState {
  return {
    roster: [{ chat_id: 'yossi', nickname: 'Yossi', quota: null }],
    pallets: buildSlots(10),
    loose: null,
  };
}

function claimTimes(state: SplitState, chatId: string, times: number): SplitState {
  let s = state;
  for (let i = 0; i < times; i++) {
    const r = claimNext(s, chatId, NOW);
    if (!r.ok) throw new Error(`claim ${i + 1} failed: ${r.reason}`);
    s = r.state;
  }
  return s;
}

function finishAll(state: SplitState, chatId: string): SplitState {
  let s = state;
  for (const p of s.pallets.filter((x) => x.owner === chatId && x.status === 'claimed')) {
    const r = markDone(s, p.n, `LPN-X-P${p.n}`, 12);
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
  }
  return s;
}

describe('buildSlots', () => {
  it('numbers slots from 1 and leaves them unowned', () => {
    const slots = buildSlots(3);
    expect(slots.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(slots.every((s) => s.owner === null && s.status === 'open')).toBe(true);
  });
});

describe('reservations', () => {
  it('lets a reserved worker claim while capacity is fully reserved', () => {
    expect(canClaim(tenPallets(), 'yossi')).toBe(true);
  });

  it('blocks a worker who met their quota when every open slot is reserved', () => {
    const s = finishAll(claimTimes(tenPallets(), 'yossi', 5), 'yossi');
    expect(openCount(s)).toBe(5);
    expect(poolAvailableFor(s, 'yossi')).toBe(0);
    expect(canClaim(s, 'yossi')).toBe(false);
  });

  it('lets a finished worker keep pulling unreserved capacity', () => {
    const s = finishAll(claimTimes(withSpareCapacity(), 'yossi', 5), 'yossi');
    expect(poolAvailableFor(s, 'yossi')).toBe(2);
    expect(canClaim(s, 'yossi')).toBe(true);
  });

  it('gives a quota-less worker access only to unreserved capacity', () => {
    const s = withSpareCapacity();
    s.roster.push({ chat_id: 'ariel', nickname: 'Ariel', quota: null });
    expect(poolAvailableFor(s, 'ariel')).toBe(2);
    const after = claimTimes(s, 'ariel', 2);
    expect(canClaim(after, 'ariel')).toBe(false);
  });

  it('releases capacity when a no-show is removed from the roster', () => {
    let s = finishAll(claimTimes(tenPallets(), 'yossi', 5), 'yossi');
    expect(canClaim(s, 'yossi')).toBe(false);
    s = { ...s, roster: s.roster.filter((r) => r.chat_id !== 'mgr') };
    expect(poolAvailableFor(s, 'yossi')).toBe(2);
    expect(canClaim(s, 'yossi')).toBe(true);
  });

  it('refuses to claim when nothing is open', () => {
    const s = finishAll(claimTimes(tenPallets(), 'yossi', 5), 'yossi');
    const drained = closeShort(s);
    expect(drained.ok).toBe(true);
    if (drained.ok) expect(canClaim(drained.state, 'yossi')).toBe(false);
  });
});

describe('claimNext', () => {
  it('stamps owner, status and time on the lowest open slot', () => {
    const r = claimNext(tenPallets(), 'yossi', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slot.n).toBe(1);
    expect(r.slot.owner).toBe('yossi');
    expect(r.slot.status).toBe('claimed');
    expect(r.slot.claimed_at).toBe(NOW);
  });

  it('does not mutate the input state', () => {
    const before = tenPallets();
    claimNext(before, 'yossi', NOW);
    expect(before.pallets[0].owner).toBeNull();
  });

  it('hands two workers different slots', () => {
    const a = claimNext(tenPallets(), 'yossi', NOW);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = claimNext(a.state, 'david', NOW);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.slot.n).toBe(2);
  });
});

describe('releaseSlot / reassignSlot', () => {
  it('returns a claimed slot to the pool', () => {
    const claimed = claimNext(tenPallets(), 'yossi', NOW);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const r = releaseSlot(claimed.state, 1, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.pallets[0]).toMatchObject({ owner: null, status: 'open' });
  });

  it('refuses to release a finished pallet', () => {
    let s = claimTimes(tenPallets(), 'yossi', 1);
    const done = markDone(s, 1, 'LPN-X-P1', 12);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    s = done.state;
    expect(releaseSlot(s, 1, NOW).ok).toBe(false);
  });

  it('moves a claimed slot straight to another worker', () => {
    const claimed = claimNext(tenPallets(), 'yossi', NOW);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const r = reassignSlot(claimed.state, 1, 'david', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.pallets[0]).toMatchObject({ owner: 'david', status: 'claimed' });
  });

  it('refuses to reassign an unclaimed slot', () => {
    // Reassign is not a back door for handing out open pallets: allowing it
    // would let any roster member route open slots to themselves and ignore
    // their quota. Open pallets are taken through claimNext, which enforces
    // the reservation formula.
    const r = reassignSlot(tenPallets(), 1, 'david', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_claimed');
  });

  it('refuses to reassign a finished pallet', () => {
    const s = finishAll(claimTimes(tenPallets(), 'yossi', 1), 'yossi');
    expect(reassignSlot(s, 1, 'david', NOW).ok).toBe(false);
  });
});

describe('markDone', () => {
  it('refuses to finish a slot nobody claimed', () => {
    // Guards the invariant that a done pallet always has an owner — otherwise
    // a completed pallet could exist with owner: null, which no worker scanned.
    const r = markDone(tenPallets(), 1, 'LPN-X-P1', 12);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_claimed');
  });

  it('records the LPN and box count on a claimed slot', () => {
    const s = claimTimes(tenPallets(), 'yossi', 1);
    const r = markDone(s, 1, 'LPN-20260805-INV1-P1', 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.pallets[0]).toMatchObject({
      status: 'done', owner: 'yossi', lpn: 'LPN-20260805-INV1-P1', box_count: 14,
    });
  });
});

describe('addSlot', () => {
  it('appends the next number and claims it', () => {
    const r = addSlot(tenPallets(), 'yossi', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slot.n).toBe(11);
    expect(r.slot.owner).toBe('yossi');
    expect(r.state.pallets).toHaveLength(11);
  });

  it('appends twice without collision', () => {
    const a = addSlot(tenPallets(), 'yossi', NOW);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = addSlot(a.state, 'david', NOW);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.slot.n).toBe(12);
  });
});

describe('closeShort', () => {
  it('drops open slots and reports them', () => {
    const s = finishAll(claimTimes(tenPallets(), 'yossi', 2), 'yossi');
    const r = closeShort(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(isComplete(r.state)).toBe(true);
  });

  it('refuses while a pallet is still claimed', () => {
    const s = claimTimes(tenPallets(), 'yossi', 1);
    const r = closeShort(s);
    expect(r.ok).toBe(false);
  });
});

describe('isComplete', () => {
  it('is false while any pallet is open or claimed', () => {
    expect(isComplete(tenPallets())).toBe(false);
  });

  it('is true when every pallet is done and there are no loose boxes', () => {
    const s = finishAll(claimTimes(soloWorker(), 'yossi', 10), 'yossi');
    expect(isComplete(s)).toBe(true);
  });

  it('waits for the loose task even when every pallet is done', () => {
    let s = soloWorker();
    s.loose = { count: 7, owner: null, status: 'open' };
    s = finishAll(claimTimes(s, 'yossi', 10), 'yossi');
    expect(isComplete(s)).toBe(false);
    s = { ...s, loose: { count: 7, owner: 'yossi', status: 'done' } };
    expect(isComplete(s)).toBe(true);
  });
});
