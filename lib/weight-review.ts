/**
 * Reviewing doubted weights without ever blocking the pallet (2026-10-19).
 *
 * IN264191356: 16 correct 8 kg kebab cartons sat amber behind an orange
 * "יש לתקן 16 סריקות לפני המשך" (16 scans must be fixed before continuing)
 * button. The only way on was opening each carton and tapping Save with
 * nothing changed — 20 times. A doubt from lib/weight-sanity.ts is a
 * question, not a fault: the worker is holding the carton and knows.
 *
 * So a doubted weight no longer holds `needs_review` (the gate that keeps a
 * pallet open). The page shows a review bar instead — what looks odd, a
 * one-tap "the weight is correct for all" when the doubted cartons are one
 * item at one weight, and "review one by one" — and Confirm stays available.
 * Confirming with doubts still open asks once, then books as read.
 *
 * Pure helpers; the page owns the rows.
 */
import { groupKeyForBox, type GroupableBox } from './group-key';

export interface DoubtedRow extends GroupableBox {
  weight: number;
  weight_suspect?: { typical?: number; reason: 'name_number' | 'ratio'; name?: string };
  weight_checked?: boolean;
}

/** The rows on a list whose weight is doubted and not yet confirmed. */
export function weightDoubts<R extends DoubtedRow>(rows: ReadonlyArray<R>): R[] {
  return rows.filter((r) => !!r.weight_suspect && !r.weight_checked);
}

/**
 * When every doubted row is the same item at the same weight, that item and
 * weight — one decision can settle them all. Null for none, or a mix.
 */
export function sharedDoubt(rows: ReadonlyArray<DoubtedRow>): { weight: number; name: string } | null {
  const d = weightDoubts(rows);
  if (d.length === 0) return null;
  const key = groupKeyForBox(d[0]);
  const w = d[0].weight;
  if (!d.every((r) => groupKeyForBox(r) === key && Math.abs(r.weight - w) < 0.001)) return null;
  return { weight: w, name: (d[0].item_name_hebrew || d[0].item_name || '').trim() };
}

/**
 * "The weight is correct": the worker confirms the doubted rows as they
 * are. Nothing but the doubt changes — the weight stays what was read.
 * `barcodes` limits it to some rows (default: every doubted row).
 */
export function acceptDoubts<R extends DoubtedRow & { barcode: string }>(
  rows: ReadonlyArray<R>,
  barcodes?: ReadonlySet<string>,
): R[] {
  return rows.map((r) => {
    if (!r.weight_suspect || r.weight_checked) return r;
    if (barcodes && !barcodes.has(r.barcode)) return r;
    return { ...r, weight_suspect: undefined, weight_checked: true };
  });
}
