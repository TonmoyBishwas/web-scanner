import { describe, it, expect } from 'vitest';
import { classifyRead, digitsOf, gtinCheckDigitValid } from './carton-barcode';

describe('carton-barcode', () => {
  it('digitsOf strips everything but digits', () => {
    expect(digitsOf(' 7290004456825 ')).toBe('7290004456825');
    expect(digitsOf(null)).toBe('');
  });

  it('GTIN check digit: the real kebabonim code passes, the misread fails', () => {
    expect(gtinCheckDigitValid('7290004456825')).toBe(true);   // the paper
    expect(gtinCheckDigitValid('7290001456825')).toBe(false);  // 4 → 1 misread
    expect(gtinCheckDigitValid('7290003570867')).toBe(true);
    expect(gtinCheckDigitValid('7290003670338')).toBe(true);
    expect(gtinCheckDigitValid('12345678')).toBe(false);
  });

  it('classifyRead refuses fragments and bad checksums, accepts GS1-128', () => {
    expect(classifyRead('15928481')).toEqual({ ok: false, reason: 'too_short' });
    expect(classifyRead('7290001456825')).toEqual({ ok: false, reason: 'checksum' });
    expect(classifyRead('7290004456825')).toEqual({ ok: true });
    // Baladi's shipping-pallet label: pallet identity, never a carton (MEV-10).
    expect(classifyRead('1000000000513550')).toEqual({ ok: false, reason: 'pallet_label' });
    expect(classifyRead('1000000000529677')).toEqual({ ok: false, reason: 'pallet_label' });
    expect(classifyRead('1000000000513')).toEqual({ ok: false, reason: 'checksum' });
    expect(classifyRead('7290003570867015320158115072027')).toEqual({ ok: true });
    // A warehouse-minted label (28 + YYMMDD + 8 digits) is 16 digits: accepted.
    expect(classifyRead('2826091622630531')).toEqual({ ok: true });
  });
});
