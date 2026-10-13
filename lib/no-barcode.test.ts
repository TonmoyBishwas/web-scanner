import { describe, it, expect } from 'vitest';
import { freeNoBarcodeId, isNoBarcodeId, noBarcodeId, unreadDigitsOutcome } from './no-barcode';

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
