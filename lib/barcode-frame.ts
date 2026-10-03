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

/**
 * "Two identical reads within 3 s" — counted per value, so a second label in
 * the frame (or a stray misread) no longer resets the one being aimed at.
 *
 * Each value's window opens at its first read; a read after the window closes
 * starts that value over at 1 (the old single-slot rule, per value). When
 * several values confirm on the same frame, the one nearest the centre wins.
 * A confirmation clears everything, like the old slot did.
 */
export class ReadConfirmer {
  private pending = new Map<string, { count: number; first: number }>();

  constructor(
    private readonly need = 2,
    private readonly windowMs = 3000,
  ) {}

  /** Feed one frame's reads. Returns the confirmed value (if any) and the best progress count for the UI. */
  add(reads: FrameRead[], now: number): { confirmed: string | null; progress: number } {
    for (const [v, p] of this.pending) {
      if (now - p.first > this.windowMs) this.pending.delete(v);
    }
    let confirmed: string | null = null;
    for (const r of orderReads(reads)) {
      const p = this.pending.get(r.value);
      const count = p ? p.count + 1 : 1;
      this.pending.set(r.value, { count, first: p ? p.first : now });
      // orderReads sorted by centre distance, so the first to confirm is the nearest.
      if (confirmed === null && count >= this.need) confirmed = r.value;
    }
    if (confirmed !== null) {
      this.pending.clear();
      return { confirmed, progress: 0 };
    }
    let progress = 0;
    for (const p of this.pending.values()) progress = Math.max(progress, p.count);
    return { confirmed: null, progress };
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
