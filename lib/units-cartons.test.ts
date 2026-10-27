import { describe, expect, it } from 'vitest';
import {
  addSplit,
  effectiveSplits,
  groupUnitsRows,
  invoiceKgTotal,
  isUnitsCarton,
  lineUnit,
  parseUnitsRequest,
  removeSplit,
  sanitizeUnitsBoxes,
  shortExpiry,
  splitExpiries,
  stepperValue,
  unitsBatchMatches,
  unitsBatchSummary,
  unitsCartonRows,
  unitsCartonsPrefill,
  unitsLabelPayload,
  unitsPerCartonPrefill,
  unitsRowKey,
  unitsSaveBlock,
} from './units-cartons';

// Note 008955: KK117, 7 cartons x 18 portions = 126 units.
const KK117 = { item_code: 'KK117', item_name_hebrew: 'מנה', item_name_english: 'Meal', unit: 'units' as const, quantity_kg: 126, box_count: 7 };

describe('line unit and units cartons', () => {
  it('only an explicit units line is units', () => {
    expect(lineUnit(KK117)).toBe('units');
    expect(lineUnit({ unit: 'kg' })).toBe('kg');
    expect(lineUnit({})).toBe('kg');
    expect(lineUnit(null)).toBe('kg');
    expect(lineUnit({ unit: 'UNITS' })).toBe('kg');
  });

  it('a units carton holds a whole number above 0', () => {
    expect(isUnitsCarton({ units: 18 })).toBe(true);
    expect(isUnitsCarton({ units: 0 })).toBe(false);
    expect(isUnitsCarton({ units: 1.5 })).toBe(false);
    expect(isUnitsCarton({ units: undefined })).toBe(false);
    expect(isUnitsCarton({})).toBe(false);
  });

  it('stepper text reads as a clamped whole number', () => {
    expect(stepperValue('18', 9999)).toBe(18);
    expect(stepperValue('', 9999)).toBe(0);
    expect(stepperValue('7a', 500)).toBe(7);
    expect(stepperValue('900', 500)).toBe(500);
  });
});

describe('prefill', () => {
  it('units per carton: the line divided evenly, units lines only', () => {
    expect(unitsPerCartonPrefill(KK117)).toBe(18);
    expect(unitsPerCartonPrefill({ ...KK117, quantity_kg: 125 })).toBeNull();
    expect(unitsPerCartonPrefill({ ...KK117, unit: 'kg' })).toBeNull();
    expect(unitsPerCartonPrefill({ ...KK117, unit: undefined })).toBeNull();
    expect(unitsPerCartonPrefill({ ...KK117, box_count: 0 })).toBeNull();
    expect(unitsPerCartonPrefill(null)).toBeNull();
  });

  it('cartons: what the line lacks on a loose-only delivery, else the usual count', () => {
    expect(unitsCartonsPrefill({ lineBoxes: 7, onList: 0, looseOnly: true, fallback: 1 })).toBe(7);
    expect(unitsCartonsPrefill({ lineBoxes: 7, onList: 3, looseOnly: true, fallback: 1 })).toBe(4);
    expect(unitsCartonsPrefill({ lineBoxes: 7, onList: 9, looseOnly: true, fallback: 1 })).toBe(1);
    expect(unitsCartonsPrefill({ lineBoxes: 7, onList: 0, looseOnly: false, fallback: 1 })).toBe(1);
    expect(unitsCartonsPrefill({ lineBoxes: 0, onList: 0, looseOnly: true, fallback: 2 })).toBe(2);
  });
});

