import { describe, expect, it } from 'vitest';
import { findWeightSuspects, kgNumbers, nonKgNumbers, weightFromName, weightStatedAsKg } from './weight-sanity';

const SCHNITZEL = 'שניצל עוף פרוס 120-מוסדי-קפוא';
const box = (barcode: string, weight: number, name = SCHNITZEL, extra: object = {}) => ({
  barcode, weight, item_name_hebrew: name, item_name: '', ocr_status: 'done', ...extra,
});

describe('nonKgNumbers', () => {
  it('keeps a number that is not a kg quantity', () => {
    expect(nonKgNumbers(SCHNITZEL)).toEqual([120]);
    expect(nonKgNumbers("קבנוסים 30 גר' מוסיי 8 קג - גורמה")).toEqual([30]);
  });
  it('drops kg pack sizes, including multiplied ones', () => {
    expect(nonKgNumbers('גולש בקר העדה החרדית - מוסדי 8 ק"ג')).toEqual([]);
    expect(nonKgNumbers('גרעיני תירס 2.5 ק"ג -בד"ץ')).toEqual([]);
    expect(nonKgNumbers('שניצל תירס 1X10 ק"ג בד"ץ מעשרת')).toEqual([]);
    expect(nonKgNumbers('אפונה תפד\' 18 ק"ג (6*3ק"ג) בד"ץ פריניר')).toEqual([]);
    expect(nonKgNumbers('Frozen peas 18 kg')).toEqual([]);
    expect(nonKgNumbers('חזה 10-12 ק"ג')).toEqual([]);
    expect(nonKgNumbers('כרעיים 12 ק.ג')).toEqual([]);
    expect(nonKgNumbers('כרעיים 12 ק ג')).toEqual([]);
    expect(nonKgNumbers('קציצות 1.5 ק"ג X 8')).toEqual([]);
    expect(nonKgNumbers('תירס 2.5ק"ג*4')).toEqual([]);
    expect(nonKgNumbers('שוקיים 230-250 מוסדי')).toEqual([230, 250]);
  });
});

describe('weightFromName', () => {
  it('flags the Glatt 120 kg read', () => {
    expect(weightFromName(120, [SCHNITZEL])).toBe(true);
  });
  it('does not flag a real carton weight printed as kg in the name', () => {
    expect(weightFromName(8, ['קבנוסים 30 גר\' מוסיי 8 קג - גורמה'])).toBe(false);
    expect(weightFromName(18, ['אפונה תפד\' 18 ק"ג (6*3 ק"ג)'])).toBe(false);
  });
  it('does not flag a weight that only resembles a name number', () => {
    expect(weightFromName(12.04, [SCHNITZEL])).toBe(false);
    expect(weightFromName(0, [SCHNITZEL])).toBe(false);
  });
});

describe('findWeightSuspects', () => {
  it('flags the 120 kg carton among the real ones (both rules)', () => {
    const list = [box('a', 12.1), box('b', 11.9), box('bad', 120), box('c', 12.4)];
    expect(findWeightSuspects(list).map((s) => s.barcode)).toEqual(['bad']);
  });

  it('flags a >3x weight by ratio once the item has 3 weighed cartons', () => {
    const n = 'ירכיים עוף';
    const list = [box('a', 17.1, n), box('b', 16.9, n), box('bad', 60, n)];
    expect(findWeightSuspects(list)).toEqual([{ barcode: 'bad', weight: 60, typical: 17.1, reason: 'ratio' }]);
  });

  it('flags a weight under a third of the item median', () => {
    const n = 'ירכיים עוף';
    const list = [box('a', 17.1, n), box('b', 16.9, n), box('low', 1.7, n)];
    expect(findWeightSuspects(list).map((s) => s.barcode)).toEqual(['low']);
  });

  it('does not judge an item with fewer than 3 weighed cartons by ratio', () => {
    const n = 'ירכיים עוף';
    expect(findWeightSuspects([box('a', 17, n), box('b', 60, n)])).toEqual([]);
  });

  it('compares only within the same item', () => {
    const list = [
      box('a', 10, 'שניצל אמריקאי'), box('b', 10.2, 'שניצל אמריקאי'), box('c', 10.1, 'שניצל אמריקאי'),
      box('d', 190, 'דרום'),
    ];
    expect(findWeightSuspects(list)).toEqual([]);
  });

  it('never re-flags a carton the worker confirmed', () => {
    const list = [box('a', 12.1), box('b', 11.9), box('bad', 120, SCHNITZEL, { weight_checked: true }), box('c', 12)];
    expect(findWeightSuspects(list)).toEqual([]);
  });

  it('ignores cartons still processing or without a weight', () => {
    const list = [box('a', 12.1), box('p', 0, SCHNITZEL, { ocr_status: 'processing' }), box('z', 0)];
    expect(findWeightSuspects(list)).toEqual([]);
  });

  it('tests extra names (raw OCR / invoice name) for the name rule', () => {
    const list = [box('x', 120, 'Frozen sliced chicken schnitzel')];
    expect(findWeightSuspects(list, { x: [SCHNITZEL] }).map((s) => s.reason)).toEqual(['name_number']);
  });
});

