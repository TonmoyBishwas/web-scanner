/**
 * Frame-level helpers for the live barcode loop in SmartScanner.
 *
 * Why this exists (2026-10-03, "item C" test on IN264172698): perfectly
 * visible supplier stickers took 30–40 s per carton to scan. Two causes,
 * both found in the floor photos:
 *
 * 1. Starved bars. Thermal-printed GS1 stickers often come out with the dark
 *    bars much thinner than the white gaps (measured: narrow bar ≈ 2 px,
 *    narrow space ≈ 4 px, where both should be ≈ 3.5 px), and a bright or
 *    glary label makes it worse. One sticker also had a hairline white void
 *    through a bar. A decoder measuring bar widths then cannot match the
 *    Code 128 patterns, even though a human sees a crisp barcode.
 *    `thickenBars` (a 3×3 grey-level minimum filter) grows every dark bar by
 *    a pixel each side and closes hairline voids. On the 14 floor photos:
 *    Chrome's BarcodeDetector 6/14 raw → 13/14 raw-or-thickened; ZXing 1 → 10.
 *    Bold, well-printed labels go the other way (they decode raw, not
 *    thickened), so the loop CYCLES raw and thickened frames (`nextPass`).
 *
 * 2. Two labels in view. Stacked cartons put several stickers in one frame.
 *    The loop kept only `barcodes[0]` and demanded two IDENTICAL reads in a
 *    row; when the detector's ordering flipped between frames, every read
 *    reset the other's count and nothing ever confirmed. `ReadConfirmer`
 *    counts every value it sees, independently.
 */

/** Minimal ImageData shape — lets the filter run in tests without a DOM. */
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Grow dark bars by one pixel each side, in place: every pixel becomes the
 * darkest grey of its 3×3 neighbourhood (separable min filter). The result is
 * written back as grey RGB with alpha untouched.
 *
 * `scratch` (≥ 2·w·h bytes) is reused across frames so the loop allocates
 * nothing per frame.
 */
export function thickenBars(img: PixelBuffer, scratch?: Uint8Array): Uint8Array {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const buf = scratch && scratch.length >= 2 * n ? scratch : new Uint8Array(2 * n);
  const g = buf.subarray(0, n);
  const t = buf.subarray(n, 2 * n);

  // Luma (Rec. 601, integer).
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }

  // Horizontal 1×3 minimum.
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let m = g[o + x];
      if (x > 0 && g[o + x - 1] < m) m = g[o + x - 1];
      if (x < w - 1 && g[o + x + 1] < m) m = g[o + x + 1];
      t[o + x] = m;
    }
  }

  // Vertical 3×1 minimum, straight back into the RGBA buffer.
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const up = y > 0 ? o - w : o;
    const down = y < h - 1 ? o + w : o;
    for (let x = 0; x < w; x++) {
      let m = t[o + x];
      if (t[up + x] < m) m = t[up + x];
      if (t[down + x] < m) m = t[down + x];
      const j = (o + x) * 4;
      data[j] = m;
      data[j + 1] = m;
      data[j + 2] = m;
    }
  }
  return buf;
}

/** One decoded barcode in a frame. `dist` = distance of its centre from the frame centre, 0..~0.7 (∞ when unknown). */
export interface FrameRead {
  value: string;
  dist: number;
}

/**
 * Order a frame's reads so the barcode nearest the centre of the frame (where
 * the worker is aiming) comes first, dropping blanks and repeats.
 */
export function orderReads(reads: FrameRead[]): FrameRead[] {
  const seen = new Map<string, FrameRead>();
  for (const r of reads) {
    if (!r.value) continue;
    const prev = seen.get(r.value);
    if (!prev || r.dist < prev.dist) seen.set(r.value, r);
  }
  return [...seen.values()].sort((a, b) => a.dist - b.dist);
}

/** Why a value left the confirmer without confirming (trace `read_dropped`). */
export type ReadDropReason = 'expired' | 'superseded' | 'claimed_by_carton_code' | 'camera_stop';

/** A value the confirmer let go unconfirmed: seen `reads` times, first at `first` by `via`. */
export interface DroppedRead {
  value: string;
  via: string;
  reads: number;
  first: number;
  reason: ReadDropReason;
}

/**
 * "Two identical reads within 3 s" — counted per value, so a second label in
 * the frame (or a stray misread) no longer resets the one being aimed at.
 *
 * Each value's window opens at its first read; a read after the window closes
 * starts that value over at 1 (the old single-slot rule, per value). When
 * several values confirm on the same frame, the one nearest the centre wins.
 * A confirmation clears everything, like the old slot did.
 *
 * Every value that leaves without confirming is handed back as a DroppedRead
 * (2026-10-26): the trace used to log each value's first frame as
 * `read_unconfirmed`, so all 99 of David's cartons on 25/10 looked like
 * "seen, not accepted". The decision itself is untouched.
 */
