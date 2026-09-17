import { describe, it, expect } from 'vitest';
import {
  baseBarcode, classifyRead, gtinCheckDigitValid, isPerCartonUnique, repeatKey,
} from './carton-barcode';

describe('carton-barcode', () => {
  it('a catch-weight GS1-128 is unique per carton; a label EAN is not', () => {
    expect(isPerCartonUnique('7290003570867015320158115072027')).toBe(true);
    expect(isPerCartonUnique('7290004456825')).toBe(false);
    expect(isPerCartonUnique('7290004456825-C')).toBe(false);
  });

  it('repeat keys count up and never collide', () => {
    const taken = new Set(['7290004456825', '7290004456825-B']);
    expect(repeatKey('7290004456825', taken)).toBe('7290004456825-C');
    expect(repeatKey('7290004456825-B', taken)).toBe('7290004456825-C');
    expect(baseBarcode('7290004456825-C')).toBe('7290004456825');
    expect(baseBarcode('MANUAL-1789550786995-m4oa3a')).toBe('MANUAL-1789550786995-m4oa3a');
    expect(baseBarcode('NOBC-IN264171-P1-3')).toBe('NOBC-IN264171-P1-3');
    const many = new Set<string>();
    for (let i = 0; i < 40; i += 1) many.add(repeatKey('7290004456825', many));
    expect(many.size).toBe(40);
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
    expect(classifyRead('7290004456825-D')).toEqual({ ok: true });
    expect(classifyRead('7290003570867015320158115072027')).toEqual({ ok: true });
    expect(classifyRead('2826091622630531')).toEqual({ ok: true }); // 16 digits: GS1-128 territory
  });
});
