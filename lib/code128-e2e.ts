/**
 * Edge-to-edge Code 128 reader for thin- or fat-printed stickers.
 *
 * Why this exists (2026-10-03, second item-C floor test on a Redmi Note 11):
 * the supplier's thermal stickers print every dark bar about a pixel thinner
 * than it should be and every gap a pixel wider. Chrome's BarcodeDetector,
 * ZXing and zxing-cpp all measure the WIDTH of each bar and gap, so a
 * starved bar no longer matches any Code 128 pattern — the Redmi only ever
 * confirmed these stickers on the artificially thickened passes, a few
 * seconds per carton. (zxing-cpp: 1/14 floor photos raw; with a 3×3 min
 * filter 10/14, but then 0/7 of the bold meat labels.)
 *
 * Code 128 was designed for exactly this: ISO/IEC 15417's reference decode
 * reads each character from its four EDGE-TO-EDGE distances — bar+gap,
 * gap+bar, … — each measured from a leading edge to the next leading edge
 * (or trailing to trailing). Ink spread or starvation moves both edges of a
 * pair by the same amount, so those distances do not change, however thin or
 * fat the print. This reader does just that along a fan of scanlines across
 * the frame, and accepts a symbol only when the start code, every character,
 * the mod-103 check character and the stop pattern all agree.
 *
 * It costs a few milliseconds per frame in plain JS, so the live loop can run
 * it on every frame before (not instead of) the platform detector, which
 * still handles everything that is not Code 128 and badly tilted symbols.
 */

/** RGBA pixels (ImageData) or one grey byte per pixel. */
export interface ScanImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Bar/space widths (in modules) of Code 128 values 0..105, then the stop pattern's first six elements as 106. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '233111',
].map((p) => [...p].map(Number));

const START_A = 103;
const START_B = 104;
const START_C = 105;
const STOP = 106;

/**
 * What each pattern should measure, in modules:
 *   e1..e4 — edge-to-edge distances (bar+gap, gap+bar, …): immune to the
 *            print being uniformly thinner or fatter;
 *   c1, c2 — distances between the three bar CENTRES: immune to any
 *            symmetric thinning, even when (as on these thermal stickers,
 *            blurred by the camera) thin bars lose less than fat ones.
 */
const FEATURES = PATTERNS.map((p) => [
  p[0] + p[1],
  p[1] + p[2],
  p[2] + p[3],
  p[3] + p[4],
  p[0] / 2 + p[1] + p[2] / 2,
  p[2] / 2 + p[3] + p[4] / 2,
]);
/** Weight of the bar-centre distances against the edge-to-edge ones. */
const CENTRE_WEIGHT = 2;
/** Worst acceptable score, and how much better the winner must be than the runner-up. */
const MAX_SCORE = 0.9;
const MIN_MARGIN = 0.12;

/**
 * Decode one character from six element widths (bar, gap, bar, gap, bar, gap):
 * the pattern whose expected edge and centre distances are closest. Returns
 * -1 when nothing is close, or two patterns are about equally close — the
 * check character only catches what this lets through, so it must not guess.
 */
function decodeChar(w: Float64Array, i: number): number {
  const s = w[i] + w[i + 1] + w[i + 2] + w[i + 3] + w[i + 4] + w[i + 5];
  if (!(s > 0)) return -1;
  const k = 11 / s;
  const m0 = w[i] * k;
  const m1 = w[i + 1] * k;
  const m2 = w[i + 2] * k;
  const m3 = w[i + 3] * k;
  const m4 = w[i + 4] * k;
  const f0 = m0 + m1;
  const f1 = m1 + m2;
  const f2 = m2 + m3;
  const f3 = m3 + m4;
  const f4 = m0 / 2 + m1 + m2 / 2;
  const f5 = m2 / 2 + m3 + m4 / 2;
  let best = -1;
  let bestScore = Infinity;
  let second = Infinity;
  for (let v = 0; v < FEATURES.length; v++) {
    const t = FEATURES[v];
    const score =
      (f0 - t[0]) ** 2 +
      (f1 - t[1]) ** 2 +
      (f2 - t[2]) ** 2 +
      (f3 - t[3]) ** 2 +
      CENTRE_WEIGHT * ((f4 - t[4]) ** 2 + (f5 - t[5]) ** 2);
    if (score < bestScore) {
      second = bestScore;
      bestScore = score;
      best = v;
    } else if (score < second) second = score;
  }
  if (bestScore > MAX_SCORE || second - bestScore < MIN_MARGIN) return -1;
  return best;
}