describe('expiry splits', () => {
  it('one row covers every carton', () => {
    expect(effectiveSplits(7, [{ cartons: 0, expiry: '2026-11-12' }])).toEqual([{ cartons: 7, expiry: '2026-11-12' }]);
    expect(effectiveSplits(7, [])).toEqual([{ cartons: 7, expiry: '' }]);
  });

  it('+ another expiry takes one carton off the first row', () => {
    const two = addSplit(7, [{ cartons: 0, expiry: '2026-11-12' }]);
    expect(two).toEqual([{ cartons: 6, expiry: '2026-11-12' }, { cartons: 1, expiry: '' }]);
    const three = addSplit(7, two);
    expect(three.map((r) => r.cartons)).toEqual([5, 1, 1]);
  });

  it('removing a row gives its cartons back to the first', () => {
    expect(removeSplit([{ cartons: 5, expiry: 'a' }, { cartons: 1, expiry: 'b' }, { cartons: 1, expiry: 'c' }], 1))
      .toEqual([{ cartons: 6, expiry: 'a' }, { cartons: 1, expiry: 'c' }]);
    expect(removeSplit([{ cartons: 7, expiry: 'a' }], 0)).toEqual([{ cartons: 7, expiry: 'a' }]);
  });
});

describe('unitsSaveBlock', () => {
  const ok = (iso: string) => (iso <= '2026-10-27' ? 'carton.expiryPast' : null);
  const base = { selected: true, saving: false, cartons: 7, perCarton: 18, splits: [{ cartons: 7, expiry: '2026-11-12' }], dateError: ok };

  it('a full save goes through', () => {
    expect(unitsSaveBlock(base)).toBeNull();
  });

  it('says what holds it, in order', () => {
    expect(unitsSaveBlock({ ...base, selected: false })).toBe('item');
    expect(unitsSaveBlock({ ...base, saving: true })).toBe('saving');
    expect(unitsSaveBlock({ ...base, cartons: 0 })).toBe('count');
    expect(unitsSaveBlock({ ...base, perCarton: 0 })).toBe('per');
    expect(unitsSaveBlock({ ...base, splits: [{ cartons: 7, expiry: '' }] })).toBe('expiry');
    expect(unitsSaveBlock({ ...base, splits: [{ cartons: 7, expiry: '2026-10-20' }] })).toBe('date');
  });

  it('several expiries must add up to the cartons, each at least one', () => {
    expect(unitsSaveBlock({ ...base, splits: [{ cartons: 4, expiry: '2026-11-12' }, { cartons: 3, expiry: '2026-11-20' }] })).toBeNull();
    expect(unitsSaveBlock({ ...base, splits: [{ cartons: 4, expiry: '2026-11-12' }, { cartons: 2, expiry: '2026-11-20' }] })).toBe('split_sum');
    expect(unitsSaveBlock({ ...base, splits: [{ cartons: 7, expiry: '2026-11-12' }, { cartons: 0, expiry: '2026-11-20' }] })).toBe('split_sum');
    expect(unitsSaveBlock({ ...base, splits: [{ cartons: 4, expiry: '2026-11-12' }, { cartons: 3, expiry: '' }] })).toBe('expiry');
  });
});

