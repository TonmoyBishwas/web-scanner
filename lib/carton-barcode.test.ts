import { describe, it, expect } from 'vitest';
import { classifyRead, digitsOf, gtinCheckDigitValid, isInHouseCode, isIsraeliGtinPrefixed, noteRepeatedRead } from './carton-barcode';

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

  it('an in-house (prefix 2) 13-digit label is taken as printed (IN264175143, 2026-09-23)', () => {
    expect(gtinCheckDigitValid('2000090300667')).toBe(false); // GS1 says 8, Baladi prints 7
    expect(isInHouseCode('2000090300667')).toBe(true);
    expect(classifyRead('2000090300667')).toEqual({ ok: true });
    // A 729… (Israel GS1) misread is still refused.
    expect(isInHouseCode('7290001456825')).toBe(false);
    expect(classifyRead('7290001456825')).toEqual({ ok: false, reason: 'checksum' });
  });

  it('the same refused digits on a third capture are accepted', () => {
    const counts = new Map<string, number>();
    expect(noteRepeatedRead(counts, '7290001456825')).toBe(false);
    expect(noteRepeatedRead(counts, '7290001456825')).toBe(false);
    expect(noteRepeatedRead(counts, '7290001456825')).toBe(true);
    expect(noteRepeatedRead(counts, '7290001456826')).toBe(false);
  });

  it('SCN-13: a read with anything but digits is refused (2026-10-04 phantom 7290115351084)', () => {
    expect(classifyRead('729011535108401430767802907229:')).toEqual({ ok: false, reason: 'not_digits' });
    expect(classifyRead('7290004456825X')).toEqual({ ok: false, reason: 'not_digits' });
    expect(classifyRead('IN264184055')).toEqual({ ok: false, reason: 'not_digits' });
    expect(classifyRead('https://x.test/sticker/v1/LPN-20261004-IN264178-P1?sig=123456')).toEqual({ ok: false, reason: 'not_digits' });
    // Surrounding whitespace is not part of the read.
    expect(classifyRead(' 7290004456825 ')).toEqual({ ok: true });
  });

  it('SCN-13: a 15+ digit 729… read must start with a valid GTIN-13', () => {
    // Shifted read of 7290115351484… (2026-10-04, phantom box_sku 7290103514840).
    expect(classifyRead('729010351484015205456509092027')).toEqual({ ok: false, reason: 'checksum' });
    // The real labels pass (31-digit catch-weight codes seen in box_inventory).
    expect(classifyRead('7290115351484014307678029072029')).toEqual({ ok: true });
    expect(classifyRead('7290003570867015320158115072027')).toEqual({ ok: true });
    expect(classifyRead('7290002195832012340000101102026')).toEqual({ ok: true });
  });

  it('SCN-13: the zero-padded 7290000… supplier codes and other prefixes are untouched', () => {
    // Invoices 251068506 / 251068650: 7290000 + item 101 / 2283 / 550 — no valid check digit, real.
    expect(gtinCheckDigitValid('7290000000101')).toBe(false);
    expect(isIsraeliGtinPrefixed('72900000001011548304301120260003')).toBe(false);
    expect(classifyRead('72900000001011548304301120260003')).toEqual({ ok: true });
    expect(classifyRead('72900000022831976674301120260003')).toEqual({ ok: true });
    expect(classifyRead('7290000000550010000041220260001')).toEqual({ ok: true });
    // 10… and minted 28… codes keep the old rule (accepted at 15+ digits).
    expect(classifyRead('10147211001010123456789')).toEqual({ ok: true });
    expect(classifyRead('2826091622630531')).toEqual({ ok: true });
  });
});
