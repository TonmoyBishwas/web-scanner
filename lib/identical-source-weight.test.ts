import { describe, it, expect } from 'vitest';
import { applyFormWeightToSource, expandIdenticalBoxes, sourceTakesFormWeight } from './identical-boxes';
import { weightSourceOf } from './weight-source';
import type { MultiPalletBoxScan } from '@/types';

/**
 * identical_source_weight (11/11). Asher Shahar IN26014927 (delivery
 * b391d3fa): "Different carton?" on carton 7290019872498, whose label read
 * 2.5 kg (the inner bag); the worker saved 80 cartons at 10 kg. The 79
 * copies got 10 kg, the source kept 2.5, and the line booked 792.5 kg.
 */
type Row = MultiPalletBoxScan & { weight_checked?: boolean; weight_suspect?: unknown; weight_typed?: boolean };

const SOURCE: Row = {
  barcode: '7290019872498', sku: '7290019872498', item_name: '', item_name_hebrew: 'מוצר',
  weight: 2.5, ocr_weight: 2.5, expiry: '2027-01-01', scanned_at: '2026-11-11T08:00:00Z',
};
const OTHER: Row = { ...SOURCE, barcode: '7290019872511', sku: '7290019872511', weight: 3.1, ocr_weight: 3.1 };
const FORM = { weight: 10, expiry: '2027-01-01', production_date: '', weight_confirmed: true };

describe('sourceTakesFormWeight', () => {
  it('the incident: label-OCR 2.5 kg, 10 kg saved in the form → yes', () => {
    expect(weightSourceOf(SOURCE)).toBe('label_ocr');
    expect(sourceTakesFormWeight(SOURCE, FORM, 79)).toBe(true);
  });

  it('no when the form did not show and confirm the weight (the one-tap twin)', () => {
    expect(sourceTakesFormWeight(SOURCE, { ...FORM, weight_confirmed: undefined }, 79)).toBe(false);
  });

  it('no when the form weight is the source weight', () => {
    expect(sourceTakesFormWeight(SOURCE, { ...FORM, weight: 2.5 }, 79)).toBe(false);
    expect(sourceTakesFormWeight(SOURCE, { ...FORM, weight: 0 }, 79)).toBe(false);
  });

  it('no when the source weight was typed, or is its barcode\'s', () => {
    expect(sourceTakesFormWeight({ ...SOURCE, weight_typed: true }, FORM, 79)).toBe(false);
    // A 31-digit label: 10.15 kg in chars 14–18.
    const coded: Row = { ...SOURCE, barcode: '7290002195832010150130622102027', weight: 10.15, ocr_weight: 10.15 };
    expect(weightSourceOf(coded)).toBe('label_barcode');
    expect(sourceTakesFormWeight(coded, FORM, 79)).toBe(false);
  });

  it('no when the worker reviewed the reading in the edit panel (weight_checked)', () => {
    expect(sourceTakesFormWeight({ ...SOURCE, weight_checked: true }, FORM, 79)).toBe(false);
  });

  // Review 11/11: "Different carton?" for ONE more carton is a different
  // carton; the weight typed is its own, not the source's.
  it('one more carton at a weight near the source reading → no (9.62 read, 10.40 typed)', () => {
    const read: Row = { ...SOURCE, weight: 9.62, ocr_weight: 9.62 };
    expect(weightSourceOf(read)).toBe('label_ocr');
    expect(sourceTakesFormWeight(read, { ...FORM, weight: 10.4 }, 1)).toBe(false);
    expect(applyFormWeightToSource([read], read.barcode, { ...FORM, weight: 10.4 }, 1)[0]).toBe(read);
    // Reviewed and saved unchanged, then a batch: still his reading.
    expect(sourceTakesFormWeight({ ...read, weight_checked: true }, { ...FORM, weight: 10.4 }, 5)).toBe(false);
  });

  it('one more carton, but the reading is implausible beside the typed weight (ratio > 3) → yes', () => {
    expect(sourceTakesFormWeight(SOURCE, FORM, 1)).toBe(true);
    expect(sourceTakesFormWeight({ ...SOURCE, weight: 40, ocr_weight: 40 }, FORM, 1)).toBe(true);
    expect(sourceTakesFormWeight({ ...SOURCE, weight: 3.4, ocr_weight: 3.4 }, FORM, 1)).toBe(false);
  });

  it('no when the source weight is not the label reading as read (unknown)', () => {
    expect(sourceTakesFormWeight({ ...SOURCE, ocr_weight: null }, FORM, 79)).toBe(false);
  });
});

describe('applyFormWeightToSource', () => {
  it('80 cartons at 10 kg book 800 kg, not 792.5', () => {
    const labels = Array.from({ length: 79 }, (_, i) => ({ barcode: `28${String(i).padStart(14, '0')}`, batch_id: 'b1' }));
    const copies = expandIdenticalBoxes(SOURCE, labels, FORM);
    const before = [SOURCE, ...copies];
    expect(before.reduce((a, b) => a + b.weight, 0)).toBeCloseTo(792.5, 6);
    const after = applyFormWeightToSource([SOURCE], SOURCE.barcode, FORM, 79);
    expect([...after, ...copies].reduce((a, b) => a + b.weight, 0)).toBeCloseTo(800, 6);
  });

  it('the source is marked as a typed weight; the other rows are the same objects', () => {
    const rows = [OTHER, { ...SOURCE, weight_suspect: { reason: 'ratio' as const } }];
    const out = applyFormWeightToSource(rows, SOURCE.barcode, FORM, 79);
    expect(out[0]).toBe(OTHER);
    expect(out[1]).toMatchObject({ weight: 10, weight_typed: true, weight_checked: true, weight_suspect: undefined });
    expect(weightSourceOf(out[1])).toBe('typed');
  });

  it('nothing changes when the rule says no', () => {
    const rows = [SOURCE];
    expect(applyFormWeightToSource(rows, SOURCE.barcode, { ...FORM, weight_confirmed: false }, 79)[0]).toBe(SOURCE);
    expect(applyFormWeightToSource(rows, 'not-there', FORM, 79)[0]).toBe(SOURCE);
  });
});
