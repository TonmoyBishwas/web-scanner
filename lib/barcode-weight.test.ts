import { describe, expect, it } from 'vitest';
import { barcodeCarriesWeight, barcodeWeight, ocrWeightFromBarcode, rawOcrWeightKg, weightsAgree, weightsDisagree } from './barcode-weight';
import { identicalAllowed } from './identical-boxes';
import { labelPrintsWeight, uniformCandidate } from './uniform-candidate';
import { canOfferDifferentCarton, differentCartonOffer, listedNoticeKey } from './scan-notice';
import { blocksConfirm, failedReadCovered, failedReadPrefill, fillBarcodeWeights, heldAfterReads } from './failed-read';

// Real Glatt cartons (מ.ב. גלאט, 28/10), their label photos confirm the code.
const GLATT_1012 = '1050861100101012067935140';
const GLATT_1009 = '1050861100101009067935132';
const GLATT_1359 = '1015781100101359065737237';
const GLATT_1495 = '1015781100101495074263576';
// A 31-digit catch-weight code (S03 carton C13): 12.57 kg, batch digit 0, 22/10/2027.
const GS31 = '7290002195832' + '01257' + '0' + '1306' + '22102027';

describe('barcodeWeight — Glatt 25-digit', () => {
  it.each([
    [GLATT_1012, 10.12, '05086'],
    [GLATT_1009, 10.09, '05086'],
    [GLATT_1359, 13.59, '01578'],
    [GLATT_1495, 14.95, '01578'],
  ])('%s → %s kg, item %s', (code, kg, item) => {
    expect(barcodeWeight(code)).toEqual({ kg, itemCode: item, source: 'glatt25' });
  });

  it('the 120 kg OCR carton of 14/10 (lib/weight-sanity.ts) → 11.99 kg', () => {
    expect(barcodeWeight('1015651100101199069559412')?.kg).toBe(11.99);
  });

  it.each([
    ['26-digit misread', '10508611001010140679351090'],
    ['our own 28… label', '2826102884446507'],
    ['per-product EAN-13 (שניצל תירס)', '7290020497000'],
    ['empty', ''],
    ['provisional id', 'MANUAL-1730000000000'],
  ])('%s → no weight', (_label, code) => {
    expect(barcodeWeight(code)).toBeNull();
    expect(barcodeCarriesWeight(code)).toBe(false);
  });

  it('weight outside 0.5 (exclusive) – 60 kg → no weight', () => {
    expect(barcodeWeight('1050861100100049067935140')).toBeNull(); // 0.49 kg
    expect(barcodeWeight('1050861100100050067935140')).toBeNull(); // 0.50 kg, as the bot
    expect(barcodeWeight('1050861100100051067935140')?.kg).toBe(0.51);
    expect(barcodeWeight('1050861100106000067935140')?.kg).toBe(60);
    expect(barcodeWeight('1050861100106001067935140')).toBeNull(); // 60.01 kg
  });

  it('another 25-digit shape (no 110010 infix) → no weight', () => {
    expect(barcodeWeight('1050861200101012067935140')).toBeNull();
    expect(barcodeWeight('7290000001234567890123456')).toBeNull();
  });

  it('mids 010010 and 110610 carry the weight too', () => {
    expect(barcodeWeight('1023530100101319071320494')).toEqual({ kg: 13.19, itemCode: '02353', source: 'glatt25' });
    expect(barcodeWeight('1002721106101527069546340')).toEqual({ kg: 15.27, itemCode: '00272', source: 'glatt25' });
  });

  it('mid 140010 is a units item (04304, "11 יחידות") → no weight', () => {
    expect(barcodeWeight('1043041400100001178251135')).toBeNull();
  });

  it('a misread mid → no weight (printed …110010 1012… / …110010 1733…)', () => {
    expect(barcodeWeight('1050861153020312067935192')).toBeNull();
    expect(barcodeWeight('1014821100022433074260935')).toBeNull();
  });
});

