/**
 * Pure slot / reservation logic for split pallet assignment.
 *
 * NO I/O. Every function takes a SplitState and returns a new one, so the
 * API routes stay thin (load → call → save under withLock) and this logic
 * is unit-testable without a database.
 *
 * A quota is a RESERVATION OF CAPACITY, not a set of pre-numbered pallets.
 * Slots start unowned; owners are stamped on claim. A worker may claim when
 * either their own reservation is unmet, or unreserved capacity remains once
 * every OTHER worker's unmet reservation is set aside. That second clause is
 * what lets a fast worker keep pulling without eating a late colleague's share.
 */

export type SlotStatus = 'open' | 'claimed' | 'done';

export interface PalletSlot {
  n: number;
  owner: string | null;
  status: SlotStatus;
  claimed_at?: string;
  lpn?: string;
  box_count?: number;
}

export interface RosterEntry {
  chat_id: string;
  nickname: string;
  /** Reserved capacity. null = pool-only. */
  quota: number | null;
}

export interface LooseTask {
  count: number;
  owner: string | null;
  status: SlotStatus;
}

export interface SplitState {
  roster: RosterEntry[];
  pallets: PalletSlot[];
  loose: LooseTask | null;
}

type Ok<T> = { ok: true } & T;
type Err = { ok: false; reason: string };

export function buildSlots(total: number): PalletSlot[] {
  const n = Math.max(0, Math.floor(total));
  return Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    owner: null,
    status: 'open' as SlotStatus,
  }));
}

export function openCount(state: SplitState): number {
  return state.pallets.filter((p) => p.status === 'open').length;
}

/** Pallets this worker holds or has finished. */
function heldBy(state: SplitState, chatId: string): number {
  return state.pallets.filter(
    (p) => p.owner === chatId && (p.status === 'claimed' || p.status === 'done'),
  ).length;
}

/** How much of a worker's reservation is still unfulfilled. */
export function unmetReservation(state: SplitState, chatId: string): number {
  const entry = state.roster.find((r) => r.chat_id === chatId);
  if (!entry || entry.quota === null) return 0;
  return Math.max(0, entry.quota - heldBy(state, chatId));
}

/** Open slots this worker may take beyond their own reservation. */
export function poolAvailableFor(state: SplitState, chatId: string): number {
  const reservedByOthers = state.roster
    .filter((r) => r.chat_id !== chatId)
    .reduce((sum, r) => sum + unmetReservation(state, r.chat_id), 0);
  return Math.max(0, openCount(state) - reservedByOthers);
}

export function canClaim(state: SplitState, chatId: string): boolean {
  if (openCount(state) === 0) return false;
  return unmetReservation(state, chatId) > 0 || poolAvailableFor(state, chatId) > 0;
}

export function claimNext(
  state: SplitState,
  chatId: string,
  nowISO: string,
): Ok<{ state: SplitState; slot: PalletSlot }> | Err {
  if (!canClaim(state, chatId)) {
    return { ok: false, reason: openCount(state) === 0 ? 'no_open_slots' : 'reserved_for_others' };
  }
  const target = state.pallets
    .filter((p) => p.status === 'open')
    .sort((a, b) => a.n - b.n)[0];
  const slot: PalletSlot = {
    ...target,
    owner: chatId,
    status: 'claimed',
    claimed_at: nowISO,
  };
  return {
    ok: true,
    slot,
    state: { ...state, pallets: state.pallets.map((p) => (p.n === slot.n ? slot : p)) },
  };
}

export function releaseSlot(
  state: SplitState,
  n: number,
  _nowISO: string,
): Ok<{ state: SplitState }> | Err {
  const target = state.pallets.find((p) => p.n === n);
  if (!target) return { ok: false, reason: 'no_such_slot' };
  if (target.status !== 'claimed') return { ok: false, reason: 'not_claimed' };
  const slot: PalletSlot = { ...target, owner: null, status: 'open', claimed_at: undefined };
  return { ok: true, state: { ...state, pallets: state.pallets.map((p) => (p.n === n ? slot : p)) } };
}

export function reassignSlot(
  state: SplitState,
  n: number,
  toChatId: string,
  nowISO: string,
): Ok<{ state: SplitState }> | Err {
  const target = state.pallets.find((p) => p.n === n);
  if (!target) return { ok: false, reason: 'no_such_slot' };
  // Reassign moves work between people; it is NOT a way to hand out an
  // unclaimed pallet. Allowing an open slot here would let any roster member
  // route pallets to themselves and bypass the reservation formula entirely,
  // making quotas advisory. Unclaimed pallets are taken via claimNext only.
  if (target.status !== 'claimed') return { ok: false, reason: 'not_claimed' };
  const slot: PalletSlot = { ...target, owner: toChatId, status: 'claimed', claimed_at: nowISO };
  return { ok: true, state: { ...state, pallets: state.pallets.map((p) => (p.n === n ? slot : p)) } };
}

export function addSlot(
  state: SplitState,
  chatId: string,
  nowISO: string,
): Ok<{ state: SplitState; slot: PalletSlot }> | Err {
  const highest = state.pallets.reduce((max, p) => Math.max(max, p.n), 0);
  const slot: PalletSlot = {
    n: highest + 1,
    owner: chatId,
    status: 'claimed',
    claimed_at: nowISO,
  };
  return { ok: true, slot, state: { ...state, pallets: [...state.pallets, slot] } };
}

export function markDone(
  state: SplitState,
  n: number,
  lpn: string,
  boxCount: number,
): Ok<{ state: SplitState }> | Err {
  const target = state.pallets.find((p) => p.n === n);
  if (!target) return { ok: false, reason: 'no_such_slot' };
  // Only a claimed slot can be finished. Without this, an open slot could go
  // straight to `done` with `owner: null` — a completed pallet nobody scanned,
  // breaking the module's own invariant that owners are stamped on claim.
  if (target.status !== 'claimed') return { ok: false, reason: 'not_claimed' };
  const slot: PalletSlot = { ...target, status: 'done', lpn, box_count: boxCount };
  return { ok: true, state: { ...state, pallets: state.pallets.map((p) => (p.n === n ? slot : p)) } };
}

export function closeShort(
  state: SplitState,
): Ok<{ state: SplitState; dropped: number[] }> | Err {
  if (state.pallets.some((p) => p.status === 'claimed')) {
    return { ok: false, reason: 'pallet_still_claimed' };
  }
  const dropped = state.pallets.filter((p) => p.status === 'open').map((p) => p.n);
  return {
    ok: true,
    dropped,
    state: { ...state, pallets: state.pallets.filter((p) => p.status === 'done') },
  };
}

export function isComplete(state: SplitState): boolean {
  const palletsDone =
    state.pallets.length > 0 && state.pallets.every((p) => p.status === 'done');
  const looseDone = state.loose === null || state.loose.status === 'done';
  return palletsDone && looseDone;
}
