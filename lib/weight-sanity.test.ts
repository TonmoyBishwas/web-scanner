import { describe, expect, it } from 'vitest';
import { findWeightSuspects, nonKgNumbers, weightFromName } from './weight-sanity';

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
