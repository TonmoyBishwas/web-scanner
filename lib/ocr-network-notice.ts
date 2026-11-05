/**
 * A label read that never came back (04/11, scanner flag
 * `ocr_network_notice`).
 *
 * The label-read fetch's `.catch` (pallet runOcr, loose runLooseOcr) has
 * traced `ocr_network_failed` since 04/11, but on screen the row only turned
 * failed: on a dead connection every carton failed one by one and nothing
 * said why. With the flag on the page shows the existing
 * `palletVerify.networkError` as a notice — ONCE per outage, not once per
 * carton: the latch is set when it shows and cleared when a read comes back
 * or the browser goes back online. No new text, and the row's failed status
 * is untouched.
 *
 * A question notice on screen ("already on the list — same carton?", "only a
 * short barcode") is never replaced by it: the latch stays clear, so the
 * next failure of the same outage may say it.
 */

/** Per page: has the notice been shown for the outage now running? */
export interface OcrOutageLatch {
  shown: boolean;
}

export function newOcrOutageLatch(): OcrOutageLatch {
  return { shown: false };
}

/**
 * A read failed on the network: show the notice now? True at most once per
 * outage, and never with the flag off or over a question.
 */
export function takeOcrOutageNotice(
  latch: OcrOutageLatch,
  opts: { enabled: boolean; questionUp: boolean },
): boolean {
  if (!opts.enabled || latch.shown || opts.questionUp) return false;
  latch.shown = true;
  return true;
}

/** A read came back, or the browser is online again: the outage is over. */
export function endOcrOutage(latch: OcrOutageLatch): void {
  latch.shown = false;
}
