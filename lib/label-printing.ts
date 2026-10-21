/**
 * LABEL_PRINTING_ENABLED (client 20/10): "The warehouse does not use a label
 * printer right now. Nothing in the flow may depend on printing … No
 * reminder, no block, nothing waiting on them. Make printing optional
 * everywhere, off by default."
 *
 * OFF unless the env says `on` (also `true` / `yes` / `1` — the same set the
 * bot's LABEL_PRINTING_ENABLED accepts, so one value means the same on
 * Railway and Vercel). Off:
 *   - no print dialog, no print button, no label-size picker, no "Not
 *     printed" filter, badge, row marker or "N labels waiting — print later"
 *     card, and no toast or form note that tells the worker to print;
 *   - the print gate cannot block (lib/label-gate.ts printGate needs this
 *     AND LABEL_PRINT_GATE);
 *   - /scan and /issue lose their New carton / Labels chips (label-only
 *     there: a New carton counts only once its PRINTED label is scanned).
 * Unchanged: `28…` codes are still minted, `carton_labels` rows saved and the
 * cartons booked; the Labels list stays viewable for Delete; the completion
 * payload still carries `label_printed: false` per box (a fact about the
 * carton — what the bot does with it is the bot's flag).
 *
 * Inlined at build time by next.config.ts like LABEL_PRINT_GATE, so the page,
 * the server pages and the API routes read the same value; a change needs a
 * redeploy. On, every screen behaves exactly as before 20/10.
 * Kept free of React so vitest can run it in node.
 */

export function labelPrintingEnabled(raw: string | undefined = process.env.LABEL_PRINTING_ENABLED): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === 'yes' || v === '1';
}

/** The pallet-verify Labels dock chip: amber + count only while printing is on. */
export function labelsChipLook(
  unprintedCount: number,
  printing: boolean,
): { tint: 'amber' | 'neutral'; iconColor: string | undefined; badge: number } {
  const waiting = printing && unprintedCount > 0;
  return {
    tint: waiting ? 'amber' : 'neutral',
    iconColor: waiting ? '#fbbf5c' : undefined,
    badge: printing ? unprintedCount : 0,
  };
}

const NONE: ReadonlySet<string> = new Set<string>();

/**
 * The barcodes whose row shows "Label not printed". The page keeps the real
 * set for deletes and group counts (lib/pallet-clear.ts); only the marker
 * goes when printing is off.
 */
export function unprintedMarkers(unprinted: ReadonlySet<string>, printing: boolean): ReadonlySet<string> {
  return printing ? unprinted : NONE;
}

/** The Labels screen's opening filter: "Not printed" only when printing is on. */
export function labelsInitialStatus(unprintedCount: number, printing: boolean): 'created' | 'all' {
  return printing && unprintedCount > 0 ? 'created' : 'all';
}

/**
 * A New carton save that came back with nothing to count (no labels, or one
 * without a weight). Printing on: the old label-only outcome ("print it,
 * stick it, scan it"). Off there is nothing to scan, so it reads as the
 * failed save it is for the worker, and he saves again.
 */
export function newCartonUncountedToast(
  count: number,
  printing: boolean,
): 'carton.savedNotCountedOne' | 'carton.savedNotCounted' | 'carton.error' {
  if (!printing) return 'carton.error';
  return count === 1 ? 'carton.savedNotCountedOne' : 'carton.savedNotCounted';
}

/** Dock chips that only lead to printing (the /scan and /issue docks). */
export function withoutPrintChips<T extends { id: string }>(
  chips: T[],
  printOnly: readonly string[],
  printing: boolean,
): T[] {
  return printing ? chips : chips.filter((c) => !printOnly.includes(c.id));
}
