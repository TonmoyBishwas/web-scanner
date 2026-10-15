/**
 * "Delete" chip and "change count" (client request (c), 2026-10-15) — the
 * pure rules, shared by the scanner page and DELETE /api/carton-labels
 * ?scope=session. Kept free of React and Supabase so vitest runs it in node.
 *
 * Two hard rules run through all of it:
 *  - a label whose carton is BOOKED (on an LPN, or in the session's booked
 *    list) is never deleted or voided — that sticker is on a box in stock;
 *  - a PRINTED label is never deleted: the sticker exists on paper. It can
 *    only be voided (status 'void'), with the worker told to peel it off.
 */

/** What the Delete sheet asks the server to clear on one pallet (0 = loose pile). */
export type LabelClearMode =
  /** The labels of the rows "Delete all cartons" took off the list: unprinted
   *  identical / receiving labels (the per-row delete rule, in bulk). New
   *  carton labels stay — removing a New carton row only un-scans it. */
  | 'rows'
  /** Every unprinted label saved on this pallet, New carton included. */
  | 'unprinted'
  /** Printed labels on this pallet whose carton was never booked → void. */
  | 'void_printed';

export function parseClearMode(v: unknown): LabelClearMode | null {
  return v === 'rows' || v === 'unprinted' || v === 'void_printed' ? v : null;
}

export interface ClearableLabel {
  id: string;
  barcode: string;
  status: string;
  origin: string;
  pallet_number: number | null;
}

/**
 * The labels a clear of `mode` on `pallet` acts on, out of one session's
 * labels. Never a booked one; never a printed one except to void it.
 */
export function planLabelClear<T extends ClearableLabel>(
  labels: readonly T[],
  opts: { mode: LabelClearMode; pallet: number; booked: ReadonlySet<string> },
): T[] {
  return labels.filter((l) => {
    if (!l || l.pallet_number !== opts.pallet) return false;
    if (opts.booked.has(l.barcode)) return false;
    switch (opts.mode) {
      case 'rows':
        return l.status === 'created' && l.origin !== 'new_carton';
      case 'unprinted':
        return l.status === 'created';
      case 'void_printed':
        return l.status === 'printed';
    }
  });
}

// ─── Change the count of an identical-label group ───────────────────────────

/** The fields of a scan row the group rules read. */
export interface GroupRow {
  barcode: string;
  minted?: boolean;
  label_batch_id?: string;
  /** The batch a grown row's group started as (see growGroupRows). */
  count_group?: string;
}

/**
 * The group a minted row belongs to for "change count": the batch it was
 * first saved as. Rows added later by growing the group carry that id in
 * `count_group` (their own labels are a new batch). Null = not a minted row.
 */
export function countGroupOf(row: GroupRow): string | null {
  if (!row.minted) return null;
  return row.count_group ?? row.label_batch_id ?? null;
}

export function groupRows<T extends GroupRow>(rows: readonly T[], group: string): T[] {
  return rows.filter((r) => countGroupOf(r) === group);
}

/**
 * Which rows to take off when a group of N shrinks by k: from the end of
 * the list (the last minted), those whose label is still unprinted first —
 * an unprinted label goes with its row, a printed one would leave a sticker
 * on paper — then printed ones, again from the end. Returns their barcodes.
 */
export function rowsToShrink<T extends GroupRow>(
  rows: readonly T[],
  group: string,
  k: number,
  unprinted: ReadonlySet<string>,
): string[] {
  if (k <= 0) return [];
  const members = groupRows(rows, group).reverse();
  const first = members.filter((r) => unprinted.has(r.barcode));
  const then = members.filter((r) => !unprinted.has(r.barcode));
  return [...first, ...then].slice(0, k).map((r) => r.barcode);
}

/**
 * Grow a group by the labels just saved for it: one new row per label,
 * copied from the group's last row (same item, weight, dates, supplier code)
 * and inserted right after it. The new rows remember the group (count_group)
 * and carry their own batch id; the photo stays on the original row only.
 */
export function growGroupRows<T extends GroupRow & { image_data?: string; scanned_at?: string; twin?: boolean }>(
  rows: readonly T[],
  group: string,
  labels: ReadonlyArray<{ barcode: string; batch_id: string }>,
  now: string = new Date().toISOString(),
): T[] {
  let lastIdx = -1;
  rows.forEach((r, i) => { if (countGroupOf(r) === group) lastIdx = i; });
  if (lastIdx === -1 || labels.length === 0) return [...rows];
  const template = rows[lastIdx];
  const added = labels.map((l) => ({
    ...template,
    barcode: l.barcode,
    label_batch_id: l.batch_id,
    count_group: group,
    scanned_at: now,
    image_data: undefined,
  }));
  return [...rows.slice(0, lastIdx + 1), ...added, ...rows.slice(lastIdx + 1)];
}

/** Bounds of the count input: at least 1 (0 = Delete), at most one save (500). */
export function clampGroupCount(n: number): number | null {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) return null;
  return n;
}