describe('barcodeWeight — 31-digit (reuses parseCartonBarcode)', () => {
  it('10 g units at chars 14–18; char 19 is a batch digit', () => {
    expect(barcodeWeight(GS31)).toEqual({ kg: 12.57, source: 'gs31' });
    expect(barcodeWeight('7290115351484014085456309092027')).toEqual({ kg: 14.08, source: 'gs31' });
  });
  it('a leading ]C1 is stripped', () => {
    expect(barcodeWeight(']C17290001918951015000160530112027')).toEqual({ kg: 15, source: 'gs31' });
  });
  it('an out-of-band weight field → no weight', () => {
    expect(barcodeWeight('7290002195832' + '00010' + '0' + '1306' + '22102027')).toBeNull();
  });
});

describe('weightsAgree / weightsDisagree (less than 0.01 kg apart = the same reading)', () => {
  it('under 0.01 kg agrees; 0.01 kg or more is a difference', () => {
    expect(weightsAgree(10.12, 10.12)).toBe(true);
    expect(weightsAgree(12.385, 12.39)).toBe(true);
    expect(weightsAgree(10.12, 10.13)).toBe(false);
    expect(weightsAgree(10.11, 10.1)).toBe(false); // 0.00999… in floats is still 10 g
    expect(weightsDisagree(10.12, 10.15)).toBe(true);
    expect(weightsDisagree(10.12, 10.13)).toBe(true);
    expect(weightsDisagree(10.12, 10.125)).toBe(false);
  });
});

describe('rawOcrWeightKg', () => {
  it('a positive number, else null', () => {
    expect(rawOcrWeightKg(10.15)).toBe(10.15);
    expect(rawOcrWeightKg('10.15')).toBe(10.15);
    expect(rawOcrWeightKg(0)).toBeNull();
    expect(rawOcrWeightKg(null)).toBeNull();
    expect(rawOcrWeightKg(undefined)).toBeNull();
    expect(rawOcrWeightKg('abc')).toBeNull();
    expect(rawOcrWeightKg(-1)).toBeNull();
  });
});

describe('ocrWeightFromBarcode (the /api/multi-pallet-ocr rule)', () => {
  it('Glatt code + OCR 10.15 → books 10.12 and traces the override', () => {
    expect(ocrWeightFromBarcode(GLATT_1012, 10.15)).toEqual({
      weight_kg: 10.12,
      event: { barcode: GLATT_1012, ocr_kg: 10.15, barcode_kg: 10.12, source: 'glatt25', item_code: '05086' },
    });
  });

  it('Glatt code + OCR 10.93 for a 10.09 label → 10.09', () => {
    expect(ocrWeightFromBarcode(GLATT_1009, 10.93)?.weight_kg).toBe(10.09);
  });

  it('Glatt code + an agreeing OCR → the OCR weight stays, no trace', () => {
    expect(ocrWeightFromBarcode(GLATT_1359, 13.59)).toEqual({ weight_kg: 13.59, event: null });
    expect(ocrWeightFromBarcode(GLATT_1359, 13.595)).toEqual({ weight_kg: 13.595, event: null });
  });

  it('Glatt code + an OCR exactly 0.01 kg off → the barcode weight, traced', () => {
    expect(ocrWeightFromBarcode(GLATT_1359, 13.6)).toMatchObject({ weight_kg: 13.59, event: { ocr_kg: 13.6, barcode_kg: 13.59 } });
  });

  it('Glatt code + no OCR weight → filled from the barcode, traced', () => {
    const r = ocrWeightFromBarcode(GLATT_1495, null);
    expect(r?.weight_kg).toBe(14.95);
    expect(r?.event).toMatchObject({ ocr_kg: null, barcode_kg: 14.95 });
    expect(ocrWeightFromBarcode(GLATT_1495, 0)?.event?.ocr_kg).toBeNull();
  });

  it('a numeric string from the OCR is read as a number', () => {
    expect(ocrWeightFromBarcode(GLATT_1012, '10.15')?.event?.ocr_kg).toBe(10.15);
  });

  it('a 31-digit code is left to the page (its guards need the OCR reading)', () => {
    expect(ocrWeightFromBarcode(GS31, 14.34)).toBeNull();
  });

  it('no weight in the code (or no code) → the OCR stands', () => {
    expect(ocrWeightFromBarcode('7290020497000', 0.9)).toBeNull();
    expect(ocrWeightFromBarcode('10508611001010140679351090', 10.15)).toBeNull();
    expect(ocrWeightFromBarcode('', 10.15)).toBeNull();
    expect(ocrWeightFromBarcode(undefined, 10.15)).toBeNull();
  });
});

