import { describe, it, expect } from 'vitest';
import { preferCartonCodes, isProductCode, isCartonCode } from './frame-reads';

// Well Done 48288 (David, 2026-10-11): black brand sticker EAN-13 = the
// invoice item code on every carton, white Sokołów label = the carton code.
const WELL_DONE_EAN = '7290008432467';
const WELL_DONE_CARTON = '388432467020926171026048702036';
// Baladi stroganoff, 31 digits (GTIN + net + gross + expiry).
const BALADI_31 = '7290003570867015260157527072027';
// Kabanos — a fixed-weight product: the EAN-13 is all there is.
const KABANOS_EAN = '7290004456825';
// Baladi's own shipping-pallet label (MEV-10).
const PALLET_LABEL = '1000000000508926';
// A warehouse-minted 28… label.
const MINTED = '2826101100000001';

const r = (value: string, dist = 0) => ({ value, dist });

describe('isProductCode / isCartonCode', () => {
  it('an EAN-13 is a product code, not a carton code', () => {
    expect(isProductCode(WELL_DONE_EAN)).toBe(true);
    expect(isCartonCode(WELL_DONE_EAN)).toBe(false);
  });

  it('a 30/31-digit GS1-128 is a carton code', () => {
    expect(isCartonCode(WELL_DONE_CARTON)).toBe(true);
    expect(isCartonCode(BALADI_31)).toBe(true);
    expect(isProductCode(BALADI_31)).toBe(false);
  });

  it('a warehouse 28… label is a carton code', () => {
    expect(isCartonCode(MINTED)).toBe(true);
  });

  it('the supplier pallet label is never a carton code', () => {
    expect(isCartonCode(PALLET_LABEL)).toBe(false);
  });

  it('a GTIN-14 is neither (left alone)', () => {
    expect(isProductCode('17290008432464')).toBe(false);
    expect(isCartonCode('17290008432464')).toBe(false);
  });

  it('non-digit values (a QR URL) are neither', () => {
    expect(isProductCode('https://x.test/sticker/v1/LPN')).toBe(false);
    expect(isCartonCode('https://x.test/sticker/v1/LPN')).toBe(false);
  });
});

describe('preferCartonCodes', () => {
  it('EAN-13 + carton code in one frame → only the carton code', () => {
    const out = preferCartonCodes([r(WELL_DONE_EAN, 1), r(WELL_DONE_CARTON, 50)]);
    expect(out.map((x) => x.value)).toEqual([WELL_DONE_CARTON]);
  });

  it('keeps the carton code\'s own distance', () => {
    expect(preferCartonCodes([r(WELL_DONE_EAN, 1), r(WELL_DONE_CARTON, 50)])).toEqual([r(WELL_DONE_CARTON, 50)]);
  });

  it('an EAN-13 alone (kabanos) is untouched', () => {
    const reads = [r(KABANOS_EAN, 3)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('a carton code alone is untouched', () => {
    const reads = [r(BALADI_31)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('EAN-13 + supplier pallet label → unchanged (a pallet label is never preferred)', () => {
    const reads = [r(KABANOS_EAN, 2), r(PALLET_LABEL, 1)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('EAN-13 + pallet label + carton code → the pallet label stays (the page refuses it as today), the EAN goes', () => {
    const out = preferCartonCodes([r(WELL_DONE_EAN), r(PALLET_LABEL), r(BALADI_31)]);
    expect(out.map((x) => x.value)).toEqual([PALLET_LABEL, BALADI_31]);
  });

  it('two carton codes + an EAN → both carton codes kept, in order', () => {
    const out = preferCartonCodes([r(BALADI_31, 9), r(WELL_DONE_EAN, 1), r(WELL_DONE_CARTON, 4)]);
    expect(out.map((x) => x.value)).toEqual([BALADI_31, WELL_DONE_CARTON]);
  });

  it('a warehouse 28… label beats the EAN-13 on the same carton', () => {
    const out = preferCartonCodes([r(WELL_DONE_EAN), r(MINTED)]);
    expect(out.map((x) => x.value)).toEqual([MINTED]);
  });

  it('a short fragment next to an EAN-13 is not a carton code → unchanged', () => {
    const reads = [r(WELL_DONE_EAN), r('15928481')];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('a GTIN-14 next to a carton code stays (only ≤13-digit product codes are dropped)', () => {
    const out = preferCartonCodes([r('17290008432464'), r(WELL_DONE_EAN), r(BALADI_31)]);
    expect(out.map((x) => x.value)).toEqual(['17290008432464', BALADI_31]);
  });

  it('an empty frame → empty', () => {
    expect(preferCartonCodes([])).toEqual([]);
  });
});