// 2026-10-19, IN264191356: the bot translated "קבב מוסדי 8 קג" (institutional
// kebab 8 kg) to "Frozen kebab 8g", and the "8" flagged 28 correct cartons.
const KEBAB_HE = 'קבב מוסדי 8 קג - גורמה העדה החרדית';
const KEBAB_EN = 'Frozen kebab 8g, Badatz Haredit';

describe('kgNumbers / weightStatedAsKg', () => {
  it('reads the numbers a name marks as kg', () => {
    expect(kgNumbers(KEBAB_HE)).toEqual([8]);
    expect(kgNumbers('חזה 10-12 ק"ג')).toEqual([10, 12]);
    expect(kgNumbers(SCHNITZEL)).toEqual([]);
  });
  it('is true only when a name states this weight in kg', () => {
    expect(weightStatedAsKg(8, [KEBAB_EN, KEBAB_HE])).toBe(true);
    expect(weightStatedAsKg(8.2, [KEBAB_HE])).toBe(false);
    expect(weightStatedAsKg(0, [KEBAB_HE])).toBe(false);
  });
});

describe('findWeightSuspects — names that disagree', () => {
  const kebab = (barcode: string, extra: object = {}) => ({
    barcode, weight: 8, item_name_hebrew: KEBAB_HE, item_name: KEBAB_EN, ocr_status: 'done', ...extra,
  });

  it('never flags a weight another name of the carton marks as kg', () => {
    expect(findWeightSuspects([kebab('k1')])).toEqual([]);
    expect(findWeightSuspects([kebab('k1')], { k1: [KEBAB_HE, KEBAB_EN] })).toEqual([]);
  });

  it('never reads a suspect number from the English invoice name', () => {
    // No kg in the Hebrew name at all: the "8" of "8g" still does not count.
    const list = [kebab('k1', { item_name_hebrew: 'קבב מוסדי - גורמה' })];
    expect(findWeightSuspects(list)).toEqual([]);
  });

  it('still reads the raw OCR names', () => {
    const list = [kebab('k1', { item_name_hebrew: 'קבב מוסדי - גורמה' })];
    expect(findWeightSuspects(list, { k1: ['Kebab 8 pcs'] })).toEqual([
      { barcode: 'k1', weight: 8, reason: 'name_number', name: 'Kebab 8 pcs' },
    ]);
  });

  it('keeps the Glatt 120 kg read flagged, and says which name it came from', () => {
    const list = [{ barcode: 'g', weight: 120, item_name_hebrew: SCHNITZEL, item_name: 'Sliced chicken schnitzel 120', ocr_status: 'done' }];
    expect(findWeightSuspects(list)).toEqual([{ barcode: 'g', weight: 120, reason: 'name_number', name: SCHNITZEL }]);
  });

  it('does not ratio-flag a weight the name states in kg', () => {
    const n = 'קבב מוסדי 2.8 ק"ג';
    const list = [box('a', 8, n), box('b', 8, n), box('c', 8.1, n), box('ok', 2.8, n)];
    expect(findWeightSuspects(list)).toEqual([]);
  });
});