/**
 * Turn checked symbol values (start … data …, no check/stop) into text, the
 * way the platform detector reports it. Returns null for GS1-128 (a leading
 * FNC1): the platform detector's spelling of those is not verified, and a
 * second spelling of one carton would defeat duplicate detection.
 */
function valuesToText(vals: number[]): string | null {
  let set: 'A' | 'B' | 'C' = vals[0] === START_A ? 'A' : vals[0] === START_B ? 'B' : 'C';
  let out = '';
  let shift = false;
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i];
    const cur = shift ? (set === 'A' ? 'B' : 'A') : set;
    shift = false;
    if (v === 102) {
      if (i === 1) return null; // GS1-128 — leave to the platform detector
      out += '\u001d';
      continue;
    }
    if (cur === 'C') {
      if (v < 100) out += v < 10 ? '0' + v : String(v);
      else if (v === 100) set = 'B';
      else if (v === 101) set = 'A';
      else return null;
      continue;
    }
    if (v < 64) out += String.fromCharCode(32 + v);
    else if (v < 96) {
      if (cur === 'A') out += String.fromCharCode(v - 64);
      else out += String.fromCharCode(32 + v);
    } else if (v === 98) shift = true;
    else if (v === 99) set = 'C';
    else if (v === 100) {
      if (cur === 'A') set = 'B';
      else return null; // FNC4 (extended ASCII) — never seen on these labels
    } else if (v === 101) {
      if (cur === 'B') set = 'A';
      else return null;
    } else if (v === 96 || v === 97) {
      return null; // FNC3 / FNC2 — reader-programming codes, not data
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Try to read one symbol whose start character begins at element `i` (a bar)
 * of `w`. Elements alternate bar/gap from index 0 of `w`.
 */
function decodeAt(w: Float64Array, n: number, i: number): string | null {
  const first = decodeChar(w, i);
  if (first !== START_A && first !== START_B && first !== START_C) return null;
  const unit = (w[i] + w[i + 1] + w[i + 2] + w[i + 3] + w[i + 4] + w[i + 5]) / 11;
  // Quiet zone: the gap before the start code must be clearly wider than any
  // gap inside a symbol (4 modules). Reject a "start" found mid-symbol.
  if (i > 0 && w[i - 1] < unit * QUIET) return null;
  const vals = decodeFrom(w, n, i + 6, [first], unit * 11, unit, MAX_REPAIRS);
  if (!vals) return null;
  vals.pop(); // the check character
  return valuesToText(vals);
}

/**
 * Split-bar repairs allowed per symbol. A thermal printhead with a dead dot
 * prints a hairline white line down the full height of one bar, at the same
 * place on every label from that printer (floor photos 2026-10-03: a 3-module
 * bar near the check character read as bar 1.3 / gap 1.3 / bar 1.1 on every
 * scanline). When a character fails, the reader rejoins one bar–thin gap–bar
 * triple (or, when the void sat on the bar's edge, moves the lost width back
 * from the neighbouring gap) and carries on; the repaired read still has to balance the mod-103
 * check character and end in a stop pattern and a quiet zone.
 */
const MAX_REPAIRS = 1;
/** Bar-edge erosions tried, in modules. */
const EROSION_STEPS = [0.6, 1.0];

/** Decode characters from element `j` to the stop. Returns start, data…, check, or null. */
function decodeFrom(
  w: Float64Array,
  n: number,
  j: number,
  vals: number[],
  prev: number,
  unit: number,
  repairs: number,
): number[] | null {
  for (;;) {
    if (j + 6 > n) return null;
    // The stop pattern is 7 elements, 13 modules, then the quiet zone. Its
    // two 3-module elements are where uneven print hurts most (floor photos:
    // the 3-module bar measured 2.2, the gap 3.9), so it is recognised by
    // that frame rather than by its widths — once the check character
    // already balances, nothing but a stop can stand there.
    if (vals.length >= 3 && j + 7 <= n && stopLike(w, n, j, prev, unit) && checksumOk(vals)) return vals;
    const v = decodeChar(w, j);
    // Neighbouring characters are printed at the same scale; a big jump
    // means the scanline wandered off the symbol.
    const s = w[j] + w[j + 1] + w[j + 2] + w[j + 3] + w[j + 4] + w[j + 5];
    const ok = v >= 0 && v < START_A && s >= prev * 0.75 && s <= prev * 1.33;
    if (v === STOP) return null; // a stop that stopLike() rejected: no quiet zone or bad shape
    if (!ok) {
      if (repairs <= 0) return null;
      // Rejoin one split bar among this character's (or the stop's) bars.
      for (let t = j; t <= j + 4 && t + 2 < n; t += 2) {
        if (w[t + 1] > unit * 1.6) continue; // a real gap, not a hairline void
        const fixed = new Float64Array(n - 2);
        fixed.set(w.subarray(0, t));
        fixed[t] = w[t] + w[t + 1] + w[t + 2];
        fixed.set(w.subarray(t + 3, n), t + 1);
        const got = decodeFrom(fixed, n - 2, j, vals.slice(), prev, unit, repairs - 1);
        if (got) return got;
      }
      // Or give back an eroded bar edge: the void sat on the bar's edge, so
      // the bar lost some width and the gap beside it gained it.
      for (let t = j; t <= j + 4 && t + 1 < n; t += 2) {
        for (const side of [1, -1]) {
          const g = t + side;
          if (g < j || g >= n) continue;
          for (const d of EROSION_STEPS) {
            const delta = d * unit;
            if (w[g] - delta < unit * 0.5) continue;
            const fixed = w.slice(0, n);
            fixed[t] += delta;
            fixed[g] -= delta;
            const got = decodeFrom(fixed, n, j, vals.slice(), prev, unit, repairs - 1);
            if (got) return got;
          }
        }
      }
      return null;
    }
    prev = s;
    vals.push(v);
    j += 6;
    if (vals.length > 80) return null;
  }
}

/** Stop pattern widths: 2 3 3 1 1 1 2 (13 modules). */
const STOP_E = [5, 6, 4, 2, 2, 3];
/** Quiet zone, in modules, demanded on both sides of the symbol (spec: 10). */
const QUIET = 6;

/**
 * Is there a stop pattern at element `j`: 7 elements, 13 modules at the
 * symbol's scale, every edge-to-edge distance within 0.9 module of
 * 2 3 3 1 1 1 2, and a quiet zone after it? Lenient on the two 3-module
 * elements' split (where uneven print hurts most: floor photos read the
 * 3-module bar as 2.2 and the gap as 3.9), strict on everything a scanline
 * leaving the symbol mid-way would break. (Without the shape test a tilted
 * line that ran off a symbol produced a check-balanced truncated read.)
 */
function stopLike(w: Float64Array, n: number, j: number, prev: number, unit: number): boolean {
  if (j + 7 > n) return false;
  if (j + 7 < n && w[j + 7] < unit * QUIET) return false;
  const s7 = w[j] + w[j + 1] + w[j + 2] + w[j + 3] + w[j + 4] + w[j + 5] + w[j + 6];
  const s13 = prev * (13 / 11);
  if (s7 < s13 * 0.88 || s7 > s13 * 1.12) return false;
  const k = 13 / s7;
  for (let e = 0; e < 6; e++) {
    if (Math.abs((w[j + e] + w[j + e + 1]) * k - STOP_E[e]) > 0.9) return false;
  }
  return true;
}

/** Start, data…, check: does the mod-103 check character balance? */
function checksumOk(vals: number[]): boolean {
  if (vals.length < 3) return false;
  let sum = vals[0];
  for (let k = 1; k < vals.length - 1; k++) sum += k * vals[k];
  return sum % 103 === vals[vals.length - 1];
}

/**
 * Element widths of one grey-level profile. Writes into `w` and returns the
 * element count; `firstDark` says whether element 0 is a bar.
 *
 * Edges come from the profile's own valleys and peaks, not from one
 * threshold: a starved bar at camera resolution is a shallow valley (floor
 * photo: gaps ≈ 120–145, thin bars bottoming out at 77–90, fat bars at ≈ 0),
 * so a single mid-level threshold (≈ 72 there) skips it entirely. Every
 * valley/peak that stands out from its neighbours by `frac` of the local
 * contrast is kept, and each edge is placed where the profile crosses the
 * midpoint of ITS valley and peak. Shifting the level shifts a pair of
 * same-direction edges alike, which the edge-to-edge measure then cancels.
 */
function profileToWidths(
  p: Float64Array,
  n: number,
  w: Float64Array,
  win: number,
  frac: number,
): { count: number; firstDark: boolean } {
  const mx = MX.length >= n ? MX : (MX = new Float64Array(n * 2));
  const mn = MN.length >= n ? MN : (MN = new Float64Array(n * 2));
  slidingExtreme(p, n, win, mx, true);
  slidingExtreme(p, n, win, mn, false);

  // Alternating extremes with hysteresis. ext[] holds positions; a valley is
  // committed once the profile climbs `delta` above it, a peak once it falls
  // `delta` below it.
  const ext = EXT.length >= n ? EXT : (EXT = new Int32Array(n * 2));
  let ne = 0;
  let cand = 0; // index of the running extreme
  let lo = 0; // before the first extreme: running min and max
  let hi = 0;
  let dir = 0; // +1 looking for a peak, -1 looking for a valley, 0 not started
  for (let x = 1; x < n; x++) {
    const delta = Math.max(MIN_DELTA, frac * (mx[x] - mn[x]));
    const v = p[x];
    if (dir === 0) {
      if (v < p[lo]) lo = x;
      if (v > p[hi]) hi = x;
      if (v > p[lo] + delta) {
        ext[ne++] = lo; // rose out of a valley
        cand = x;
        dir = 1;
      } else if (v < p[hi] - delta) {
        ext[ne++] = hi; // fell from a peak
        cand = x;
        dir = -1;
      }
    } else if (dir === 1) {
      if (v > p[cand]) cand = x;
      else if (v < p[cand] - delta) {
        ext[ne++] = cand; // peak
        cand = x;
        dir = -1;
      }
    } else {
      if (v < p[cand]) cand = x;
      else if (v > p[cand] + delta) {
        ext[ne++] = cand; // valley
        cand = x;
        dir = 1;
      }
    }
  }
  // The running extreme at the end of the line is real too: without it the
  // last edge (the far side of the stop pattern's final bar) is lost.
  if (dir !== 0 && ext[ne - 1] !== cand) ext[ne++] = cand;

  // One edge between each neighbouring valley/peak pair.
  let count = 0;
  let prevEdge = -1;
  let firstDark = false;
  for (let k = 0; k + 1 < ne; k++) {
    const a = ext[k];
    const b = ext[k + 1];
    const level = (p[a] + p[b]) / 2;
    const falling = p[a] > p[b]; // peak → valley: a bar begins
    let pos = -1;
    for (let x = a; x < b; x++) {
      const u = p[x] - level;
      const v = p[x + 1] - level;
      if (falling ? u >= 0 && v < 0 : u < 0 && v >= 0) {
        pos = x + u / (u - v);
        break;
      }
    }
    if (pos < 0) continue;
    if (prevEdge >= 0) {
      if (count === 0) firstDark = !falling; // element before a rising edge is a bar
      if (count < w.length) w[count++] = pos - prevEdge;
    }
    prevEdge = pos;
  }
  return { count, firstDark };
}

/**
 * Element widths from the steepest points of the profile (gradient peaks):
 * each edge is where the grey level changes fastest, which a symmetric blur
 * or thin/fat print does not move. A thin bar is a shallow dip but still
 * two clear slopes. Same contract as `profileToWidths`.
 */
export function gradientToWidths(
  p: Float64Array,
  n: number,
  w: Float64Array,
  win: number,
  frac: number,
): { count: number; firstDark: boolean } {
  const g = GBUF.length >= n ? GBUF : (GBUF = new Float64Array(n * 2));
  const ag = AGBUF.length >= n ? AGBUF : (AGBUF = new Float64Array(n * 2));
  g[0] = 0;
  g[n - 1] = 0;
  for (let x = 1; x < n - 1; x++) g[x] = (p[x + 1] - p[x - 1]) / 2;
  for (let x = 0; x < n; x++) ag[x] = Math.abs(g[x]);
  const gmax = MX.length >= n ? MX : (MX = new Float64Array(n * 2));
  slidingExtreme(ag, n, win, gmax, true);

  let count = 0;
  let prevEdge = -1;
  let prevSign = 0;
  let prevMag = 0;
  let firstDark = false;
  for (let x = 1; x < n - 1; x++) {
    const m = ag[x];
    if (m < MIN_GRAD || m < frac * gmax[x]) continue;
    if (m < ag[x - 1] || m < ag[x + 1]) continue; // not a local peak
    if (m === ag[x - 1] && g[x - 1] * g[x] > 0) continue; // plateau: take its first sample only
    const sign = g[x] > 0 ? 1 : -1;
    // Sub-pixel peak: parabola through the three |g| samples.
    const l = ag[x - 1];
    const r = ag[x + 1];
    const den = l - 2 * m + r;
    const pos = x + (den < 0 ? (0.5 * (l - r)) / den : 0);
    if (sign === prevSign) {
      // Two slopes the same way in a row: one is noise — keep the steeper.
      if (m > prevMag) {
        if (count > 0) w[count - 1] += pos - prevEdge;
        prevEdge = pos;
        prevMag = m;
      }
      continue;
    }
    if (prevEdge >= 0) {
      if (count === 0) firstDark = sign > 0; // a rising edge ends a bar
      if (count < w.length) w[count++] = pos - prevEdge;
    }
    prevEdge = pos;
    prevSign = sign;
    prevMag = m;
  }
  return { count, firstDark };
}

/** Smallest grey-level slope (per pixel) that counts as an edge. */
const MIN_GRAD = 4;
let GBUF = new Float64Array(0);
let AGBUF = new Float64Array(0);

/** Grey levels a valley/peak must stand out by, whatever the contrast. */
const MIN_DELTA = 10;

let EXT = new Int32Array(0);
let MX = new Float64Array(0);
let MN = new Float64Array(0);
let DQ = new Int32Array(0);

function slidingExtreme(p: Float64Array, n: number, win: number, out: Float64Array, isMax: boolean) {
  if (DQ.length < n) DQ = new Int32Array(n * 2);
  const dq = DQ;
  let head = 0;
  let tail = 0;
  // Window for x is [x-win, x+win]; push indices up to x+win as x advances.
  let next = 0;
  for (let x = 0; x < n; x++) {
    const hi = Math.min(n - 1, x + win);
    while (next <= hi) {
      const v = p[next];
      while (tail > head && (isMax ? p[dq[tail - 1]] <= v : p[dq[tail - 1]] >= v)) tail--;
      dq[tail++] = next++;
    }
    while (dq[head] < x - win) head++;
    out[x] = p[dq[head]];
  }
}

/** Every symbol on one profile, scanning both directions. */
function decodeProfile(p: Float64Array, n: number, found: Set<string>): void {
  const W = WBUF.length >= n ? WBUF : (WBUF = new Float64Array(n));
  const R = RBUF.length >= n ? RBUF : (RBUF = new Float64Array(n));
  const Q = QBUF.length >= n ? QBUF : (QBUF = new Float64Array(n));
  for (const pass of PASSES) {
    let src = p;
    if (pass.sharpen > 0) {
      // Undo some of the lens blur: a thin bar's dip then reaches nearly the
      // depth of a fat one, so neither is mis-sized relative to the other.
      const a = pass.sharpen;
      Q[0] = p[0];
      Q[n - 1] = p[n - 1];
      for (let x = 1; x < n - 1; x++) Q[x] = p[x] + a * (2 * p[x] - p[x - 1] - p[x + 1]);
      src = Q;
    }
    const { count, firstDark } = (pass.grad ? gradientToWidths : profileToWidths)(src, n, W, 24, pass.frac);
    if (count < 30) continue;
    // Forward: bars sit at even offsets from the first dark element.
    for (let i = firstDark ? 0 : 1; i + 30 <= count; i += 2) {
      const t = decodeAt(W, count, i);
      if (t) {
        found.add(t);
        break;
      }
    }
    // Backward (an upside-down sticker): reverse the widths.
    for (let k = 0; k < count; k++) R[k] = W[count - 1 - k];
    const lastDark = count % 2 === 1 ? firstDark : !firstDark;
    for (let i = lastDark ? 0 : 1; i + 30 <= count; i += 2) {
      const t = decodeAt(R, count, i);
      if (t) {
        found.add(t);
        break;
      }
    }
  }
}

/**
 * Profile passes, tried in order until one reads: `sharpen` = Laplacian
 * sharpening amount (0 = none), `frac` = how far a valley/peak must stand out,
 * as a fraction of the local contrast.
 */
export const PASSES: { sharpen: number; frac: number; grad?: boolean }[] = [
  { sharpen: 0, frac: 0.35 },
  { sharpen: 0, frac: 0.25, grad: true },
];

let WBUF = new Float64Array(0);
let RBUF = new Float64Array(0);
let QBUF = new Float64Array(0);
let PBUF = new Float64Array(0);

/** Options for `scanCode128`. */
export interface ScanOptions {
  /** Pixels between parallel scanlines (default 10 — a sticker's bars are ≥ ~40 px tall in a usable frame). */
  spacing?: number;
  /** Line angles in degrees from horizontal (default 0, ±6, ±12, 90); a few degrees of tilt fit inside each. */
  angles?: number[];
  /** Fraction of the image (centred) the lines cover (default 0.9). */
  span?: number;
  /** Stop after this many distinct symbols (default 1 — the one nearest the centre, which is read first). */
  max?: number;
}

/** One symbol, with how far its scanline ran from the image centre (0..~0.7 of the diagonal). */
export interface Code128Read {
  value: string;
  dist: number;
}

/**
 * Read the Code 128 symbols a fan of scanlines across `img` crosses. Lines
 * run from the centre outwards (where the worker aims), so with the default
 * `max` of 1 the first — nearest-centre — symbol ends the scan early.
 * Each scanline averages three parallel rows, so a speck of dust or a
 * hairline void in one row cannot break a bar.
 */
export function scanCode128(img: ScanImage, opts: ScanOptions = {}): Code128Read[] {
  const { width: iw, height: ih, data } = img;
  const bpp = data.length >= iw * ih * 4 ? 4 : 1;
  const spacing = Math.max(2, opts.spacing ?? 10);
  const angles = opts.angles ?? [0, 6, -6, 12, -12, 90];
  const span = opts.span ?? 0.9;
  const max = opts.max ?? 1;
  const found = new Map<string, number>();
  const cx = iw / 2;
  const cy = ih / 2;
  const diag = Math.hypot(iw, ih) || 1;

  const lum = (x: number, y: number): number => {
    const xi = x < 0 ? 0 : x >= iw ? iw - 1 : x | 0;
    const yi = y < 0 ? 0 : y >= ih ? ih - 1 : y | 0;
    const o = yi * iw + xi;
    if (bpp === 1) return data[o];
    const j = o * 4;
    return (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  };
  const hits = new Set<string>();

  for (const deg of angles) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // Unit normal: lines are offset along it, rows averaged along it.
    const nx = -dy;
    const ny = dx;
    // Line length: the image's extent along the direction.
    const len = Math.floor(Math.abs(dx) * iw + Math.abs(dy) * ih);
    if (len < 60) continue;
    if (PBUF.length < len) PBUF = new Float64Array(len * 2);
    const p = PBUF;
    const half = ((Math.abs(nx) * iw + Math.abs(ny) * ih) * span) / 2;
    // Tilted lines tolerate less bar height, but each covers a tilt band; a
    // coarser step keeps their cost down.
    const step = deg === 0 ? spacing : spacing * 1.5;
    for (let li = 0; li * step <= half * 2; li++) {
      // 0, +s, -s, +2s, -2s, …
      const off = (li % 2 === 1 ? 1 : -1) * Math.ceil(li / 2) * step;
      if (Math.abs(off) > half) continue;
      const ox = cx + nx * off - (dx * len) / 2;
      const oy = cy + ny * off - (dy * len) / 2;
      for (let t = 0; t < len; t++) {
        const x = ox + dx * t;
        const y = oy + dy * t;
        p[t] = (lum(x - nx, y - ny) + lum(x, y) + lum(x + nx, y + ny)) / 3;
      }
      hits.clear();
      decodeProfile(p, len, hits);
      for (const v of hits) {
        if (!found.has(v)) found.set(v, Math.abs(off) / diag);
      }
      if (found.size >= max) return toReads(found);
    }
  }
  return toReads(found);
}

function toReads(found: Map<string, number>): Code128Read[] {
  return [...found].map(([value, dist]) => ({ value, dist })).sort((a, b) => a.dist - b.dist);
}
