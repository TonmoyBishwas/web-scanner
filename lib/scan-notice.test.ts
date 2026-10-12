import { describe, it, expect } from 'vitest';
import {
  shouldSoundDuplicate,
  clearDuplicateSounds,
  findCountedCarton,
  findCountedCartonByDigits,
  canOfferDifferentCarton,
  differentCartonOffer,
  isBatchStandIn,
  standInCount,
  scanNoticeMs,
  nearestScrollTop,
  DUPLICATE_QUIET_MS,
  SCAN_NOTICE_MS,
  SCAN_NOTICE_ACTION_MS,
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

  it('a label an identical batch stands in for points at the batch\'s first row, like a bar-scan', () => {
    const batched = [
      { barcode: C8 },
      { barcode: '2826092400000001', source_barcode: C9 },
      { barcode: '2826092400000002', source_barcode: C9 },
      { barcode: 'MANUAL-1727190556000-ab12cd' },
    ];
    expect(findCountedCartonByDigits(batched, C9, 'MANUAL-1727190556000-ab12cd')).toEqual({ n: 2, row: batched[1] });
    expect(findCountedCartonByDigits(batched, C9)?.n).toBe(findCountedCarton(batched, C9)?.n);
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

  it('the supplier code of an identical batch → never offered (every carton carrying it is declared)', () => {
    const minted = { barcode: '2826100100000001', source_barcode: C8, minted: true, ocr_status: 'done' };
    expect(canOfferDifferentCarton(C8, minted)).toBe(false);
  });

  it('a plain counted carton that also has a "Different carton?" sibling → still offered', () => {
    expect(canOfferDifferentCarton(C8, { barcode: C8, ocr_status: 'done' })).toBe(true);
  });
});

describe('differentCartonOffer (S1, David 2026-10-11)', () => {
  // Baladi stroganoff IN264185622: 15.26 kg net, no serial — two cartons of
  // 15.26 kg print byte-identical codes.
  const STROGANOFF = '7290003570867015260157527072027';

  it('a 31-digit weight-bearing code → one-tap twin with the barcode\'s net weight', () => {
    expect(differentCartonOffer(STROGANOFF, { barcode: STROGANOFF, ocr_status: 'done' }))
      .toEqual({ quick: true, weight: 15.26 });
    expect(differentCartonOffer(C8, { barcode: C8, ocr_status: 'failed' }))
      .toEqual({ quick: true, weight: 12.35 });
  });

  it('a code with no parseable weight → today\'s "Different carton?" form', () => {
    expect(differentCartonOffer('7290004456825', { barcode: '7290004456825', ocr_status: 'done' }))
      .toEqual({ quick: false });
    // 30-digit Sokołów carton code: not the measured 31-digit format.
    expect(differentCartonOffer('388432467020926171026048702036', { ocr_status: 'done' }))
      .toEqual({ quick: false });
  });

  it('a 31-digit code whose weight field is out of band → the form, never a made-up weight', () => {
    // 000300 g = 0.3 kg: below parseCartonBarcode's 0.5 kg floor.
    const light = '7290003570867000300157527072027';
    expect(differentCartonOffer(light, { ocr_status: 'done' })).toEqual({ quick: false });
  });

  it('nothing offered wherever canOfferDifferentCarton says no', () => {
    expect(differentCartonOffer(STROGANOFF, { ocr_status: 'processing' })).toBeNull();
    expect(differentCartonOffer('2826100100000001', { ocr_status: 'done' })).toBeNull();
    expect(differentCartonOffer('MANUAL-1727190556000-ab12cd', { ocr_status: 'done' })).toBeNull();
    const minted = { barcode: '2826100100000001', source_barcode: STROGANOFF, minted: true, ocr_status: 'done' };
    expect(differentCartonOffer(STROGANOFF, minted)).toBeNull();
  });

  it('agrees with canOfferDifferentCarton on whether anything is offered', () => {
    const cases: Array<[string, { ocr_status?: string; barcode?: string }]> = [
      [C8, { ocr_status: 'done' }],
      [C9, { ocr_status: 'processing' }],
      ['7290004456825', { ocr_status: 'done' }],
      ['NOBC-IN264172-P3-1', { ocr_status: 'done' }],
    ];
    for (const [code, row] of cases) {
      expect(differentCartonOffer(code, row) !== null).toBe(canOfferDifferentCarton(code, row));
    }
  });
});

describe('isBatchStandIn / standInCount', () => {
  const rows = [
    { barcode: C9 },
    { barcode: '2826100100000001', source_barcode: C8, minted: true },
    { barcode: '2826100100000002', source_barcode: C8, minted: true },
    { barcode: '2826100100000003', source_barcode: C8, minted: true },
  ];

  it('a minted row standing in for the code just read → stand-in', () => {
    expect(isBatchStandIn(C8, rows[1])).toBe(true);
  });

  it('the hit findCountedCarton returns for a batch\'s supplier code is a stand-in', () => {
    const hit = findCountedCarton(rows, C8);
    expect(hit && isBatchStandIn(C8, hit.row)).toBe(true);
  });

  it('a photo\'s printed digits match the same way', () => {
    const hit = findCountedCartonByDigits(rows, C8);
    expect(hit && isBatchStandIn(C8, hit.row)).toBe(true);
  });

  it('a re-read of the minted label itself is that carton, not a stand-in', () => {
    expect(isBatchStandIn('2826100100000001', rows[1])).toBe(false);
  });

  it('a plain carton, or a minted row for another code → not a stand-in', () => {
    expect(isBatchStandIn(C9, rows[0])).toBe(false);
    expect(isBatchStandIn(C9, rows[1])).toBe(false);
    expect(isBatchStandIn('', rows[1])).toBe(false);
  });

  it('standInCount is the number of labels the batch saved', () => {
    expect(standInCount(rows, C8)).toBe(3);
    expect(standInCount(rows, C9)).toBe(0);
  });
});

describe('scanNoticeMs', () => {
  it('a notice with an action stays up twice as long', () => {
    expect(scanNoticeMs({})).toBe(SCAN_NOTICE_MS);
    expect(scanNoticeMs({ different: { n: 3 } })).toBe(SCAN_NOTICE_ACTION_MS);
    // The one-tap twin button is an action too: never shorter than the link.
    expect(scanNoticeMs({ different: { n: 3, quickWeight: 15.26 } })).toBe(SCAN_NOTICE_ACTION_MS);
    expect(SCAN_NOTICE_ACTION_MS).toBeGreaterThan(SCAN_NOTICE_MS);
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