describe('"All boxes identical" is never offered on a carton whose code carries its weight', () => {
  const row = (barcode: string, over: Record<string, unknown> = {}) => ({ barcode, ocr_status: 'done', ...over });

  it('Glatt 25-digit and 31-digit cartons → not offered', () => {
    expect(identicalAllowed(row(GLATT_1359))).toBe(false);
    expect(identicalAllowed(row(GLATT_1012))).toBe(false);
    expect(identicalAllowed(row(GS31))).toBe(false);
  });

  it('a per-product code with no weight (שניצל תירס 7290020497000) → offered, as today', () => {
    expect(identicalAllowed(row('7290020497000'))).toBe(true);
    // A 26-digit misread carries no weight either.
    expect(identicalAllowed(row('10508611001010140679351090'))).toBe(true);
  });

  it('the old rules still hold', () => {
    expect(identicalAllowed(row('7290020497000', { ocr_status: 'processing' }))).toBe(false);
    expect(identicalAllowed(row('2826102884446507', { minted: true }))).toBe(false);
    expect(identicalAllowed(row('MANUAL-1730000000000'))).toBe(false);
    expect(identicalAllowed(row('NOBC-48429-1-3'))).toBe(false);
    expect(identicalAllowed(row('7290020497000', { ocr_status: 'failed' }))).toBe(true);
  });
});

describe('a Glatt code on the list is the same carton, never a twin', () => {
  const counted = { ocr_status: 'done', barcode: GLATT_1359 };

  it('no "Different carton?" and no one-tap twin for a Glatt re-read', () => {
    expect(canOfferDifferentCarton(GLATT_1359, counted)).toBe(false);
    expect(differentCartonOffer(GLATT_1359, counted)).toBeNull();
    // The notice only says where the carton is (existing text).
    expect(listedNoticeKey(GLATT_1359, counted, { photo: false, twins: 0 })).toBe('terminal.alreadyListed');
  });

  it('a 31-digit twin keeps its one-tap offer at its own barcode weight', () => {
    expect(differentCartonOffer(GS31, { ocr_status: 'done', barcode: GS31 })).toEqual({ quick: true, weight: 12.57 });
  });

  it('a per-product code keeps the "Different carton?" form', () => {
    expect(differentCartonOffer('7290020497000', { ocr_status: 'done', barcode: '7290020497000' })).toEqual({ quick: false });
  });
});

describe('the single-item shortcut never multiplies a Glatt carton', () => {
  const key = () => 'fillet';
  it('two Glatt cartons at the same weight → no uniform candidate', () => {
    expect(labelPrintsWeight(GLATT_1012)).toBe(true);
    const same = [
      { barcode: GLATT_1012, weight: 10.12 },
      { barcode: '1050861100101012067935999', weight: 10.12 },
    ];
    expect(uniformCandidate(same, key, { minSamples: 2, tolerance: 0.0001 })).toBeNull();
  });
  it('per-product cartons still qualify', () => {
    const same = [
      { barcode: '7290020497000', weight: 6 },
      { barcode: '7290020497000-2', weight: 6 },
    ];
    expect(uniformCandidate(same, key, { minSamples: 2, tolerance: 0.0001 })).not.toBeNull();
  });
});

