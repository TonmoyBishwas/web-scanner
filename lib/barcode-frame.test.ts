import { describe, it, expect } from 'vitest';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { encodeCode128 } from './code128';
import { thickenBars, orderReads, ReadConfirmer, nextPass, type PixelBuffer } from './barcode-frame';

/**
 * Render a Code 128 sticker the way the 2026-10-03 floor photos show it:
 * 3.5 px per module, every dark bar printed `loss` px narrower than nominal
 * (the gap widens by the same amount), anti-aliased, grey ink on a light
 * label, optionally with a `voidPx`-wide white void through the middle of the
 * `voidInBar`-th bar that is ≥ 3 modules wide.
 */
function renderSticker(text: string, opts: { loss: number; voidInBar?: number; voidPx?: number }): PixelBuffer {
  const widths = encodeCode128(text)!;
  const mod = 3.5;
  const quiet = 40;
  const total = widths.reduce((a, b) => a + b, 0) * mod;
  const w = Math.ceil(total + 2 * quiet);
  const h = 60;
  // Coverage (0..1 dark) of each column, from the analytic bar edges.
  const cover = new Float64Array(w);
  let x = quiet;
  let wideBars = 0;
  const voids: number[] = [];
  widths.forEach((m, i) => {
    const span = m * mod;
    if (i % 2 === 0 && m >= 3 && wideBars++ === opts.voidInBar) voids.push(Math.round(x + span / 2));
    if (i % 2 === 0) {
      const a = x + opts.loss / 2;
      const b = x + span - opts.loss / 2;
      for (let px = Math.floor(a); px < Math.ceil(b); px++) {
        cover[px] += Math.max(0, Math.min(b, px + 1) - Math.max(a, px));
      }
    }
    x += span;
  });
  for (const c of voids) {
    for (let k = 0; k < (opts.voidPx ?? 1); k++) cover[c + k] = 0;
  }
  const data = new Uint8ClampedArray(w * h * 4);
  const paper = 200;
  const ink = 30;
  for (let y = 0; y < h; y++) {
    for (let px = 0; px < w; px++) {
      const v = Math.round(paper - (paper - ink) * Math.min(1, cover[px]));
      const j = (y * w + px) * 4;
      data[j] = v;
      data[j + 1] = v;
      data[j + 2] = v;
      data[j + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function zxingRead(img: PixelBuffer): string | null {
  const lum = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < lum.length; i++) lum[i] = img.data[i * 4];
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  try {
    const src = new RGBLuminanceSource(lum, img.width, img.height);
    return reader.decode(new BinaryBitmap(new HybridBinarizer(src))).getText();
  } catch {
    return null;
  }
}

// The real "item C" sticker payload (פרגית קפוא, 12.27 kg, best before 30/05/2027).
const ITEM_C = '7290002195832012270127630052027';

describe('thickenBars', () => {
  it('grows a 1-px dark line to 3 px and leaves alpha alone', () => {
    const w = 7;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      const j = (y * w + 3) * 4;
      data[j] = data[j + 1] = data[j + 2] = 0;
    }
    const img = { data, width: w, height: h };
    thickenBars(img);
    const row = Array.from({ length: w }, (_, x) => data[(1 * w + x) * 4]);
    expect(row).toEqual([255, 255, 0, 0, 0, 255, 255]);
    expect(data[3]).toBe(255);
  });

  it('closes a hairline white void inside a bar', () => {
    const w = 5;
    const data = new Uint8ClampedArray(w * 4).fill(255);
    [0, 0, 255, 0, 0].forEach((v, x) => {
      data[x * 4] = data[x * 4 + 1] = data[x * 4 + 2] = v;
    });
    thickenBars({ data, width: w, height: 1 });
    expect(Array.from({ length: w }, (_, x) => data[x * 4])).toEqual([0, 0, 0, 0, 0]);
  });

  it('reuses the scratch buffer it is given', () => {
    const scratch = new Uint8Array(2 * 4 * 4);
    const img = { data: new Uint8ClampedArray(4 * 4 * 4).fill(128), width: 4, height: 4 };
    expect(thickenBars(img, scratch)).toBe(scratch);
  });

  it('makes a starved-bar sticker decodable that is unreadable raw (floor regression)', () => {
    const sticker = renderSticker(ITEM_C, { loss: 1.6 });
    expect(zxingRead(sticker)).toBeNull();
    thickenBars(sticker);
    expect(zxingRead(sticker)).toBe(ITEM_C);
  });

  it('starved bars plus a hairline void through a bar (the 1.58.08 photo)', () => {
    const voided = renderSticker(ITEM_C, { loss: 1.2, voidInBar: 2, voidPx: 1 });
    expect(zxingRead(voided)).toBeNull();
    thickenBars(voided);
    expect(zxingRead(voided)).toBe(ITEM_C);
  });

  it('a well-printed sticker still reads on the raw pass (why the loop alternates)', () => {
    expect(zxingRead(renderSticker(ITEM_C, { loss: 0 }))).toBe(ITEM_C);
  });
});

describe('orderReads', () => {
  it('puts the barcode nearest the centre first and drops blanks/repeats', () => {
    expect(
      orderReads([
        { value: 'B', dist: 0.4 },
        { value: '', dist: 0 },
        { value: 'A', dist: 0.1 },
        { value: 'B', dist: 0.3 },
      ]),
    ).toEqual([
      { value: 'A', dist: 0.1 },
      { value: 'B', dist: 0.3 },
    ]);
  });
});

describe('ReadConfirmer', () => {
  it('confirms on the second identical read within the window', () => {
    const c = new ReadConfirmer();
    expect(c.add([{ value: 'A', dist: 0 }], 0)).toEqual({ confirmed: null, progress: 1 });
    expect(c.add([{ value: 'A', dist: 0 }], 500)).toEqual({ confirmed: 'A', progress: 0 });
  });

  it('does not let an interleaved second label reset the first (floor regression)', () => {
    // Old rule: A, B, A, B … never confirmed anything.
    const c = new ReadConfirmer();
    expect(c.add([{ value: 'A', dist: 0.1 }], 0).confirmed).toBeNull();
    expect(c.add([{ value: 'B', dist: 0.5 }], 100).confirmed).toBeNull();
    expect(c.add([{ value: 'A', dist: 0.1 }], 200).confirmed).toBe('A');
  });

  it('when two labels confirm on the same frame, the centred one wins', () => {
    const c = new ReadConfirmer();
    c.add([{ value: 'EDGE', dist: 0.6 }, { value: 'AIMED', dist: 0.05 }], 0);
    const r = c.add([{ value: 'EDGE', dist: 0.6 }, { value: 'AIMED', dist: 0.05 }], 100);
    expect(r.confirmed).toBe('AIMED');
  });

  it('a read after the window starts that value over', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([{ value: 'A', dist: 0 }], 0);
    expect(c.add([{ value: 'A', dist: 0 }], 3500)).toEqual({ confirmed: null, progress: 1 });
    expect(c.add([{ value: 'A', dist: 0 }], 3600).confirmed).toBe('A');
  });

  it('empty frames keep progress; a confirmation clears everything', () => {
    const c = new ReadConfirmer();
    c.add([{ value: 'A', dist: 0 }, { value: 'B', dist: 0.3 }], 0);
    expect(c.add([], 50)).toEqual({ confirmed: null, progress: 1 });
    expect(c.add([{ value: 'A', dist: 0 }], 100).confirmed).toBe('A');
    expect(c.add([{ value: 'B', dist: 0.3 }], 150)).toEqual({ confirmed: null, progress: 1 });
  });
});

describe('nextPass', () => {
  it('keeps a pass that read something', () => {
    expect(nextPass('raw', true)).toBe('raw');
    expect(nextPass('thick', true)).toBe('thick');
    expect(nextPass('thickSmall', true)).toBe('thickSmall');
  });

  it('cycles raw → thick → thickSmall → raw while nothing reads', () => {
    expect(nextPass('raw', false)).toBe('thick');
    expect(nextPass('thick', false)).toBe('thickSmall');
    expect(nextPass('thickSmall', false)).toBe('raw');
  });
});
