import { describe, it, expect } from 'vitest';
import {
  freeNoBarcodeId, isNoBarcodeId, isProvisionalId, noBarcodeId, provisionalAtBooking, unreadDigitsOutcome,
} from './no-barcode';

describe('no-barcode marker', () => {
  it('is visibly not a barcode and keeps the existing shape', () => {
    expect(noBarcodeId('IN264171048', 1, 3)).toBe('NOBC-IN26417104-P1-3');
    expect(noBarcodeId('', 2, 1)).toBe('NOBC-DOC-P2-1');
    expect(isNoBarcodeId('NOBC-IN26417104-P1-3')).toBe(true);
    expect(isNoBarcodeId('7290004456825')).toBe(false);
    expect(isNoBarcodeId('MANUAL-1-abc')).toBe(false);
    expect(isNoBarcodeId(undefined)).toBe(false);
  });

  it('never reuses a marker already on the list', () => {
    const taken = ['7290004456825', noBarcodeId('D1', 1, 2), noBarcodeId('D1', 1, 3)];
    expect(freeNoBarcodeId('D1', 1, 2, taken)).toBe('NOBC-D1-P1-4');
    expect(freeNoBarcodeId('D1', 1, 1, taken)).toBe('NOBC-D1-P1-1');
    expect(freeNoBarcodeId('D1', 2, 2, taken)).toBe('NOBC-D1-P2-2');
  });
});

describe('unreadDigitsOutcome (BOT-32)', () => {
  it('books a carton whose name and weight were read', () => {
    expect(unreadDigitsOutcome({ nameHebrew: 'קבבונים', weightKg: 8 })).toBe('book_without_barcode');
    expect(unreadDigitsOutcome({ nameEnglish: 'Kebab', weightKg: 0.5 })).toBe('book_without_barcode');
  });
  it('holds it when the name or the weight is missing', () => {
    expect(unreadDigitsOutcome({ nameHebrew: '  ', weightKg: 8 })).toBe('review');
    expect(unreadDigitsOutcome({ nameHebrew: 'קבבונים', weightKg: 0 })).toBe('review');
    expect(unreadDigitsOutcome({ nameHebrew: 'קבבונים', weightKg: null })).toBe('review');
    expect(unreadDigitsOutcome({})).toBe('review');
  });
});

describe('unreadDigitsOutcome under manual_capture_review (04/11)', () => {
  it('holds a named, weighed capture with no digits instead of booking it NOBC-', () => {
    // Asher Shachar 10:03:52: name read, OCR weight 1 kg, no digits — booked
    // as NOBC- with no gate. With the flag on it is held.
    expect(unreadDigitsOutcome({ nameHebrew: 'שניצל', weightKg: 1 }, { holdForReview: true })).toBe('held_no_digits');
    expect(unreadDigitsOutcome({ nameEnglish: 'Kebab', weightKg: 8 }, { holdForReview: true })).toBe('held_no_digits');
  });
  it('a capture missing a name or weight is plain review either way', () => {
    expect(unreadDigitsOutcome({ nameHebrew: '', weightKg: 1 }, { holdForReview: true })).toBe('review');
    expect(unreadDigitsOutcome({ nameHebrew: 'שניצל', weightKg: 0 }, { holdForReview: true })).toBe('review');
  });
  it('flag off is today exactly', () => {
    expect(unreadDigitsOutcome({ nameHebrew: 'שניצל', weightKg: 1 }, { holdForReview: false })).toBe('book_without_barcode');
    expect(unreadDigitsOutcome({ nameHebrew: 'שניצל', weightKg: 1 }, {})).toBe('book_without_barcode');
  });
});

describe('provisionalAtBooking', () => {
  const rows = [
    { barcode: '7290004456825123' },
    { barcode: 'MANUAL-1793781692727-4v2wvr' },
    { barcode: 'NOBC-IN264201-P2-3' },
    { barcode: 'MANUAL-1793781699415-rf5l6f' },
  ];
  it('names every row still carrying the MANUAL- placeholder when the flag is on', () => {
    expect(provisionalAtBooking(rows, true)).toEqual(['MANUAL-1793781692727-4v2wvr', 'MANUAL-1793781699415-rf5l6f']);
  });
  it('holds nothing with the flag off', () => {
    expect(provisionalAtBooking(rows, false)).toEqual([]);
  });
  it('a clean list holds nothing', () => {
    expect(provisionalAtBooking([{ barcode: '28261104000001' }, { barcode: 'NOBC-D-P1-1' }], true)).toEqual([]);
  });
  it('isProvisionalId', () => {
    expect(isProvisionalId('MANUAL-1-abc')).toBe(true);
    expect(isProvisionalId('NOBC-D-P1-1')).toBe(false);
    expect(isProvisionalId('')).toBe(false);
    expect(isProvisionalId(undefined)).toBe(false);
  });
});
