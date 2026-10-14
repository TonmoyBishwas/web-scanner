import { nonMeatItemKey } from './nonmeat-key';

/**
 * SCN-14 — what the "How many boxes on this pallet?" input offers before the
 * worker types anything.
 *
 * The worker still confirms (taps Set) or corrects the number — this only
 * fills the input, it never submits it. Nothing here counts a carton the
 * worker did not scan or declare: the figure is a suggestion he accepts.
 *
 * Two sources, in order:
 *  1. 'note' — the delivery note's cartons still owed to THIS pallet. Only
 *     when that is knowable: the last (or only) pallet of a single-scanner
 *     session, no loose boxes still to come, and every note line carries a
 *     carton count. Then everything the note has not yet seen booked on an
 *     earlier pallet must be on this one: sum(line box_count) − sum(earlier
 *     pallets' box_count). On pallet 1 of 2 the note's figure is the whole
 *     delivery, not this pallet, so it is never offered there.
 *     Single-item shortcut: additionally capped by that item's own note line
 *     (line box_count − cartons already declared for it on a damaged-sticker
 *     pallet, the same remaining figure MeatManualCountFlow uses).
 *  2. 'scanned' — mixed pallet only: what is on the list now. Never on the
 *     single-item shortcut, where the list holds just the 2 samples and
 *     offering "2" invites booking a 40-carton pallet as 2.
 *
 * A figure below the input's own minimum (max(2, scanned)) is not offered.
 */

export type CountPrefillSource = 'note' | 'scanned';

export interface CountPrefill {
  value: number;
  source: CountPrefillSource;
}

export interface NoteLine {
  item_code?: string;
  item_name_hebrew?: string;
  box_count?: number | string | null;
}

export interface CountPrefillInput {
  /** session.ocr_data — the delivery note lines. */
  lines: NoteLine[] | undefined | null;
  palletCount: number;
  currentPallet: number;
  looseBoxCount: number;
  /** Split jobs claim slots; there is no "last pallet" cursor to reason on. */
  isSplit: boolean;
  /** box_count of every pallet already closed on this session. */
  completedBoxCounts: number[];
  /** session.meat_committed — damaged-sticker declared cartons per item key. */
  meatCommitted?: Record<string, number> | null;
  /**
   * Single-item shortcut: the note line the sample cartons matched (null =
   * single-item but no line matched). Undefined = mixed pallet.
   */
  singleItemLine?: NoteLine | null;
  /** What the list counts now (listTotal). */
  scannedTotal: number;
  /** The input's floor: max(2, scanned rows). */
  minRequired: number;
}

function cartons(v: unknown): number {
  const n = Math.floor(Number(v) || 0);
  return n > 0 ? n : 0;
}

/** Cartons the note still owes this pallet, or null when that isn't knowable. */
export function noteRemainingForPallet(input: CountPrefillInput): number | null {
  const lines = input.lines || [];
  if (input.isSplit) return null;
  if (lines.length === 0) return null;
  if (input.currentPallet < input.palletCount) return null; // not the last pallet
  if (input.looseBoxCount > 0) return null; // loose cartons still to come
  if (lines.some((l) => cartons(l.box_count) === 0)) return null; // a line without a count
  const owed = lines.reduce((s, l) => s + cartons(l.box_count), 0);
  const booked = input.completedBoxCounts.reduce((s, n) => s + cartons(n), 0);
  return owed - booked;
}

export function countPrefill(input: CountPrefillInput): CountPrefill | null {
  const floor = Math.max(2, input.minRequired);
  const palletRemaining = noteRemainingForPallet(input);

  if (input.singleItemLine !== undefined) {
    // Single-item shortcut: the note or nothing.
    const line = input.singleItemLine;
    if (!line || palletRemaining === null) return null;
    const itemRemaining =
      cartons(line.box_count) - (input.meatCommitted?.[nonMeatItemKey(line)] || 0);
    const value = Math.min(itemRemaining, palletRemaining);
    return value >= floor ? { value, source: 'note' } : null;
  }

  if (palletRemaining !== null && palletRemaining >= floor) {
    return { value: palletRemaining, source: 'note' };
  }
  const scanned = Math.floor(input.scannedTotal);
  return scanned >= floor ? { value: scanned, source: 'scanned' } : null;
}
