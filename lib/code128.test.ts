import { describe, expect, it } from 'vitest';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { encodeCode128, encodeCode128Values, code128ModuleCount } from './code128';

/**
 * The symbol values are checked against hand-computed Code 128 sequences —
 * a wrong checksum or subset switch produces a barcode that renders fine and
 * simply never decodes, which is exactly the failure a printed sticker must
 * not have.
 */
describe('encodeCode128Values', () => {
  it('encodes an even all-digit payload in subset C with the right checksum', () => {
    // Start C(105), then digit pairs 12 34 56 78.
    // check = (105 + 12*1 + 34*2 + 56*3 + 78*4) % 103 = 665 % 103 = 47
    expect(encodeCode128Values('12345678')).toEqual([105, 12, 34, 56, 78, 47, 106]);
  });

  it('encodes a short text payload in subset B', () => {
    // Start B(104), 'A'=33, 'B'=34; check = (104 + 33 + 34*2) % 103 = 205 % 103 = 102
    expect(encodeCode128Values('AB')).toEqual([104, 33, 34, 102, 106]);
  });

  it('drops from subset C to B for an odd digit tail', () => {
    const v = encodeCode128Values('1234567');
    expect(v?.slice(0, 5)).toEqual([105, 12, 34, 56, 100]);
    // '7' in subset B is charCode 55 − 32 = 23; then checksum and stop.
    expect(v?.[5]).toBe(23);
    expect(v?.[v.length - 1]).toBe(106);
  });

  it('rejects characters outside the printable ASCII range', () => {
    expect(encodeCode128Values('קרטון')).toBeNull();
    expect(encodeCode128Values('')).toBeNull();
  });
});

describe('encodeCode128', () => {
  it('emits 11 modules per symbol plus the 13-module stop', () => {
    const widths = encodeCode128('12345678');
    expect(widths).not.toBeNull();
    // 6 symbols of 11 modules (start, 4 pairs, checksum) + 13 for the stop.
    expect(code128ModuleCount(widths!)).toBe(6 * 11 + 13);
  });

  it('starts and ends on a bar', () => {
    const widths = encodeCode128('280903000000000')!;
    // Alternation begins with a bar, and the stop pattern's 7 runs leave the
    // final element a bar — an even-length array would mean it ends on a space.
    expect(widths.length % 2).toBe(1);
  });

  it('encodes the 16-digit barcodes this app mints', () => {
    const widths = encodeCode128('2826090312345678')!;
    // Start C + 8 pairs + checksum = 10 symbols, then the stop.
    expect(code128ModuleCount(widths)).toBe(10 * 11 + 13);
  });
});

/**
 * The encoder's real contract is not "produces plausible bars" — it is "a
 * camera reads back exactly what we minted". These render the bars into a
 * luminance bitmap and decode them with ZXing, the same library the scanner
 * falls back to in the browser.
 */
describe('round-trip through a real Code 128 decoder', () => {
  function decode(text: string, scale = 3): string {
    const widths = encodeCode128(text)!;
    const quiet = 12;
    const modules = code128ModuleCount(widths) + quiet * 2;
    const w = modules * scale;
    const h = 40;
    // RGBLuminanceSource treats a Uint8ClampedArray as one luminance byte per
    // pixel (an RGBA buffer silently decodes as noise).
    const lum = new Uint8ClampedArray(w * h).fill(255);
    let x = quiet;
    widths.forEach((run, i) => {
      if (i % 2 === 0) {
        for (let m = 0; m < run * scale; m++) {
          const px = x * scale + m;
          for (let y = 0; y < h; y++) lum[y * w + px] = 0;
        }
      }
      x += run;
    });
    const reader = new MultiFormatReader();
    reader.setHints(new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]]]));
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, h)));
    return reader.decode(bitmap).getText();
  }

  it.each([
    '2826090312982430', // a minted carton barcode
    '2800000000000000', // the preview placeholder
    '12345678',         // pure subset C
    '1234567',          // odd tail: subset C then B
    'C-260903-GN81',    // a serial, i.e. the subset-B path
  ])('decodes %s back to itself', value => {
    expect(decode(value)).toBe(value);
  });
});
