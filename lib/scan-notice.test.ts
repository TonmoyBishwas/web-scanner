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
  twinCount,
  noteTwinHoldRead,
  TWIN_REARM_GAP_MS,
  type TwinHold,
  DUPLICATE_QUIET_MS,
  SCAN_NOTICE_MS,
  SCAN_NOTICE_ACTION_MS,
  SHORT_NOTICE_QUIET_MS,
  shouldExplainShortRead,
  sameLabelOnList,
  listedNoticeKey,
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

  it('a short per-carton serial (Wall Dan 408274) is that carton → never offered', () => {
    expect(canOfferDifferentCarton('408274', { ocr_status: 'done' })).toBe(false);
    expect(canOfferDifferentCarton('15928481', { ocr_status: 'done' })).toBe(false);
    expect(differentCartonOffer('408274', { ocr_status: 'done' })).toBeNull();
    expect(listedNoticeKey('408274', { ocr_status: 'done' }, { photo: true, twins: 0 })).toBe('terminal.alreadyListed');
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

describe('twin rows (one more carton, same label) are not a batch', () => {
  // Stroganoff: original A (code X) rescanned AFTER a one-tap twin was added,
  // so the twin now sits ahead of A on the list.
  const X = '7290003570867015260157527072027';
  const rows = [
    { barcode: C9 },
    { barcode: '2826101100000001', source_barcode: X, minted: true, twin: true },
    { barcode: X },
  ];

  it('findCountedCarton names the row carrying the code itself, not the twin ahead of it', () => {
    expect(findCountedCarton(rows, X)).toEqual({ n: 3, row: rows[2] });
  });

  it('findCountedCartonByDigits does the same for a photo', () => {
    expect(findCountedCartonByDigits(rows, X)).toEqual({ n: 3, row: rows[2] });
  });

  it('a twin row is never a batch stand-in, so the twin button stays on offer', () => {
    expect(isBatchStandIn(X, rows[1])).toBe(false);
    expect(standInCount(rows, X)).toBe(0);
    expect(differentCartonOffer(X, { ...rows[1], ocr_status: 'done' })).toEqual({ quick: true, weight: 15.26 });
  });

  it('even when only twins of the code are left, the hit still offers the twin button', () => {
    const onlyTwins = rows.slice(0, 2);
    const hit = findCountedCarton(onlyTwins, X);
    expect(hit?.n).toBe(2);
    expect(differentCartonOffer(X, { ...hit!.row, ocr_status: 'done' })).toEqual({ quick: true, weight: 15.26 });
  });

  it('twinCount counts the twins of a code only', () => {
    expect(twinCount(rows, X)).toBe(1);
    expect(twinCount(rows, C9)).toBe(0);
    // A real batch row is not a twin.
    expect(twinCount([{ barcode: '2826100100000001', source_barcode: X, minted: true }], X)).toBe(0);
  });
});

describe('noteTwinHoldRead (no second one-tap from a parked camera)', () => {
  const X = '7290003570867015260157527072027';

  it('no hold → never held', () => {
    expect(noteTwinHoldRead({ current: null }, X, 0)).toBe(false);
  });

  it('a camera parked on the sticker (re-read every ~3.3 s) stays held however long it sits', () => {
    const hold: { current: TwinHold | null } = { current: { code: X, lastRead: 0 } };
    for (let t = 3_300; t <= 30_000; t += 3_300) {
      expect(noteTwinHoldRead(hold, X, t)).toBe(true);
    }
  });

  it('the code unread for the gap → released', () => {
    const hold: { current: TwinHold | null } = { current: { code: X, lastRead: 0 } };
    expect(noteTwinHoldRead(hold, X, TWIN_REARM_GAP_MS)).toBe(false);
    expect(hold.current).toBeNull();
  });

  it('a different code read → released, and the code is offered again next time', () => {
    const hold: { current: TwinHold | null } = { current: { code: X, lastRead: 0 } };
    expect(noteTwinHoldRead(hold, C9, 1_000)).toBe(false);
    expect(noteTwinHoldRead(hold, X, 2_000)).toBe(false);
  });

  it('the gap is longer than the parked re-read cadence', () => {
    expect(TWIN_REARM_GAP_MS).toBeGreaterThan(3_300);
  });
});

describe('scanNoticeMs', () => {
  it('a notice with only an action stays up twice as long', () => {
    expect(scanNoticeMs({})).toBe(SCAN_NOTICE_MS);
    expect(scanNoticeMs({ newCarton: { label: 'x' } })).toBe(SCAN_NOTICE_ACTION_MS);
    expect(SCAN_NOTICE_ACTION_MS).toBeGreaterThan(SCAN_NOTICE_MS);
  });

  it('a notice that asks a question stays until answered (19/10)', () => {
    expect(scanNoticeMs({ different: { n: 3 } })).toBeNull();
    expect(scanNoticeMs({ different: { n: 3, quickWeight: 15.26 } })).toBeNull();
    expect(scanNoticeMs({ short: true, newCarton: { label: 'x' } })).toBeNull();
  });

  it('after "Same carton" the re-read notice keeps only the twin way in, and times out', () => {
    // Never silent (a real twin read in that window still gets a way in),
    // never stuck on screen while the camera stays parked on the carton.
    expect(scanNoticeMs({ different: { n: 3, sameAnswered: true } })).toBe(SCAN_NOTICE_ACTION_MS);
  });
});

describe('shouldExplainShortRead (document 48429: 406243 every 3 s)', () => {
  it('the first short read is explained', () => {
    expect(shouldExplainShortRead(new Map(), '406243', 1_000)).toBe(true);
  });

  it('the same code inside a minute is not explained again', () => {
    const last = new Map<string, number>();
    shouldExplainShortRead(last, '406243', 0);
    expect(shouldExplainShortRead(last, '406243', 3_300)).toBe(false);
    expect(shouldExplainShortRead(last, '406243', SHORT_NOTICE_QUIET_MS - 1)).toBe(false);
  });

  it('the window is fixed, not sliding: a parked camera hears again after a minute', () => {
    const last = new Map<string, number>();
    shouldExplainShortRead(last, '406243', 0);
    for (let t = 3_300; t < SHORT_NOTICE_QUIET_MS; t += 3_300) shouldExplainShortRead(last, '406243', t);
    expect(shouldExplainShortRead(last, '406243', SHORT_NOTICE_QUIET_MS)).toBe(true);
  });

  it("another carton's short code is explained at once", () => {
    const last = new Map<string, number>();
    shouldExplainShortRead(last, '406243', 0);
    expect(shouldExplainShortRead(last, '405589', 3_300)).toBe(true);
  });
});

describe('sameLabelOnList', () => {
  it('the carton itself plus its twins', () => {
    const rows = [
      { barcode: C8 },
      { barcode: C9 },
      { barcode: '2826101900000011', minted: true, twin: true, source_barcode: C8 },
      { barcode: '2826101900000012', minted: true, twin: true, source_barcode: C8 },
      // A batch standing in for C8 is not "this label on the list" per carton.
      { barcode: '2826101900000013', minted: true, source_barcode: C8 },
    ];
    expect(sameLabelOnList(rows, C8)).toBe(3);
    expect(sameLabelOnList(rows, C9)).toBe(1);
    expect(sameLabelOnList(rows, '')).toBe(0);
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

describe('listedNoticeKey (ask, never "scan the next carton", 19/10)', () => {
  const done = { barcode: C8, ocr_status: 'done' };
  it('a supplier code that can have twins asks same-or-another', () => {
    expect(listedNoticeKey(C8, done, { photo: false, twins: 0 })).toBe('terminal.alreadyCounted');
    expect(listedNoticeKey(C8, done, { photo: true, twins: 0 })).toBe('terminal.photoAlreadyCounted');
    expect(listedNoticeKey(C8, done, { photo: false, twins: 2 })).toBe('terminal.alreadyCountedPlusTwins');
  });

  it('a 13-digit EAN asks too (the kebab twins of IN264191356)', () => {
    expect(listedNoticeKey('7290004456856', { barcode: '7290004456856', ocr_status: 'done' }, { photo: false, twins: 0 }))
      .toBe('terminal.alreadyCounted');
  });

  it('our own printed label only says where it is', () => {
    expect(listedNoticeKey('2826101900000011', { barcode: '2826101900000011', minted: true }, { photo: false, twins: 0 }))
      .toBe('terminal.ownLabelListed');
  });

  it('a carton still being read says scan again in a moment', () => {
    expect(listedNoticeKey(C8, { barcode: C8, ocr_status: 'processing' }, { photo: false, twins: 0 }))
      .toBe('terminal.alreadyListedReading');
  });

  it('no row found → plain "already on the list"', () => {
    expect(listedNoticeKey(C8, null, { photo: false, twins: 0 })).toBe('terminal.alreadyListed');
  });
});
