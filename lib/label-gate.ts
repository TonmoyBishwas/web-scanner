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
 *   (ii) it is a New carton label that is on NO list — neither the one being
 *        booked nor one already booked. Such a sticker is a carton still
 *        waiting outside the job (a label saved before Q5, or whose row the
 *        worker deleted: the server never deletes a New carton label).
 *
 * Q5 (client, 2026-10-13): a New carton saved on pallet-verify becomes a
 * scan row at once, counted at the weight the worker entered. Its label on
 * the list being booked — or on a list already booked — never blocks: the
 * carton is booked "label not printed" (the row carries a badge, the
 * pallet-complete payload carries `label_printed: false` per box and an
 * `unprinted_labels` count, see `unprintedOnList`). Printing stays possible
 * later from Labels.
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

import { labelPrintingEnabled } from './label-printing';

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

function codeSet(codes: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!codes) return out;
  for (const code of codes) {
    if (typeof code === 'string' && code) out.add(code.trim());
  }
  return out;
}

export function blockingLabels(
  unprinted: readonly GateLabel[],
  listBarcodes: Iterable<string>,
  /** Barcodes already booked on this session's closed pallets / loose pile. */
  bookedBarcodes?: Iterable<string>,
): LabelGate {
  const onList = codeSet(listBarcodes);
  const booked = codeSet(bookedBarcodes);
  const seen = new Set<string>();
  const batchIds: string[] = [];
  let count = 0;
  for (const label of unprinted) {
    if (!label || seen.has(label.barcode)) continue;
    if (label.origin === 'new_carton') {
      // Q5: counted on a list (this one or a booked one) → booked unprinted.
      if (onList.has(label.barcode) || booked.has(label.barcode)) continue;
    } else if (!onList.has(label.barcode)) continue;
    seen.add(label.barcode);
    count += 1;
    if (!batchIds.includes(label.batch_id)) batchIds.push(label.batch_id);
  }
  return { count, batchIds };
}

/**
 * LABEL_PRINT_GATE (2026-10-15, client request (d)): the gate is OFF unless
 * the env says `on` (also `true` / `1`). Off, nothing ever blocks an LPN or a
 * loose finish — page or server — and every unprinted label on the list
 * being booked simply goes to the bot as `label_printed: false`, exactly like
 * a Q5 New carton (`unprintedOnList` already covers every origin). The labels
 * stay printable later from Labels or the signed pending-labels page
 * (lib/label-link.ts). next.config.ts inlines the variable at build time, so
 * the page and the routes always read the same value; changing it needs a
 * redeploy (as every Vercel env change does).
 */
export function labelPrintGateEnabled(raw: string | undefined = process.env.LABEL_PRINT_GATE): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}

/** No label blocks: what the gate answers while LABEL_PRINT_GATE is off. */
export const NO_GATE: LabelGate = Object.freeze({ count: 0, batchIds: [] }) as LabelGate;

/**
 * The gate both the page and the completion routes consult: `blockingLabels`
 * when LABEL_PRINT_GATE is on, NO_GATE when it is off. It also needs label
 * printing on (LABEL_PRINTING_ENABLED, lib/label-printing.ts, client 20/10):
 * with no printer a label can never reach paper, so a LABEL_PRINT_GATE=on
 * left in an env must never hold a pallet.
 */
export function printGate(
  unprinted: readonly GateLabel[],
  listBarcodes: Iterable<string>,
  bookedBarcodes?: Iterable<string>,
  enabled: boolean = labelPrintGateEnabled() && labelPrintingEnabled(),
): LabelGate {
  return enabled ? blockingLabels(unprinted, listBarcodes, bookedBarcodes) : NO_GATE;
}

/**
 * Q5: the barcodes on the list being booked whose saved label is still
 * unprinted — what the completion routes flag to the bot (`label_printed:
 * false` per box, `unprinted_labels` = the size of this set). Only New
 * carton labels can get this far: any other unprinted label on the list
 * blocks the booking (blockingLabels).
 */
export function unprintedOnList(
  unprinted: readonly GateLabel[],
  listBarcodes: Iterable<string>,
): Set<string> {
  const onList = codeSet(listBarcodes);
  const out = new Set<string>();
  for (const label of unprinted) {
    if (label && onList.has(label.barcode)) out.add(label.barcode);
  }
  return out;
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
