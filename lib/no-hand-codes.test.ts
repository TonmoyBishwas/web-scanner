import { describe, expect, it } from 'vitest';
import {
  firstRealCodeMissingWeight, isHandCode, mintRefused, pendingBarcodes, pendingSampleBarcode, realCodeMissingWeight,
} from './no-hand-codes';

// Glatt 261063350 (04/11, ground turkey 500 g): the barcode's weight digits
// read 0.01 kg, which the scanner refuses — the label gave none either.
const GLATT_NO_WEIGHT = '1024650100100001670708241';
// A Glatt carton whose barcode carries 11.99 kg.
const GLATT_WEIGHED = '1015651100101199069559412';
const BALADI_13 = '2000097200258';
const MANUAL = 'MANUAL-1793781692727-4v2wvr';
const NOBC = 'NOBC-261063350-P1-3';
const MINTED = '2826110466196456';

describe('isHandCode', () => {
  it('MANUAL- and NOBC- only', () => {
    expect(isHandCode(MANUAL)).toBe(true);
    expect(isHandCode(NOBC)).toBe(true);
    expect(isHandCode(GLATT_NO_WEIGHT)).toBe(false);
    expect(isHandCode(MINTED)).toBe(false);
    expect(isHandCode('')).toBe(false);
    expect(isHandCode(null)).toBe(false);
  });
});

describe('pendingBarcodes', () => {
  it('blanks a hand code and its sku, leaves every other carton as it is', () => {
    const real = { barcode: GLATT_WEIGHED, sku: GLATT_WEIGHED.slice(0, 13), weight: 11.99 };
    const minted = { barcode: MINTED, sku: MINTED.slice(0, 13), weight: 8 };
    const manual = { barcode: MANUAL, sku: MANUAL, weight: 9.4 };
    const nobc = { barcode: NOBC, sku: '', weight: 10 };
    const typedSku = { barcode: NOBC, sku: BALADI_13, weight: 10 };
    const out = pendingBarcodes([real, minted, manual, nobc, typedSku]);
    expect(out[0]).toBe(real);
    expect(out[1]).toBe(minted);
    expect(out[2]).toEqual({ barcode: '', sku: '', weight: 9.4 });
    expect(out[3]).toEqual({ barcode: '', sku: '', weight: 10 });
    expect(out[4]).toEqual({ barcode: '', sku: BALADI_13, weight: 10 });
  });

  it('keeps the count: one row in, one row out (a uniform pallet still sends its samples)', () => {
    const rows = [{ barcode: NOBC }, { barcode: 'NOBC-261063350-P1-4' }, { barcode: GLATT_WEIGHED }];
    expect(pendingBarcodes(rows)).toHaveLength(3);
  });
});

describe('pendingSampleBarcode', () => {
  it('a non-meat sample captured by photo goes out with no code', () => {
    expect(pendingSampleBarcode('MANUAL-1-0')).toBe('');
    expect(pendingSampleBarcode(BALADI_13)).toBe(BALADI_13);
    expect(pendingSampleBarcode(undefined)).toBe('');
  });
});

describe('realCodeMissingWeight', () => {
  const row = (barcode: string, weight = 0, extra: Record<string, unknown> = {}) => ({ barcode, weight, ocr_status: 'done', ...extra });

  it('the Glatt 04/11 cartons: a real barcode, no label weight, no barcode weight', () => {
    expect(realCodeMissingWeight(row(GLATT_NO_WEIGHT))).toBe(true);
    expect(realCodeMissingWeight(row(BALADI_13))).toBe(true);
  });

  it('not once the weight is typed, nor when the barcode carries one', () => {
    expect(realCodeMissingWeight(row(GLATT_NO_WEIGHT, 8))).toBe(false);
    expect(realCodeMissingWeight(row(GLATT_WEIGHED))).toBe(false);
  });

  it('not a hand code, one of our labels, a units carton, or a read still running / failed', () => {
    expect(realCodeMissingWeight(row(MANUAL))).toBe(false);
    expect(realCodeMissingWeight(row(NOBC))).toBe(false);
    expect(realCodeMissingWeight(row(MINTED))).toBe(false);
    expect(realCodeMissingWeight(row(GLATT_NO_WEIGHT, 0, { units: 11 }))).toBe(false);
    expect(realCodeMissingWeight(row(GLATT_NO_WEIGHT, 0, { ocr_status: 'processing' }))).toBe(false);
    expect(realCodeMissingWeight(row(GLATT_NO_WEIGHT, 0, { ocr_status: 'failed' }))).toBe(false);
  });

  it('firstRealCodeMissingWeight picks the first in list order', () => {
    const list = [row(MINTED, 8), row(GLATT_WEIGHED), row(GLATT_NO_WEIGHT), row(BALADI_13)];
    expect(firstRealCodeMissingWeight(list)?.barcode).toBe(GLATT_NO_WEIGHT);
    expect(firstRealCodeMissingWeight([row(MINTED, 8)])).toBeUndefined();
  });
});

describe('mintRefused', () => {
  it('only the edit panel mint, only with the flag on', () => {
    expect(mintRefused('receiving', true)).toBe(true);
    expect(mintRefused('receiving', false)).toBe(false);
    expect(mintRefused('new_carton', true)).toBe(false);
    expect(mintRefused('identical', true)).toBe(false);
  });
});
