import { describe, expect, it } from 'vitest';
import { WEIGHT_SOURCES, weightSourceOf } from './weight-source';
import { asNewCartonRows, expandIdenticalBoxes, newCartonBatch } from './identical-boxes';

/** Where each carton's weight came from (04/11, items 9/10). */
// 31-digit catch-weight: 13-digit GTIN, then weight in 10 g at chars 14-18 (12.46 kg), batch, DDMMYYYY.
const GS31 = '7290002195832' + '01246' + '01295' + '14072027';
// Glatt 25-digit: 15.30 kg.
const GLATT = '1014721100101530065729703';
const PLAIN = '7290011111110';   // no weight in it
const MINTED = '2826110400000001';

describe('weightSourceOf', () => {
  it('a units carton', () => {
    expect(weightSourceOf({ barcode: MINTED, weight: 0, units: 18, new_carton: true })).toBe('units');
  });

  it('a New carton is typed, before the copy rule', () => {
    expect(weightSourceOf({ barcode: MINTED, weight: 10, new_carton: true, minted: true,
      weight_copied_from: 'label_ocr' })).toBe('typed');
  });

  it('a typed weight the 31-digit barcode confirms is label_barcode', () => {
    expect(weightSourceOf({ barcode: GS31, weight: 12.46, weight_typed: true, ocr_weight: 4.38 })).toBe('label_barcode');
    expect(weightSourceOf({ barcode: GS31, weight: 12.47, weight_typed: true })).toBe('label_barcode');
    expect(weightSourceOf({ barcode: GS31, weight: 12.6, weight_typed: true })).toBe('typed');
  });

  it('a typed weight the Glatt barcode confirms is label_barcode', () => {
    expect(weightSourceOf({ barcode: GLATT, weight: 15.3, weight_typed: true })).toBe('label_barcode');
  });

  it('the barcode filled the weight', () => {
    expect(weightSourceOf({ barcode: GS31, weight: 12.46, ocr_weight: 4.38, barcode_filled: { weight: 4.38 } }))
      .toBe('label_barcode');
  });

  it('the label reading kept as read', () => {
    expect(weightSourceOf({ barcode: PLAIN, weight: 10.105, ocr_weight: 10.105 })).toBe('label_ocr');
    expect(weightSourceOf({ barcode: PLAIN, weight: 10.2, ocr_weight: 10.105 })).toBe('unknown');
    expect(weightSourceOf({ barcode: PLAIN, weight: 10 })).toBe('unknown');
  });

  it('a typed weight with nothing behind it', () => {
    expect(weightSourceOf({ barcode: PLAIN, weight: 11, ocr_weight: 10.105, weight_typed: true })).toBe('typed');
  });

  it('a twin of a label_ocr carton is twin_copy; an identical copy is identical_copy', () => {
    expect(weightSourceOf({ barcode: MINTED, weight: 10.1, minted: true, twin: true, weight_copied_from: 'label_ocr' }))
      .toBe('twin_copy');
    expect(weightSourceOf({ barcode: MINTED, weight: 10.1, minted: true, weight_copied_from: 'label_barcode' }))
      .toBe('identical_copy');
  });

  it('a copy of a typed or unknown carton is typed; a copy whose form weight changed is typed', () => {
    expect(weightSourceOf({ barcode: MINTED, weight: 10, minted: true, weight_copied_from: 'typed' })).toBe('typed');
    expect(weightSourceOf({ barcode: MINTED, weight: 10, minted: true, weight_copied_from: 'unknown' })).toBe('typed');
    expect(weightSourceOf({ barcode: MINTED, weight: 11, minted: true, weight_copied_from: 'label_ocr', weight_typed: true }))
      .toBe('typed');
  });

  it('a copy cached before 04/11 (no source) is never claimed label-backed', () => {
    expect(weightSourceOf({ barcode: MINTED, weight: 10, minted: true, ocr_weight: 10 })).toBe('unknown');
  });

  it('every value is one of the eight', () => {
    expect(WEIGHT_SOURCES).toHaveLength(8);
  });
});

describe('copies through expandIdenticalBoxes', () => {
  const sample = { barcode: PLAIN + '00001', sku: PLAIN, item_name: 'Schnitzel', weight: 10,
    expiry: '', scanned_at: '2026-11-04T10:00:00Z' };

  it('IN264201314 shape: a sample with no label reading, weight 10, 58 copies → never label_*', () => {
    const labels = Array.from({ length: 58 }, (_, i) => ({ barcode: `28261104${String(i).padStart(8, '0')}`, batch_id: 'b1' }));
    const rows = expandIdenticalBoxes(sample, labels, { weight: 10, expiry: '', production_date: '' });
    const sources = new Set(rows.map((r) => weightSourceOf(r)));
    expect([...sources]).toEqual(['typed']);
    expect(rows[0].weight_copied_from).toBe('unknown');
    expect(rows[0].weight_typed).toBeUndefined();
  });

  it('copies of a label-read sample are identical_copy; the form changing the weight makes them typed', () => {
    const read = { ...sample, weight: 10.105, ocr_weight: 10.105 };
    const labels = [{ barcode: '2826110400000101', batch_id: 'b2' }, { barcode: '2826110400000102', batch_id: 'b2' }];
    const same = expandIdenticalBoxes(read, labels, { weight: 10.105, expiry: '', production_date: '' });
    expect(same.map((r) => weightSourceOf(r))).toEqual(['identical_copy', 'identical_copy']);
    const changed = expandIdenticalBoxes(read, labels, { weight: 10.5, expiry: '', production_date: '' });
    expect(changed[0].weight_typed).toBe(true);
    expect(changed.map((r) => weightSourceOf(r))).toEqual(['typed', 'typed']);
  });

  it('a one-tap twin of a label-read sample is twin_copy', () => {
    const read = { ...sample, weight: 10.105, ocr_weight: 10.105 };
    const [row] = expandIdenticalBoxes(read, [{ barcode: '2826110400000201', batch_id: 'b3' }],
      { weight: 10.105, expiry: '', production_date: '' });
    expect(weightSourceOf({ ...row, twin: true })).toBe('twin_copy');
  });

  it('a New carton batch → typed', () => {
    const batch = newCartonBatch([{ barcode: '2826110400000301', batch_id: 'b4', weight_kg: 12.3,
      expiry_date: '', production_date: '', item_name_hebrew: 'עוף', item_name_english: 'Chicken' }])!;
    const rows = asNewCartonRows(expandIdenticalBoxes(batch.sample, batch.refs, batch.form));
    expect(rows.map((r) => weightSourceOf(r))).toEqual(['typed']);
  });
});
