/**
 * The print gate (2026-10-01): no LPN, no loose-box finish — and so no final
 * close and no Priority push — while SAVED labels are still unprinted.
 *
 * Labels are saved while scanning and printed later from the Labels screen
 * (lib/label-batches.ts). The one hard rule is that a pallet cannot be booked
 * with cartons whose labels never reached paper. An unprinted label blocks
 * the list being booked when:
 *
 *   (i)  its carton is ON that list — an "all boxes identical" or edit-panel
 *        ("receiving") label whose row is about to be booked; or
 *   (ii) it is a New carton label, anywhere in the session. That sticker is
 *        on no list yet: it can only be scanned once it is printed, so an
 *        unprinted one is a carton still waiting outside the job.
 *
 * An identical / receiving label whose row was deleted (an orphan, batch
 * 0877ca78) is on no list and never blocks. Printed labels never block — the
 * callers pass only unprinted ones.
 *
 * Enforced twice with this one function: by the scanner page (the amber
 * "Print N labels first" in place of the slide) and, authoritatively, by both
 * completion routes inside the session lock, before any write or webhook.
 * Kept free of React and Supabase so vitest can run it in node.
 */

/** The 409 reason code both completion routes answer with. */
export const LABELS_NOT_PRINTED = 'labels_not_printed';

/** One unprinted label, as the server reads it and the page tracks it. */
export interface GateLabel {
  barcode: string;
  batch_id: string;
  origin: string;
}

export interface LabelGate {
  /** How many unprinted labels block this list. 0 = free to book. */
  count: number;
  /** Their batches, each once, in first-seen order — what the print sheet opens. */
  batchIds: string[];
}

export function blockingLabels(
  unprinted: readonly GateLabel[],
  listBarcodes: Iterable<string>,
): LabelGate {
  const onList = new Set<string>();
  for (const code of listBarcodes) {
    if (typeof code === 'string' && code) onList.add(code.trim());
  }
  const seen = new Set<string>();
  const batchIds: string[] = [];
  let count = 0;
  for (const label of unprinted) {
    if (!label || seen.has(label.barcode)) continue;
    if (label.origin !== 'new_carton' && !onList.has(label.barcode)) continue;
    seen.add(label.barcode);
    count += 1;
    if (!batchIds.includes(label.batch_id)) batchIds.push(label.batch_id);
  }
  return { count, batchIds };
}

/**
 * Every carton barcode a POST /api/multi-pallet-complete body is booking: the
 * scanned rows, plus the sample carton of each non-meat (Type A) or
 * damaged-sticker item. Anything malformed counts as none.
 */
export function barcodesBeingBooked(body: {
  scanned_boxes?: unknown;
  nonmeat_items?: unknown;
  manual_items?: unknown;
}): string[] {
  const out: string[] = [];
  const pick = (rows: unknown, field: 'barcode' | 'sample_barcode') => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const code = row && typeof row === 'object' ? (row as Record<string, unknown>)[field] : undefined;
      if (typeof code === 'string' && code.trim()) out.push(code.trim());
    }
  };
  pick(body.scanned_boxes, 'barcode');
  pick(body.nonmeat_items, 'sample_barcode');
  pick(body.manual_items, 'sample_barcode');
  return out;
}

/** The completion routes' 409 body. Nothing was written and no webhook fired. */
export function labelGateError(gate: LabelGate): {
  success: false;
  error: typeof LABELS_NOT_PRINTED;
  unprinted: number;
  batch_ids: string[];
} {
  return { success: false, error: LABELS_NOT_PRINTED, unprinted: gate.count, batch_ids: gate.batchIds };
}
