/**
 * Pure batching rules for the scanner trace (2026-10-15).
 *
 * On 2026-10-15 David's trace stopped at 09:23 and five minutes of work —
 * the New carton save, pallet 2's confirm — never arrived. Batches were 150
 * events, sent with `keepalive`; an event may be up to 16 KB, and Chrome
 * refuses a keepalive (or sendBeacon) body over 64 KiB. After a burst of
 * deletes a batch over the limit failed on every retry (it never shrank),
 * and the queue was lost on reload.
 *
 * Now: a batch is cut by BYTES (≤ TRACE_BATCH_MAX_BYTES), halves after a
 * failed POST (down to one event), and grows back after a success.
 */

/** Room under the 64 KiB keepalive / beacon limit for the envelope. */
export const TRACE_BATCH_MAX_BYTES = 60_000;
export const TRACE_BATCH_MIN_BYTES = 2_000;

/** UTF-8 byte length of a string (Hebrew is 2 bytes a character). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1; }
    else n += 3;
  }
  return n;
}

/**
 * How many events from the head of `sizes` fit in `budget` bytes (each event
 * also costs a comma). Always at least one, so an oversize event is still
 * tried on its own rather than blocking the queue forever.
 */
export function batchCount(sizes: readonly number[], budget: number): number {
  let used = 0;
  let n = 0;
  for (const size of sizes) {
    if (n > 0 && used + size + 1 > budget) break;
    used += size + 1;
    n += 1;
  }
  return Math.min(n, sizes.length);
}

/** The budget after a failed POST: half, never below the floor. */
export function shrinkBudget(budget: number): number {
  return Math.max(TRACE_BATCH_MIN_BYTES, Math.floor(budget / 2));
}

/** The budget after a successful POST: double, never above the cap. */
export function growBudget(budget: number): number {
  return Math.min(TRACE_BATCH_MAX_BYTES, budget * 2);
}
