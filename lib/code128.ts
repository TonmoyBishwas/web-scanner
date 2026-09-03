/**
 * Minimal Code 128 encoder — turns a string into the bar/space module widths
 * a renderer can draw.
 *
 * Why hand-rolled: the scanner ships no barcode *writer* (@zxing/browser is a
 * reader only), and a warehouse-minted carton sticker has to carry a barcode
 * the same cameras can read back. Code 128 is what the supplier GS1-128
 * stickers already use, so the existing BarcodeDetector / ZXing paths decode
 * it with no configuration.
 *
 * Scope is deliberately narrow: subset C for digit pairs (half the bars for a
 * numeric payload) with a switch to subset B for anything else. That covers
 * every barcode this app mints — `mintCartonBarcode` emits 16 digits.
 */

/**
 * The 107 Code 128 symbol patterns, indexed by symbol value. Each entry is the
 * run-length sequence bar,space,bar,space,bar,space (11 modules); value 106 is
 * the 13-module stop pattern, which carries a trailing bar.
 */
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
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const START_C = 105;
const CODE_B = 100; // switch to subset B (when read from subset C)
const CODE_C = 99;  // switch to subset C (when read from subset B)
const STOP = 106;

/** How many digits start at `i`. Used to decide when subset C pays off. */
function digitRunLength(text: string, i: number): number {
  let n = 0;
  while (i + n < text.length && text[i + n] >= '0' && text[i + n] <= '9') n++;
  return n;
}

/**
 * Encode `text` into Code 128 symbol values, including start symbol, checksum
 * and stop. Returns null when the text contains a character subset B cannot
 * represent (outside ASCII 32–126).
 */
export function encodeCode128Values(text: string): number[] | null {
  if (!text) return null;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) return null;
  }

  const values: number[] = [];
  // Subset C is worth starting in when the payload opens with 4+ digits (or is
  // an all-digit even-length string) — the same rule the spec recommends.
  const leadDigits = digitRunLength(text, 0);
  let inC = leadDigits >= 4 || (leadDigits === text.length && text.length % 2 === 0);
  values.push(inC ? START_C : START_B);

  let i = 0;
  while (i < text.length) {
    if (inC) {
      const run = digitRunLength(text, i);
      // Subset C consumes digits two at a time; an odd tail (or a non-digit)
      // means dropping back to B.
      if (run >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE_B);
      inC = false;
      continue;
    }

    const run = digitRunLength(text, i);
    // Only switch into C for a long enough even run to pay back the switch symbol.
    if (run >= 6 && run % 2 === 0) {
      values.push(CODE_C);
      inC = true;
      continue;
    }
    values.push(text.charCodeAt(i) - 32);
    i += 1;
  }

  // Checksum: start value plus each payload symbol weighted by its 1-based
  // position, modulo 103.
  let sum = values[0];
  for (let p = 1; p < values.length; p++) sum += values[p] * p;
  values.push(sum % 103);
  values.push(STOP);

  return values;
}

/**
 * Encode `text` into alternating bar/space module widths, starting with a bar
 * and ending with the stop pattern's trailing bar. Null when unencodable.
 */
export function encodeCode128(text: string): number[] | null {
  const values = encodeCode128Values(text);
  if (!values) return null;

  const widths: number[] = [];
  for (const v of values) {
    for (const ch of PATTERNS[v]) widths.push(Number(ch));
  }
  // Quiet zones are the renderer's job (it has the pixel budget), not ours.
  return widths;
}

/** Total module count of the encoded symbol — the renderer's width unit. */
export function code128ModuleCount(widths: number[]): number {
  return widths.reduce((a, b) => a + b, 0);
}