export class ReadConfirmer {
  private pending = new Map<string, { count: number; first: number; via: string }>();

  constructor(
    readonly need = 2,
    private readonly windowMs = 3000,
  ) {}

  /**
   * Feed one frame's reads (`via` = the decoder that made them). Returns the
   * confirmed value (if any) with its first read's time, the best progress
   * count for the UI, and the values that left unconfirmed on this frame.
   */
  add(
    reads: FrameRead[],
    now: number,
    via = '',
  ): { confirmed: string | null; progress: number; confirmedFirstAt: number | null; dropped: DroppedRead[] } {
    const dropped = this.sweep(now);
    let confirmed: string | null = null;
    let confirmedFirstAt: number | null = null;
    for (const r of orderReads(reads)) {
      const p = this.pending.get(r.value);
      const count = p ? p.count + 1 : 1;
      const first = p ? p.first : now;
      this.pending.set(r.value, { count, first, via: p ? p.via : via });
      // orderReads sorted by centre distance, so the first to confirm is the nearest.
      if (confirmed === null && count >= this.need) {
        confirmed = r.value;
        confirmedFirstAt = first;
      }
    }
    if (confirmed !== null) {
      this.pending.delete(confirmed);
      dropped.push(...this.drain('superseded'));
      return { confirmed, progress: 0, confirmedFirstAt, dropped };
    }
    let progress = 0;
    for (const p of this.pending.values()) progress = Math.max(progress, p.count);
    return { confirmed: null, progress, confirmedFirstAt: null, dropped };
  }

  /**
   * Drop (and return) the values whose window has closed unconfirmed. `add()`
   * does this first on every frame; the scanner also calls it from its
   * heartbeat, so a value read once while the camera then sees nothing is
   * reported within seconds, not at the next carton.
   */
  sweep(now: number): DroppedRead[] {
    const out: DroppedRead[] = [];
    for (const [v, p] of this.pending) {
      if (now - p.first > this.windowMs) {
        this.pending.delete(v);
        out.push({ value: v, via: p.via, reads: p.count, first: p.first, reason: 'expired' });
      }
    }
    return out;
  }

  /**
   * Drop the counts of the values `test` picks — reads that turn out to have
   * been the wrong sticker (a product code whose carton code another decoder
   * has just read), so their earlier frames cannot confirm them later.
   */
  forget(test: (value: string) => boolean): DroppedRead[] {
    const out: DroppedRead[] = [];
    for (const [v, p] of [...this.pending]) {
      if (!test(v)) continue;
      this.pending.delete(v);
      out.push({ value: v, via: p.via, reads: p.count, first: p.first, reason: 'claimed_by_carton_code' });
    }
    return out;
  }

  /** Empty the confirmer, returning what was still pending. */
  drain(reason: ReadDropReason): DroppedRead[] {
    const out = [...this.pending].map(([v, p]) => ({ value: v, via: p.via, reads: p.count, first: p.first, reason }));
    this.pending.clear();
    return out;
  }

  reset(): void {
    this.pending.clear();
  }
}

/**
 * The three kinds of frame the loop cycles through:
 * - `raw`        — the frame as the camera gives it (bold, well-printed labels);
 * - `thick`      — bars grown a pixel at the camera's full resolution (thin
 *                  print with ≥ ~3 px per module, i.e. a sticker filling the view);
 * - `thickSmall` — the same at 2/3 size (a sticker held further back, or one so
 *                  starved that a pixel of growth at full size is not enough).
 * On the floor photos neither thickened size covers every sticker alone.
 */
export type DecodePass = 'raw' | 'thick' | 'thickSmall';
const PASS_ORDER: DecodePass[] = ['raw', 'thick', 'thickSmall'];

/** Scale of the thickened passes relative to the camera frame. */
export const THICK_SMALL_SCALE = 2 / 3;

/**
 * Which pass the next decode attempt uses. A pass that just read something is
 * kept (so the confirming second read comes from the same kind of frame, at
 * full cadence); a pass that read nothing hands over to the next one.
 */
export function nextPass(current: DecodePass, foundSomething: boolean): DecodePass {
  if (foundSomething) return current;
  return PASS_ORDER[(PASS_ORDER.indexOf(current) + 1) % PASS_ORDER.length];
}