describe('the save request', () => {
  it('payload: no weight, units per carton, one entry per split, loose pile', () => {
    const p = unitsLabelPayload({
      palletNumber: 0, item: KK117, cartons: 7, perCarton: 18,
      splits: [{ cartons: 4, expiry: '2026-11-12' }, { cartons: 3, expiry: '2026-11-20' }], printBarcode: true,
    });
    expect(p).toMatchObject({
      origin: 'new_carton', pallet_number: 0, item_code: 'KK117', weight_kg: null, quantity: 7, units_per_carton: 18,
      splits: [{ quantity: 4, expiry_date: '2026-11-12' }, { quantity: 3, expiry_date: '2026-11-20' }],
      expiry_date: '2026-11-12', production_date: null,
    });
  });

  it('server parse: absent units = not a units save', () => {
    expect(parseUnitsRequest({ quantity: 3 })).toBeNull();
    expect(parseUnitsRequest({ quantity: 3, units_per_carton: null })).toBeNull();
  });

  it('server parse: checks per carton, splits and their sum', () => {
    const splits = [{ quantity: 4, expiry_date: '2026-11-12' }, { quantity: 3, expiry_date: '2026-11-20' }];
    expect(parseUnitsRequest({ quantity: 7, units_per_carton: 18, splits })).toEqual({
      ok: true, perCarton: 18, splits: [{ quantity: 4, expiry: '2026-11-12' }, { quantity: 3, expiry: '2026-11-20' }],
    });
    expect(parseUnitsRequest({ quantity: 8, units_per_carton: 18, splits })).toMatchObject({ ok: false });
    expect(parseUnitsRequest({ quantity: 7, units_per_carton: 0, splits })).toMatchObject({ ok: false });
    expect(parseUnitsRequest({ quantity: 7, units_per_carton: 1.5, splits })).toMatchObject({ ok: false });
    expect(parseUnitsRequest({ quantity: 7, units_per_carton: 18, splits: [] })).toMatchObject({ ok: false });
    expect(parseUnitsRequest({ quantity: 7, units_per_carton: 18, splits: [{ quantity: 7, expiry_date: '12/11/2026' }] })).toMatchObject({ ok: false });
    expect(parseUnitsRequest({ quantity: 7, units_per_carton: 18, splits: [{ quantity: 7 }] })).toMatchObject({ ok: false });
  });

  it('one expiry per label, split by split', () => {
    expect(splitExpiries([{ quantity: 2, expiry: 'a' }, { quantity: 1, expiry: 'b' }])).toEqual(['a', 'a', 'b']);
  });

  it('a retry matches the stored batch only when it is the same save', () => {
    const stored = [
      { item_code: 'KK117', item_name_hebrew: 'מנה', item_name_english: 'Meal', units_per_carton: 18, expiry_date: '2026-11-20', pallet_number: 0 },
      { item_code: 'KK117', item_name_hebrew: 'מנה', item_name_english: 'Meal', units_per_carton: 18, expiry_date: '2026-11-12', pallet_number: 0 },
    ];
    const req = { itemCode: 'KK117', itemNameHebrew: 'מנה', itemNameEnglish: 'Meal', perCarton: 18, expiries: ['2026-11-12', '2026-11-20'], palletNumber: 0 };
    expect(unitsBatchMatches(stored, req)).toBe(true);
    expect(unitsBatchMatches(stored, { ...req, perCarton: 12 })).toBe(false);
    expect(unitsBatchMatches(stored, { ...req, expiries: ['2026-11-12', '2026-11-12'] })).toBe(false);
    expect(unitsBatchMatches(stored, { ...req, expiries: ['2026-11-12'] })).toBe(false);
    expect(unitsBatchMatches(stored, { ...req, itemCode: 'KK100' })).toBe(false);
    expect(unitsBatchMatches([], req)).toBe(false);
  });
});

describe('unitsCartonRows', () => {
  const labels = [
    { barcode: '2826102700000001', batch_id: 'b1', expiry_date: '2026-11-12', item_name_hebrew: 'מנה', item_name_english: 'Meal', units_per_carton: 18 },
    { barcode: '2826102700000002', batch_id: 'b1', expiry_date: '2026-11-20', item_name_hebrew: 'מנה', item_name_english: 'Meal', units_per_carton: null },
  ];

  it('one row per label: weight 0, its units, the shared batch, its own expiry', () => {
    const rows = unitsCartonRows(labels, { perCarton: 18, unitsBatch: 'b1', now: 'T' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      barcode: '2826102700000001', sku: '2826102700000', weight: 0, units: 18, units_batch: 'b1',
      expiry: '2026-11-12', minted: true, new_carton: true, label_batch_id: 'b1', weight_checked: true,
      item_name_hebrew: 'מנה', item_name: 'Meal', scanned_at: 'T',
    });
    // A label without its own units falls back to the save's.
    expect(rows[1]).toMatchObject({ units: 18, expiry: '2026-11-20' });
    expect(rows.every(isUnitsCarton)).toBe(true);
  });
});

