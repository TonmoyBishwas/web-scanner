import { describe, it, expect } from 'vitest';
import { parseCartonBarcode } from './barcode-parser';
import {
  applyBarcodeReadings,
  barcodeExpiryPlausible,
  keepBarcodeFilled,
  reconcileWithBarcode,
  typicalWeightFor,
} from './barcode-reconcile';

// IN264189933 (GR26000100), 19/10: OCR read 4.38 kg and no expiry.
const MISREAD = '7290002195832' + '01246' + '01295' + '14072027';
// IN264191356 (GR26000101), 19/10: OCR rounded the weight to 13.000.
const ROUNDED = '7290003670444' + '01336' + '96603' + '04072027';
// IN264184055, 07/10: the barcode's year is 2007; the OCR's 2027 was right.
const YEAR_2007 = '7290003670383015170140623082007';
// IN264184063, 07/10: barcode 9.771 kg, OCR 14.34, the item's others ≈14.5.
const LIGHT = '7290003670444009771470503082027';
const RECEIVED = '2026-10-19';

describe('parseCartonBarcode (same offsets as wb_barcode_weight_kg / wb_barcode_expiry)', () => {
  it('reads grams at 14-19 and DDMMYYYY at 24-31', () => {
    expect(parseCartonBarcode(MISREAD)).toEqual({ weight: 12.46, expiry: '2027-07-14' });
    expect(parseCartonBarcode(ROUNDED)).toEqual({ weight: 13.369, expiry: '2027-07-04' });
  });
  it('says nothing for the formats that carry neither', () => {
    expect(parseCartonBarcode('7290115351484')).toBeNull();                  // EAN-13
    expect(parseCartonBarcode('7290003670321015168845516')).toBeNull();      // 25-digit
    expect(parseCartonBarcode('2826101900000123')).toBeNull();               // warehouse label
  });
});

