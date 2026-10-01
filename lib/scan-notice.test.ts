import { describe, it, expect } from 'vitest';
import {
  shouldSoundDuplicate,
  clearDuplicateSounds,
  findCountedCarton,
  findCountedCartonByDigits,
  canOfferDifferentCarton,
  nearestScrollTop,
  DUPLICATE_QUIET_MS,
} from './scan-notice';

// Carton #8 and #9 of IN264172698 pallet 3 (2026-09-24).
const C8 = '7290002195832012350128430052027';
const C9 = '7290002195832012560130527052027';

describe('shouldSoundDuplicate', () => {
  it('the first re-read sounds', () => {
    expect(shouldSoundDuplicate(new Map(), C8, 1_000)).toBe(true);
  });

  it('a second read of the same barcode within 15 s is silent', () => {
    const last = new Map<string, number>();
    shouldSoundDuplicate(last, C8, 0);
    expect(shouldSoundDuplicate(last, C8, DUPLICATE_QUIET_MS - 1)).toBe(false);
  });

  it('a read after 15 s sounds again', () => {
    const last = new Map<string, number>();
    shouldSoundDuplicate(last, C8, 0);
    expect(shouldSoundDuplicate(last, C8, DUPLICATE_QUIET_MS)).toBe(true);
  });

  it('a camera parked on one sticker stays quiet: every read restarts the window', () => {
    const last = new Map<string, number>();
    expect(shouldSoundDuplicate(last, C8, 0)).toBe(true);
    // #6 on 09-24: six reads at ~3.3 s spacing, 18 s in all.
    for (let t = 3_300; t <= 20_000; t += 3_300) {
      expect(shouldSoundDuplicate(last, C8, t)).toBe(false);
    }
  });

  it('another barcode keeps its own window', () => {
    const last = new Map<string, number>();
    shouldSoundDuplicate(last, C8, 0);
    expect(shouldSoundDuplicate(last, C9, 1_000)).toBe(true);
  });

  it('after a clear() the same barcode sounds again', () => {
    const last = new Map<string, number>();
    shouldSoundDuplicate(last, C8, 0);
    clearDuplicateSounds(last);
    expect(shouldSoundDuplicate(last, C8, 1_000)).toBe(true);
  });

  it('clearing one code (a deleted row) leaves the others quiet', () => {
    const last = new Map<string, number>();
    shouldSoundDuplicate(last, C8, 0);
    shouldSoundDuplicate(last, C9, 0);
    clearDuplicateSounds(last, [C8]);
    expect(shouldSoundDuplicate(last, C8, 1_000)).toBe(true);
    expect(shouldSoundDuplicate(last, C9, 1_000)).toBe(false);
  });
});

describe('findCountedCarton', () => {
  const rows = [
    { barcode: '7290003571123000' },
    { barcode: '2826092400000001', source_barcode: '7290001455258' },
    { barcode: '2826092400000002', source_barcode: '7290001455258' },
    { barcode: C8 },
  ];

  it('names the carton by its 1-based place on the list', () => {
    expect(findCountedCarton(rows, C8)).toEqual({ n: 4, row: rows[3] });
  });

  it('a supplier code an identical batch stands in for points at the batch\'s first row', () => {
    expect(findCountedCarton(rows, '7290001455258')).toEqual({ n: 2, row: rows[1] });
  });

  it('a code on no row → null', () => {
    expect(findCountedCarton(rows, C9)).toBeNull();
  });
});

describe('findCountedCartonByDigits', () => {
  const rows = [
    { barcode: C8 },
    { barcode: C9 },
    { barcode: 'MANUAL-1727190556000-ab12cd' },
  ];

  it('names the carton the photo actually shows (#9, not an earlier duplicate)', () => {
    expect(findCountedCartonByDigits(rows, C9, 'MANUAL-1727190556000-ab12cd')?.n).toBe(2);
  });

  it('never matches the capture\'s own provisional row', () => {
    const own = 'MANUAL-1727190556000-ab12cd';
    expect(findCountedCartonByDigits(rows, own.replace(/\D/g, ''), own)).toBeNull();
  });

  it('compares the full printed number, not the 13-digit SKU', () => {
    expect(findCountedCartonByDigits(rows, C8.slice(0, 13))).toBeNull();
  });

  it('empty digits → null', () => {
    expect(findCountedCartonByDigits(rows, '')).toBeNull();
  });
});

describe('canOfferDifferentCarton', () => {
  it('a supplier barcode on a read carton → offered', () => {
    expect(canOfferDifferentCarton(C8, { ocr_status: 'done' })).toBe(true);
    expect(canOfferDifferentCarton(C8, { ocr_status: 'failed' })).toBe(true);
  });

  it('a warehouse 28… label is unique per carton → never offered', () => {
    expect(canOfferDifferentCarton('2826100100000001', { ocr_status: 'done' })).toBe(false);
  });

  it('not a barcode (provisional / no-barcode marker) → never offered', () => {
    expect(canOfferDifferentCarton('MANUAL-1727190556000-ab12cd', { ocr_status: 'done' })).toBe(false);
    expect(canOfferDifferentCarton('NOBC-IN264172-P3-1', { ocr_status: 'done' })).toBe(false);
  });

  it('the counted row still in OCR → not yet (nothing to copy)', () => {
    expect(canOfferDifferentCarton(C8, { ocr_status: 'processing' })).toBe(false);
  });
});

describe('nearestScrollTop', () => {
  // A 400 px list showing content 0–400; rows are 60 px tall.
  it('a row already in view → no scroll', () => {
    expect(nearestScrollTop(120, 60, 0, 400)).toBeNull();
  });

  it('a row below the view → scroll just enough to show its bottom', () => {
    expect(nearestScrollTop(500, 60, 0, 400)).toBe(160);
  });

  it('a row above the view → scroll to its top', () => {
    expect(nearestScrollTop(60, 60, 300, 400)).toBe(60);
  });

  it('a collapsed sheet (list shorter than two rows) → leave it alone', () => {
    expect(nearestScrollTop(500, 60, 0, 100)).toBeNull();
  });
});
