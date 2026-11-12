import { describe, it, expect } from 'vitest';
import { findWeightSuspects } from './weight-sanity';
import { asNewCartonRows, applyFormWeightToSource, expandIdenticalBoxes } from './identical-boxes';
import { blocksConfirm, heldAfterReads, isOpenRatioDoubt } from './failed-read';
import type { MultiPalletBoxScan } from '@/types';

/**
 * weight_ratio_over_kg_name (12/11). Asher Shahar, peas 7290019872498
 * "אפונה תפ' 10 ק"ג (4*2.5 ק"ג)" (peas 10 kg, 4 bags of 2.5 kg). The label
 * read was the inner bag's sticker, "אפונה גינה קפואה 2.5 ק"ג שקוף", 2.5 kg.
 *  - IN26014927 (11/11, delivery b391d3fa): the source carton at 2.5 +
 *    "Different carton?" 80 at 10 kg (79 labels) = 792.5 kg, not 800.
 *  - IN26014515 (04/11, delivery abcf3e9e): the source at 2.5 + 87 at 10 kg
 *    (86 labels) + New carton 3 at 10 kg = 892.5 kg, not 900.
 * The name states 2.5 in kg, so the scanner never doubted the source; the
 * bot's second read gave 2.5 again and its carton check went to ok.
 */
type Row = MultiPalletBoxScan & {
  ocr_status?: string; weight_checked?: boolean; weight_typed?: boolean;
  weight_suspect?: { typical?: number; reason: 'name_number' | 'ratio' };
};

const NAME_1111 = 'אפונה תפ\' 10 ק"ג (4*2.5 ק"ג) בד"ץ (פנזה)';
const NAME_0411 = 'אפונה תפ\' 10 ק"ג (4*2.5 ק"ג) בד"ץ (פמזה)';
const NAME_EN = 'Peas 10 kg (4*2.5 kg) Badatz (Frozen)';
const RAW = ['אפונה גינה קפואה 2.5 ק"ג שקוף', 'FROZEN GREEN PEAS 2.5 KG TRANSPARENT'];

const source = (name: string): Row => ({
  barcode: '7290019872498', sku: '7290019872498', item_name: NAME_EN, item_name_hebrew: name,
  weight: 2.5, ocr_weight: 2.5, expiry: '2028-05-24', production_date: '2025-11-24',
  scanned_at: '2026-11-11T09:20:28.866Z', ocr_status: 'done',
});
const FORM = { weight: 10, expiry: '2028-05-24', production_date: '2025-11-24', weight_confirmed: true };
const labels = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({ barcode: `28261111${tag}${String(i).padStart(6, '0')}`, batch_id: tag }));
const total = (rows: ReadonlyArray<{ weight: number }>) => rows.reduce((a, b) => a + b.weight, 0);

/** IN26014927 as booked: the source + 79 "Different carton?" copies at 10 kg. */
function list1111(): Row[] {
  const src = source(NAME_1111);
  return [src, ...expandIdenticalBoxes(src, labels(79, '11'), FORM)];
}

/** IN26014515 as booked: the source + 86 copies + 3 New cartons, all at 10 kg. */
function list0411(): Row[] {
  const src = source(NAME_0411);
  const copies = expandIdenticalBoxes(src, labels(86, '04'), FORM);
  const sample: Row = { ...src, barcode: '', sku: '', weight: 10, ocr_weight: undefined };
  const fresh = asNewCartonRows(expandIdenticalBoxes(sample, labels(3, '05'), FORM));
  return [src, ...copies, ...fresh];
}

const ON = { ratioOverKgName: true };

describe('findWeightSuspects ratioOverKgName — the peas receipts', () => {
  it('the booked totals are 792.5 and 892.5 kg', () => {
    expect(list1111()).toHaveLength(80);
    expect(total(list1111())).toBeCloseTo(792.5, 6);
    expect(list0411()).toHaveLength(90);
    expect(total(list0411())).toBeCloseTo(892.5, 6);
  });

  it('off (no option, or false): the 2.5 kg source is not doubted, as today', () => {
    for (const list of [list1111(), list0411()]) {
      expect(findWeightSuspects(list)).toEqual([]);
      expect(findWeightSuspects(list, {}, { ratioOverKgName: false })).toEqual([]);
      expect(findWeightSuspects(list, { '7290019872498': RAW })).toEqual([]);
    }
  });

  it('on: the source is a ratio doubt at typical 10 kg, the copies are not', () => {
    const want = [{ barcode: '7290019872498', weight: 2.5, typical: 10, reason: 'ratio' }];
    expect(findWeightSuspects(list1111(), {}, ON)).toEqual(want);
    expect(findWeightSuspects(list1111(), { '7290019872498': RAW }, ON)).toEqual(want);
    expect(findWeightSuspects(list0411(), {}, ON)).toEqual(want);
  });

  it('on: the doubt holds the confirm until the worker opens the carton (no auto-accept)', () => {
    const flagged: Row = { ...source(NAME_1111), weight_suspect: { typical: 10, reason: 'ratio' as const } };
    expect(isOpenRatioDoubt(flagged)).toBe(true);
    expect(blocksConfirm(flagged)).toBe(true);
    expect(heldAfterReads([flagged], new Set(), { soft: true })).toEqual(['7290019872498']);
    // He saves it in the edit panel (10 kg): settled, 800 kg.
    const saved: Row = { ...flagged, weight: 10, weight_typed: true, weight_checked: true, weight_suspect: undefined };
    expect(blocksConfirm(saved)).toBe(false);
    const after = [saved, ...list1111().slice(1)];
    expect(findWeightSuspects(after, {}, ON)).toEqual([]);
    expect(total(after)).toBeCloseTo(800, 6);
  });

  it('on, with identical_source_weight also on: the source already took 10 kg, nothing is doubted', () => {
    const src = source(NAME_1111);
    const copies = expandIdenticalBoxes(src, labels(79, '11'), FORM);
    const rows = [...applyFormWeightToSource([src], src.barcode, FORM, 79), ...copies];
    expect(findWeightSuspects(rows, {}, ON)).toEqual([]);
    expect(total(rows)).toBeCloseTo(800, 6);
  });

  it('on: the name rule still never fires on a weight a name states in kg', () => {
    const kebab = 'קבב מוסדי 8 קג - גורמה העדה החרדית';
    const one = [{ barcode: 'k1', weight: 8, item_name_hebrew: kebab, item_name: 'Frozen kebab 8g', ocr_status: 'done' }];
    expect(findWeightSuspects(one, { k1: ['Kebab 8 pcs'] }, ON)).toEqual([]);
  });

  it('on: within 3x of the median (2.8 beside 8 kg) is not doubted', () => {
    const n = 'קבב מוסדי 2.8 ק"ג';
    const b = (barcode: string, weight: number) => ({ barcode, weight, item_name_hebrew: n, item_name: '', ocr_status: 'done' });
    expect(findWeightSuspects([b('a', 8), b('b', 8), b('c', 8.1), b('ok', 2.8)], {}, ON)).toEqual([]);
  });

  it('on: fewer than 3 weighed cartons of the item are not judged by ratio', () => {
    const src = source(NAME_1111);
    const rows = [src, ...expandIdenticalBoxes(src, labels(1, '11'), FORM)];
    expect(findWeightSuspects(rows, {}, ON)).toEqual([]);
  });
});