describe('reconcileWithBarcode', () => {
  it('fills a weight the OCR misread and an expiry it missed (4.38/null → 12.46/2027-07-14)', () => {
    const r = reconcileWithBarcode(MISREAD, { weight: 4.38, expiry: null }, { receivedIso: RECEIVED });
    expect(r.weight).toBe(12.46);
    expect(r.expiry).toBe('2027-07-14');
    expect(r.filled).toEqual({ weight: 4.38, expiry: null });
    expect(r.events).toEqual([
      { field: 'weight', action: 'replaced', ocr: 4.38, barcode: 12.46, major: true },
      { field: 'expiry', action: 'filled', ocr: null, barcode: '2027-07-14' },
    ]);
  });

  it('takes the barcode grams over a rounded label (13.000 → 13.369)', () => {
    const r = reconcileWithBarcode(ROUNDED, { weight: 13, expiry: '2027-07-04' }, { receivedIso: RECEIVED });
    expect(r.weight).toBe(13.369);
    expect(r.expiry).toBe('2027-07-04');
    expect(r.filled).toEqual({ weight: 13 });
    // 2.8 %: under the 5 % misread line, still over 50 g — traced, not major.
    expect(r.events).toEqual([{ field: 'weight', action: 'replaced', ocr: 13, barcode: 13.369, major: false }]);
  });

  it('replaces a 5 g rounding silently', () => {
    const r = reconcileWithBarcode('7290002195832012400128912072027', { weight: 12.395, expiry: '2027-07-12' }, { receivedIso: RECEIVED });
    expect(r.weight).toBe(12.4);
    expect(r.filled).toEqual({ weight: 12.395 });
    expect(r.events).toEqual([]);
  });

  it('leaves an agreeing carton exactly as read, with no marker', () => {
    const r = reconcileWithBarcode(MISREAD, { weight: 12.46, expiry: '2027-07-14' }, { receivedIso: RECEIVED });
    expect(r).toEqual({ weight: 12.46, expiry: '2027-07-14', filled: {}, events: [] });
  });

  it('a different date: the barcode wins', () => {
    const r = reconcileWithBarcode('7290002195832012240127313072027', { weight: 12.24, expiry: '2027-07-15' }, { receivedIso: RECEIVED });
    expect(r.expiry).toBe('2027-07-13');
    expect(r.events).toEqual([{ field: 'expiry', action: 'replaced', ocr: '2027-07-15', barcode: '2027-07-13' }]);
  });

  it('accepts an OCR expiry in DD/MM/YYYY for the comparison', () => {
    const r = reconcileWithBarcode(MISREAD, { weight: 12.46, expiry: '14/07/2027' }, { receivedIso: RECEIVED });
    expect(r.expiry).toBe('2027-07-14');
    expect(r.events).toEqual([]);
  });

  it('keeps the OCR when the barcode date is implausible (year 2007)', () => {
    const r = reconcileWithBarcode(YEAR_2007, { weight: 15.17, expiry: '2027-08-23' }, { receivedIso: '2026-10-07' });
    expect(r.expiry).toBe('2027-08-23');
    expect(r.filled).toEqual({});
    // The parser already refuses a year before 2020 — nothing to trace.
    expect(r.events).toEqual([]);
  });

  it('keeps the OCR when the barcode date is past the 3-year window (traced)', () => {
    const far = '7290003670383015170140623082031';
    const r = reconcileWithBarcode(far, { weight: 15.17, expiry: '2027-08-23' }, { receivedIso: '2026-10-07' });
    expect(r.expiry).toBe('2027-08-23');
    expect(r.events).toEqual([{ field: 'expiry', action: 'kept_ocr', ocr: '2027-08-23', barcode: '2031-08-23', reason: 'expiry_implausible' }]);
  });

  it('keeps the OCR when the barcode weight is the outlier and the OCR is typical', () => {
    const r = reconcileWithBarcode(LIGHT, { weight: 14.34, expiry: '2027-08-03' }, { receivedIso: '2026-10-07', typicalKg: 14.54 });
    expect(r.weight).toBe(14.34);
    expect(r.events).toEqual([{ field: 'weight', action: 'kept_ocr', ocr: 14.34, barcode: 9.771, reason: 'weight_outlier' }]);
  });

  it('the barcode wins when the OCR is the outlier', () => {
    const r = reconcileWithBarcode(MISREAD, { weight: 4.38, expiry: null }, { receivedIso: RECEIVED, typicalKg: 12.37 });
    expect(r.weight).toBe(12.46);
  });

  it('with no typical weight known the barcode wins', () => {
    const r = reconcileWithBarcode(LIGHT, { weight: 14.34, expiry: null }, { receivedIso: '2026-10-07' });
    expect(r.weight).toBe(9.771);
  });

  it('a photo capture (untrusted digits) only fills blanks', () => {
    const r = reconcileWithBarcode(MISREAD, { weight: 4.38, expiry: null }, { receivedIso: RECEIVED, trusted: false });
    expect(r.weight).toBe(4.38);
    expect(r.expiry).toBe('2027-07-14');
    const blank = reconcileWithBarcode(MISREAD, { weight: 0, expiry: '' }, { receivedIso: RECEIVED, trusted: false });
    expect(blank.weight).toBe(12.46);
    expect(blank.filled).toEqual({ weight: null, expiry: null });
  });

  it('does nothing for a barcode that carries nothing', () => {
    const r = reconcileWithBarcode('7290003670321015168845516', { weight: 4.38, expiry: null }, { receivedIso: RECEIVED });
    expect(r).toEqual({ weight: 4.38, expiry: null, filled: {}, events: [] });
  });
});

describe('barcodeExpiryPlausible', () => {
  it('is received−30 days … received+3 years', () => {
    expect(barcodeExpiryPlausible('2026-09-19', RECEIVED)).toBe(true);
    expect(barcodeExpiryPlausible('2026-09-18', RECEIVED)).toBe(false);
    expect(barcodeExpiryPlausible('2029-10-19', RECEIVED)).toBe(true);
    expect(barcodeExpiryPlausible('2029-10-20', RECEIVED)).toBe(false);
    expect(barcodeExpiryPlausible('2007-08-23', RECEIVED)).toBe(false);
  });
});