describe('grouping the list', () => {
  type R = { barcode: string; units?: number; units_batch?: string; expiry?: string };
  const list: R[] = [
    { barcode: 'k1' },
    { barcode: 'u1', units: 18, units_batch: 'A', expiry: '2026-11-20' },
    { barcode: 'k2' },
    { barcode: 'u2', units: 18, units_batch: 'A', expiry: '2026-11-12' },
    { barcode: 'v1', units: 6, units_batch: 'B', expiry: '2026-12-01' },
  ];

  it('one entry per units save, at its first carton; others one each', () => {
    const e = groupUnitsRows(list, (_, i) => i + 1);
    expect(e.map((x) => (x.kind === 'box' ? x.box.barcode : `units:${x.batch}`))).toEqual(['k1', 'units:A', 'k2', 'units:B']);
    const a = e[1];
    expect(a.kind === 'units' && a.rows.map((r) => [r.box.barcode, r.index])).toEqual([['u1', 2], ['u2', 4]]);
  });

  it('a list without units cartons is unchanged', () => {
    const plain = [{ barcode: 'a' }, { barcode: 'b', units: 0, units_batch: 'X' }];
    expect(groupUnitsRows(plain, (_, i) => 10 - i)).toEqual([
      { kind: 'box', box: plain[0], index: 10 },
      { kind: 'box', box: plain[1], index: 9 },
    ]);
  });

  it('summary: cartons, units, first expiry and how many more', () => {
    expect(unitsBatchSummary([list[1], list[3]])).toEqual({ cartons: 2, units: 36, firstExpiry: '2026-11-12', moreExpiries: 1 });
    expect(unitsBatchSummary([list[4]])).toEqual({ cartons: 1, units: 6, firstExpiry: '2026-12-01', moreExpiries: 0 });
  });

  it('short expiry is dd/mm/yy', () => {
    expect(shortExpiry('2026-11-12')).toBe('12/11/26');
    expect(shortExpiry('')).toBe('');
    expect(shortExpiry(undefined)).toBe('');
  });
});

describe('sanitizeUnitsBoxes (the loose payload)', () => {
  it('a kg carton passes through as the same object', () => {
    const kg = { barcode: '1', weight: 12.4, expiry: '2026-11-12' };
    const out = sanitizeUnitsBoxes([kg]);
    expect(out[0]).toBe(kg);
  });

  it('a units carton goes with its units and weight 0', () => {
    expect(sanitizeUnitsBoxes([{ barcode: '1', weight: 5, units: 18 }])).toEqual([{ barcode: '1', weight: 0, units: 18 }]);
    expect(sanitizeUnitsBoxes([{ barcode: '1', weight: 0, units: '18' as unknown as number }])).toEqual([{ barcode: '1', weight: 0, units: 18 }]);
  });

  it('a bad units value is dropped, the weight kept', () => {
    expect(sanitizeUnitsBoxes([{ barcode: '1', weight: 5, units: 0 }])).toEqual([{ barcode: '1', weight: 5 }]);
    expect(sanitizeUnitsBoxes([{ barcode: '1', weight: 5, units: 2.5 }])).toEqual([{ barcode: '1', weight: 5 }]);
  });
});

describe('singular strings and the kg total', () => {
  it('one carton picks the singular row', () => {
    expect(unitsRowKey(1)).toBe('carton.unitsRowOne');
    expect(unitsRowKey(2)).toBe('carton.unitsRow');
  });

  it('the kg total leaves units lines out (008955: 126 + 126 units is not 252 kg)', () => {
    expect(invoiceKgTotal([KK117, { ...KK117, item_code: 'KK100' }])).toBe(0);
    expect(invoiceKgTotal([KK117, { quantity_kg: 40.5 }, { unit: 'kg', quantity_kg: 9.5 }, { quantity_kg: null }])).toBe(50);
  });
});
