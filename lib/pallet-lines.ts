/**
 * SCN-11 — a summary line that would become a ghost `pallet_items` row.
 *
 * Pallet 26cbbf86 (LPN-20261004-IN264178-P1) carries a pallet item with no
 * item code, no name, expected 1 and zero box rows: one scan row whose OCR
 * read nothing (no name, weight 0) reached the mix payload as a line of its
 * own. The bot books no box_inventory row for a weightless box, so the line
 * counted a carton that exists nowhere else and pushed the pallet's line
 * count up by one.
 *
 * Such a line carries nothing anyone can act on — no item to match, no name
 * to show, no weight to book — so the completion route leaves it out of
 * `items`. Its scan row still goes in `scanned_boxes` / `verified_scan_count`
 * exactly as before; nothing else changes.
 */
export function isEmptySummaryLine(
  line: { item_code?: string | null; item_name?: string | null; item_name_hebrew?: string | null },
  boxes: ReadonlyArray<{ weight?: number | null }>,
): boolean {
  const blank = (v: string | null | undefined) => !(v || '').trim();
  return blank(line.item_code) && blank(line.item_name) && blank(line.item_name_hebrew)
    && !boxes.some((b) => Number(b.weight) > 0);
}
