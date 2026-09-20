/**
 * Repeat gate for shared-label cartons (2026-09-20).
 *
 * When every carton of a product carries the same barcode and the worker has
 * opted in to scan them one by one, the scanner must tell "the next box" from
 * "the same box, still in front of the camera". Timing alone cannot: the
 * decode loop confirms a stationary barcode again every few seconds.
 *
 * The rule: a repeat of the code that was last ACCEPTED counts only after the
 * code has been absent from the decode stream — at least `misses` decode
 * attempts in a row without it AND at least `gapMs` since it was last seen.
 * Moving the camera from one box to the next satisfies both; a phone left on
 * one box never does. A different code, or the first read of any code, is
 * never "the same box".
 */
export class RepeatGate {
  private code = '';
  private lastSeenAt = 0;
  private misses = 0;
  private armed = true;

  constructor(private readonly gapMs: number, private readonly missesNeeded: number) {}

  /** Feed EVERY decode attempt: the code read, or null when nothing decoded. */
  observe(code: string | null, now: number): void {
    if (code && code === this.code) {
      if (this.misses >= this.missesNeeded && now - this.lastSeenAt > this.gapMs) {
        this.armed = true; // it went away and came back
      }
      this.lastSeenAt = now;
      this.misses = 0;
    } else if (code) {
      this.code = code;
      this.lastSeenAt = now;
      this.misses = 0;
      this.armed = true;
    } else {
      this.misses += 1;
    }
  }

  /** May a confirmed repeat of the current code be taken as a new carton? */
  isArmed(): boolean {
    return this.armed;
  }

  /** The current code was just accepted as a carton: it must leave the
   *  frame before it can count again. */
  accepted(): void {
    this.armed = false;
  }
}
