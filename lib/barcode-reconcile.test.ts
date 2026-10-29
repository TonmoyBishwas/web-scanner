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
// IN264184063, 07/10: barcode 9.77 kg (read 9.771 before 28/10), OCR 14.34, the item's others ≈14.5.
const LIGHT = '7290003670444009771470503082027';
const RECEIVED = '2026-10-19';

describe('parseCartonBarcode (expiry offsets as wb_barcode_expiry)', () => {
  it('reads 10 g units at 14-18 and DDMMYYYY at 24-31', () => {
    expect(parseCartonBarcode(MISREAD)).toEqual({ weight: 12.46, expiry: '2027-07-14' });
    expect(parseCartonBarcode(ROUNDED)).toEqual({ weight: 13.36, expiry: '2027-07-04' });
  });
  it('char 19 is a per-batch digit, not grams (28/10)', () => {
    // Label photo: 14.080 over 7290115351484|01408|5|4563|09092027.
    expect(parseCartonBarcode('7290115351484014085456309092027')?.weight).toBe(14.08);
    // 7290003670444 batch 27062027: `9` on every carton.
    expect(parseCartonBarcode('7290003670444014919401127062027')?.weight).toBe(14.91);
  });
  it('strips a leading ]C1 (AIM identifier) and wants exactly 31 digits', () => {
    expect(parseCartonBarcode(']C17290001918951015000160530112027')).toEqual({ weight: 15, expiry: '2027-11-30' });
    expect(parseCartonBarcode('7290001918951 015000160530112027')).toBeNull();
    expect(parseCartonBarcode('729011535148401502521600802027')).toBeNull(); // 30 digits
  });
  it('weight band: above 0.5 kg, up to 100 kg', () => {
    expect(parseCartonBarcode('7290002195832' + '00050' + '01295' + '14072027')?.weight).toBeNull();
    expect(parseCartonBarcode('7290002195832' + '00051' + '01295' + '14072027')?.weight).toBe(0.51);
    expect(parseCartonBarcode('7290002195832' + '10000' + '01295' + '14072027')?.weight).toBe(100);
    expect(parseCartonBarcode('7290002195832' + '10001' + '01295' + '14072027')?.weight).toBeNull();
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

  it('takes the barcode weight over a rounded label (13.000 → 13.36)', () => {
    const r = reconcileWithBarcode(ROUNDED, { weight: 13, expiry: '2027-07-04' }, { receivedIso: RECEIVED });
    expect(r.weight).toBe(13.36);
    expect(r.expiry).toBe('2027-07-04');
    expect(r.filled).toEqual({ weight: 13 });
    // 2.8 %: under the 5 % misread line, still over 50 g — traced, not major.
    expect(r.events).toEqual([{ field: 'weight', action: 'replaced', ocr: 13, barcode: 13.36, major: false }]);
  });

  it('keeps the OCR when the two agree: a 5 g label under a 10 g code (28/10)', () => {
    const r = reconcileWithBarcode('7290002195832012400128912072027', { weight: 12.395, expiry: '2027-07-12' }, { receivedIso: RECEIVED });
    expect(r.weight).toBe(12.395);
    expect(r.filled).toEqual({});
    expect(r.events).toEqual([]);
  });

  it('exactly 0.01 kg apart is a difference: the barcode wins, silently', () => {
    const r = reconcileWithBarcode('7290002195832012400128912072027', { weight: 12.41, expiry: '2027-07-12' }, { receivedIso: RECEIVED });
    expect(r.weight).toBe(12.4);
    expect(r.filled).toEqual({ weight: 12.41 });
    expect(r.events).toEqual([]);
  });

  it('25/10 drumsticks: label 15.67, code 01567|4 → 15.67 booked, not 15.674', () => {
    const r = reconcileWithBarcode('7290003670321015674845516062027', { weight: 15.67, expiry: '2027-06-16' }, { receivedIso: '2026-10-25' });
    expect(r).toEqual({ weight: 15.67, expiry: '2027-06-16', filled: {}, events: [] });
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
    expect(r.events).toEqual([{ field: 'weight', action: 'kept_ocr', ocr: 14.34, barcode: 9.77, reason: 'weight_outlier' }]);
  });

  it('the barcode wins when the OCR is the outlier', () => {
    const r = reconcileWithBarcode(MISREAD, { weight: 4.38, expiry: null }, { receivedIso: RECEIVED, typicalKg: 12.37 });
    expect(r.weight).toBe(12.46);
  });

  it('with no typical weight known the barcode wins', () => {
    const r = reconcileWithBarcode(LIGHT, { weight: 14.34, expiry: null }, { receivedIso: '2026-10-07' });
    expect(r.weight).toBe(9.77);
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
    expect(out[1]).toMatchObject({ weight: 13.36, expiry: '2027-07-04', barcode_filled: { weight: 13 } });
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

  it('the outlier guard runs again at confirm: a first carton booked at its barcode goes back to the OCR (IN264184063 shape)', () => {
    // Read first: no other carton of the product yet, so the hand-off booked 9.77.
    const first = reconcileWithBarcode(LIGHT, { weight: 14.34, expiry: '2027-08-03' }, { receivedIso: '2026-10-07' });
    expect(first.weight).toBe(9.77);
    const light = { barcode: LIGHT, weight: first.weight!, expiry: '2027-08-03', ocr_status: 'done', barcode_filled: first.filled };
    const others = [
      { barcode: '7290003670444014571470303082027', weight: 14.571, expiry: '2027-08-03', ocr_status: 'done' },
      { barcode: '7290003670444014500000103082027', weight: 14.5, expiry: '2027-08-03', ocr_status: 'done' },
      { barcode: '7290003670444014600000203082027', weight: 14.6, expiry: '2027-08-03', ocr_status: 'done' },
    ];
    const { rows: out, events } = applyBarcodeReadings([light, ...others], '2026-10-07');
    expect(out[0]).toMatchObject({ weight: 14.34, barcode_filled: undefined });
    expect(events).toEqual([{ field: 'weight', action: 'kept_ocr', ocr: 14.34, barcode: 9.77, reason: 'weight_outlier', barcode_digits: LIGHT }]);
    expect(out.slice(1)).toEqual(others);
  });

  it('…keeps the barcode when the list agrees with it, and leaves a weight the worker saved', () => {
    const row = { barcode: MISREAD, weight: 12.46, expiry: '2027-07-14', ocr_status: 'done', barcode_filled: { weight: 4.38, expiry: null } };
    const peers = [
      { barcode: '7290002195832012400128912072027', weight: 12.4, expiry: '2027-07-12', ocr_status: 'done' },
      { barcode: '7290002195832012300128812072027', weight: 12.3, expiry: '2027-07-12', ocr_status: 'done' },
    ];
    expect(applyBarcodeReadings([row, ...peers], RECEIVED).rows[0]).toBe(row);
    const light = { barcode: LIGHT, weight: 9.771, expiry: '2027-08-03', ocr_status: 'done', weight_checked: true, barcode_filled: { weight: 14.34 } };
    const heavy = [
      { barcode: '7290003670444014500000103082027', weight: 14.5, expiry: '2027-08-03', ocr_status: 'done' },
      { barcode: '7290003670444014600000203082027', weight: 14.6, expiry: '2027-08-03', ocr_status: 'done' },
    ];
    expect(applyBarcodeReadings([light, ...heavy], '2026-10-07').rows[0]).toBe(light);
  });

  it('a revert keeps the expiry marker', () => {
    const light = { barcode: LIGHT, weight: 9.771, expiry: '2027-08-03', ocr_status: 'done', barcode_filled: { weight: 14.34, expiry: null } };
    const heavy = [
      { barcode: '7290003670444014500000103082027', weight: 14.5, expiry: '2027-08-03', ocr_status: 'done' },
      { barcode: '7290003670444014600000203082027', weight: 14.6, expiry: '2027-08-03', ocr_status: 'done' },
    ];
    expect(applyBarcodeReadings([light, ...heavy], '2026-10-07').rows[0]).toMatchObject({ weight: 14.34, barcode_filled: { expiry: null } });
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