describe('a failed sticker read whose barcode carries the weight does not hold the carton', () => {
  const failed = (barcode: string, over: Record<string, unknown> = {}) => ({
    barcode, item_name: '', item_name_hebrew: '', weight: 0, expiry: '', ocr_status: 'failed', ...over,
  });
  const GLATT_LINE = [{ item_code: '1050861100101', item_name_hebrew: 'פילה עוף', item_name_english: 'Chicken fillet' }];

  it('Glatt: the weight comes from the barcode; with a name from the code, no hold', () => {
    const row = failed(GLATT_1012);
    const { patch, events } = failedReadPrefill(row, GLATT_LINE as never, { receivedIso: '2026-10-28' });
    expect(patch.weight).toBe(10.12);
    expect(patch.item_name_hebrew).toBe('פילה עוף');
    // No "from barcode" marker for a Glatt code: nothing new on the screen.
    expect(patch.barcode_filled).toBeUndefined();
    expect(events).toEqual([{ field: 'weight', action: 'filled', ocr: null, barcode: 10.12 }]);
    const after = { ...row, ...patch };
    expect(failedReadCovered(after)).toBe(true);
    expect(blocksConfirm(after)).toBe(false);
    expect(heldAfterReads([after], new Set([GLATT_1012]), { soft: false })).toEqual([]);
  });

  it('31-digit: weight (and expiry) from the barcode, named → no hold', () => {
    const row = failed(GS31, { item_name_hebrew: 'כרעיים עוף' });
    const { patch } = failedReadPrefill(row, [], { receivedIso: '2026-10-23' });
    expect(patch.weight).toBe(12.57);
    expect(patch.expiry).toBe('2027-10-22');
    expect(blocksConfirm({ ...row, ...patch })).toBe(false);
  });

  it('a barcode weight but no name → still held (the name has no other source)', () => {
    const row = { ...failed(GLATT_1359), weight: 13.59 };
    expect(failedReadCovered(row)).toBe(false);
    expect(blocksConfirm(row)).toBe(true);
    expect(heldAfterReads([row], new Set(), { soft: false })).toEqual([GLATT_1359]);
  });

  it('a code with no weight → held exactly as before', () => {
    const row = failed('7290020497000', { item_name_hebrew: 'שניצל תירס', weight: 6 });
    expect(failedReadCovered(row)).toBe(false);
    expect(blocksConfirm(row)).toBe(true);
  });

  it('needs_review and an open ratio doubt still hold a covered carton', () => {
    const named = failed(GLATT_1012, { item_name_hebrew: 'פילה עוף', weight: 10.12 });
    expect(blocksConfirm({ ...named, needs_review: true })).toBe(true);
    expect(blocksConfirm({ ...named, weight_suspect: { reason: 'ratio' } })).toBe(true);
  });

  it('a weight the worker saved is never replaced by the prefill', () => {
    const { patch } = failedReadPrefill(failed(GLATT_1012, { weight: 9.5, weight_checked: true }), [], { receivedIso: '2026-10-28' });
    expect(patch.weight).toBeUndefined();
  });

  it('confirm payload: a 0 kg row whose barcode carries a weight is booked at it', () => {
    const rows = [
      { barcode: GLATT_1495, weight: 0 },
      { barcode: '7290020497000', weight: 0 },
      { barcode: GLATT_1012, weight: 10.12 },
      { barcode: GLATT_1359, weight: 0, units: 4 },
    ];
    const { rows: out, filled } = fillBarcodeWeights(rows);
    expect(out.map((r) => r.weight)).toEqual([14.95, 0, 10.12, 0]);
    expect(out[2]).toBe(rows[2]);
    expect(filled).toEqual([{ barcode: GLATT_1495, barcode_kg: 14.95 }]);
  });
});