describe('typicalWeightFor', () => {
  const rows = [
    { barcode: '7290003670444014571470303082027', weight: 14.57 },
    { barcode: '7290003670444014500000103082027', weight: 14.5 },
    { barcode: '7290003670444014600000203082027', weight: 14.6 },
    { barcode: '7290002195832012460129514072027', weight: 12.46 },
    { barcode: LIGHT, weight: 14.34 },
  ];
  it('is the median of the other cartons with the same product prefix', () => {
    expect(typicalWeightFor(LIGHT, rows)).toBe(14.57);
  });
  it('needs at least two of them', () => {
    expect(typicalWeightFor(MISREAD, rows)).toBeNull();
  });
});

describe('applyBarcodeReadings (the last pass before booking)', () => {
  it('books the barcode values and marks them, leaving other rows as the same object', () => {
    const other = { barcode: '7290003670321015168845516', weight: 15.16, expiry: '2027-06-07', ocr_status: 'done' };
    const rows = [
      { barcode: MISREAD, weight: 4.38, expiry: '', ocr_status: 'done' },
      { barcode: ROUNDED, weight: 13, expiry: '2027-07-04', ocr_status: 'done' },
      other,
    ];
    const { rows: out, events } = applyBarcodeReadings(rows, RECEIVED);
    expect(out[0]).toMatchObject({ weight: 12.46, expiry: '2027-07-14', barcode_filled: { weight: 4.38, expiry: null } });
    expect(out[1]).toMatchObject({ weight: 13.369, expiry: '2027-07-04', barcode_filled: { weight: 13 } });
    expect(out[2]).toBe(other);
    expect(events.map((e) => [e.barcode_digits, e.field, e.action])).toEqual([
      [MISREAD, 'weight', 'replaced'],
      [MISREAD, 'expiry', 'filled'],
      [ROUNDED, 'weight', 'replaced'],
    ]);
  });

  it('is a no-op on rows already following the barcode', () => {
    const row = { barcode: MISREAD, weight: 12.46, expiry: '2027-07-14', ocr_status: 'done', barcode_filled: { weight: 4.38, expiry: null } };
    const { rows: out, events } = applyBarcodeReadings([row], RECEIVED);
    expect(out[0]).toBe(row);
    expect(events).toEqual([]);
  });

  it('leaves a value the worker saved himself', () => {
    const row = { barcode: MISREAD, weight: 12.1, expiry: '2027-07-20', ocr_status: 'done', weight_checked: true, expiry_checked: true };
    expect(applyBarcodeReadings([row], RECEIVED).rows[0]).toBe(row);
    const weightOnly = { ...row, expiry_checked: false };
    expect(applyBarcodeReadings([weightOnly], RECEIVED).rows[0]).toMatchObject({ weight: 12.1, expiry: '2027-07-14' });
  });

  it('skips a row still being read', () => {
    const row = { barcode: MISREAD, weight: 0, expiry: '', ocr_status: 'processing' };
    expect(applyBarcodeReadings([row], RECEIVED).rows[0]).toBe(row);
  });

  it('a photo capture only gets its blanks filled', () => {
    const row = { barcode: MISREAD, weight: 4.38, expiry: '', ocr_status: 'done', captured_via: 'manual' as const };
    expect(applyBarcodeReadings([row], RECEIVED).rows[0]).toMatchObject({ weight: 4.38, expiry: '2027-07-14' });
  });
});

describe('keepBarcodeFilled', () => {
  it('keeps the marker only on a value still equal to the barcode', () => {
    const prev = { weight: 4.38, expiry: null };
    expect(keepBarcodeFilled(MISREAD, prev, 12.46, '2027-07-14')).toEqual(prev);
    expect(keepBarcodeFilled(MISREAD, prev, 12.5, '2027-07-14')).toEqual({ expiry: null });
    expect(keepBarcodeFilled(MISREAD, prev, 12.5, '2027-07-15')).toBeUndefined();
    expect(keepBarcodeFilled(MISREAD, undefined, 12.46, '2027-07-14')).toBeUndefined();
  });
});
