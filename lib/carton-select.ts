/**
 * Selection mode for the Delete chip (client 19/10, his design
 * "WMS Receiving Terminal": `deleteMode` / `toggleSel` / `deleteSelected`).
 *
 * Tapping Delete in the action row puts a checkbox on every carton card of
 * the open list — the "Scanning now" card included — and a bar at the bottom
 * with "Delete selected (N)" and "Cancel". The picks are kept by barcode, not
 * by position: a new scan landing while the worker picks moves the cards
 * down, and a pick must stay on the carton it was made on.
 *
 * Deleting takes the picked rows off the list exactly as the row's own
 * Delete does, so the page's persist effect hands the shorter list to
 * ScanLedger.observe() and every picked carton goes to the server as a
 * tombstone — there is no second path to the server copy.
 *
 * Never deletable: a carton already booked in this session (the rule the
 * Delete sheet and the server apply, lib/pallet-clear.ts). An open list
 * should never hold one; if it does, its box is locked and it is left out.
 */

interface Row {
  barcode: string;
}

/** Whether this carton may be picked for deletion. */
export function canSelect(barcode: string, booked: ReadonlySet<string>): boolean {
  return !!barcode && !booked.has(barcode);
}

/** Tick or untick one carton. A booked carton is never ticked. */
export function toggleSelected(
  picked: ReadonlySet<string>,
  barcode: string,
  booked: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set(picked);
  if (next.has(barcode)) next.delete(barcode);
  else if (canSelect(barcode, booked)) next.add(barcode);
  return next;
}

/**
 * The barcodes "Delete selected" takes off the list, in list order: picked,
 * still on the list (a server merge may have removed one meanwhile), not
 * booked, and shown under the current By-item filter — a carton the worker
 * cannot see is never deleted by a pick made before the filter changed.
 */
export function selectedForDelete<T extends Row>(
  rows: readonly T[],
  picked: ReadonlySet<string>,
  booked: ReadonlySet<string>,
  visible: (row: T) => boolean = () => true,
): string[] {
  if (picked.size === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!picked.has(r.barcode) || seen.has(r.barcode)) continue;
    if (!canSelect(r.barcode, booked) || !visible(r)) continue;
    seen.add(r.barcode);
    out.push(r.barcode);
  }
  return out;
}

/** The list after "Delete selected": every row whose barcode was taken. */
export function withoutSelected<T extends Row>(rows: readonly T[], gone: readonly string[]): T[] {
  const set = new Set(gone);
  return rows.filter((r) => !set.has(r.barcode));
}

/** The sheet's tall snap (BottomSheet: 0 peek, 1 mid, 2 tall). */
const SHEET_TALL = 2;

/**
 * Where the list sheet goes when selection mode ends. Opening it raises the
 * sheet to tall (room for the checkboxes and the bar) and pauses the camera;
 * when the mode ends the camera is back on, so the sheet goes back to where
 * the worker had it — left tall, it covered the scan frame and the next
 * carton could not be aimed at without dragging it down first. A sheet the
 * worker moved himself while picking stays where he put it. null = leave it.
 */
export function sheetSnapAfterSelect(before: number | null, now: number): number | null {
  if (before === null || before >= SHEET_TALL) return null;
  return now === SHEET_TALL ? before : null;
}
