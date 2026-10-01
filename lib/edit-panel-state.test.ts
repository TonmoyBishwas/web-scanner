import { describe, it, expect } from 'vitest';
import {
  weightState,
  nameState,
  expiryState,
  localIsoDate,
  firstField,
  fieldAfterItemPick,
  fieldAfterExpiryPick,
  missingList,
  gateMissing,
  saveMode,
  tileState,
  itemOptions,
} from './edit-panel-state';

// Carton 7290001455258 of IN264172698 (2026-09-24): the OCR read no weight and
// no expiry, and picked invoice line 1 (chicken thighs) for a tilapia carton.
const THIGHS = "פרגית קפוא תפז' עדה החרדית";
const TODAY = '2026-09-24';

describe('weightState', () => {
  it("'' is missing", () => expect(weightState('')).toBe('missing'));
  it('blank space is missing', () => expect(weightState('  ')).toBe('missing'));
  it("'0' is invalid", () => expect(weightState('0')).toBe('invalid'));
  it("'.' and '0.0' are invalid", () => {
    expect(weightState('.')).toBe('invalid');
    expect(weightState('0.0')).toBe('invalid');
  });
  it("'10' and '10.25' are ok", () => {
    expect(weightState('10')).toBe('ok');
    expect(weightState('10.25')).toBe('ok');
  });
  it("a half-typed '0.' that is still 0 is invalid, '0.5' is ok", () => {
    expect(weightState('0.')).toBe('invalid');
    expect(weightState('0.5')).toBe('ok');
  });
});

describe('nameState', () => {
  const chips = (active: boolean[]) => active.map((a) => ({ active: a }));
  it('a blank name is missing', () => {
    expect(nameState('', chips([false, false]))).toBe('missing');
    expect(nameState('   ', chips([true]))).toBe('missing');
  });
  it('a name that is one of the invoice lines is ok', () => {
    expect(nameState(THIGHS, chips([true, false, false]))).toBe('ok');
  });
  it('a name on no invoice line is offInvoice (salmon fillet read off the sticker)', () => {
    expect(nameState('פילה סלמון עם עור קפוא', chips([false, false, false]))).toBe('offInvoice');
  });
  it('with no invoice lines at all, any name is ok', () => {
    expect(nameState('anything', [])).toBe('ok');
  });
});

describe('expiryState', () => {
  it("'' is missing", () => expect(expiryState('', TODAY)).toBe('missing'));
  it('today is past — the calendar default, not a sticker date', () => {
    expect(expiryState(TODAY, TODAY)).toBe('past');
  });
  it('yesterday is past', () => expect(expiryState('2026-09-23', TODAY)).toBe('past'));
  it('tomorrow and later are ok', () => {
    expect(expiryState('2026-09-25', TODAY)).toBe('ok');
    expect(expiryState('2027-10-31', TODAY)).toBe('ok');
  });
});

describe('localIsoDate', () => {
  it('formats the local calendar day, zero-padded', () => {
    expect(localIsoDate(new Date(2026, 8, 4, 23, 59))).toBe('2026-09-04');
    expect(localIsoDate(new Date(2027, 0, 31, 0, 1))).toBe('2027-01-31');
  });
});

describe('firstField', () => {
  it('a blank name opens on the item', () => {
    expect(firstField('', '', '')).toBe('name');
    expect(firstField('', '10', '2027-01-01')).toBe('name');
  });
  it('the replayed carton (name set, no weight, no expiry) opens on weight', () => {
    expect(firstField(THIGHS, '', '')).toBe('weight');
  });
  it('a weight of 0 counts as not done', () => {
    expect(firstField(THIGHS, '0', '2027-01-01')).toBe('weight');
  });
  it('only the expiry missing opens on expiry', () => {
    expect(firstField(THIGHS, '10', '')).toBe('expiry');
  });
  it('a complete carton opens on weight', () => {
    expect(firstField(THIGHS, '10', '2027-01-01')).toBe('weight');
  });
});

describe('fieldAfterItemPick', () => {
  it('moves on to the weight when it is still missing or 0', () => {
    expect(fieldAfterItemPick('', '')).toBe('weight');
    expect(fieldAfterItemPick('0', '2027-01-01')).toBe('weight');
  });
  it('then to the expiry', () => expect(fieldAfterItemPick('10', '')).toBe('expiry'));
  it('stays on the item list when nothing is missing', () => {
    expect(fieldAfterItemPick('10', '2027-01-01')).toBe('name');
  });
});

describe('fieldAfterExpiryPick', () => {
  it('goes back to the item when it is blank', () => {
    expect(fieldAfterExpiryPick('', '10')).toBe('name');
  });
  it('then to a missing or 0 weight', () => {
    expect(fieldAfterExpiryPick(THIGHS, '')).toBe('weight');
    expect(fieldAfterExpiryPick(THIGHS, '0')).toBe('weight');
  });
  it('stays on the expiry when the rest is done', () => {
    expect(fieldAfterExpiryPick(THIGHS, '10')).toBe('expiry');
  });
});

describe('missingList', () => {
  it('the replayed carton lists weight and expiry', () => {
    expect(missingList({ name: THIGHS, weight: '', expiry: '' })).toEqual(['weight', 'expiry']);
  });
  it('after typing 10 only the expiry is left', () => {
    expect(missingList({ name: THIGHS, weight: '10', expiry: '' })).toEqual(['expiry']);
  });
  it('a weight of 0 is still listed: it will not be saved', () => {
    expect(missingList({ name: THIGHS, weight: '0', expiry: '2027-01-01' })).toEqual(['weight']);
  });
  it('a past expiry is not missing — its tile says what is wrong', () => {
    expect(missingList({ name: THIGHS, weight: '10', expiry: '2020-01-01' })).toEqual([]);
  });
  it('barcode first, then item, weight, expiry', () => {
    expect(missingList({ name: '', weight: '', expiry: '', barcodeMissing: true }))
      .toEqual(['barcode', 'name', 'weight', 'expiry']);
  });
});

describe('gateMissing', () => {
  it('name + weight above 0 + identity = complete; the expiry does not gate', () => {
    expect(gateMissing({ name: THIGHS, weight: '10' })).toBe(false);
  });
  it('a missing or 0 weight, a blank name, or no barcode keeps the flag', () => {
    expect(gateMissing({ name: THIGHS, weight: '' })).toBe(true);
    expect(gateMissing({ name: THIGHS, weight: '0' })).toBe(true);
    expect(gateMissing({ name: '', weight: '10' })).toBe(true);
    expect(gateMissing({ name: THIGHS, weight: '10', barcodeMissing: true })).toBe(true);
  });
});

describe('saveMode', () => {
  const base = { dirty: false, hasConflict: false, needsReview: false, gateMissing: false };
  it('untouched, unflagged, no conflict → disabled', () => {
    expect(saveMode(base)).toBe('disabled');
    expect(saveMode({ ...base, gateMissing: true })).toBe('disabled');
  });
  it('is never disabled for a flagged carton, even untouched', () => {
    expect(saveMode({ ...base, needsReview: true })).not.toBe('disabled');
    expect(saveMode({ ...base, needsReview: true, gateMissing: true })).not.toBe('disabled');
  });
  it('is never disabled for a barcode-vs-OCR conflict, even untouched', () => {
    expect(saveMode({ ...base, hasConflict: true })).toBe('ready');
    expect(saveMode({ ...base, hasConflict: true, gateMissing: true })).toBe('warn');
  });
  it('dirty with a gate field missing → warn (it still saves)', () => {
    expect(saveMode({ ...base, dirty: true, gateMissing: true })).toBe('warn');
  });
  it('dirty and complete → ready', () => {
    expect(saveMode({ ...base, dirty: true })).toBe('ready');
  });
});

describe('tileState', () => {
  const ok = { weight: 'ok', name: 'ok', expiry: 'ok' } as const;
  it('missing wins over changed', () => {
    expect(tileState('weight', { ...ok, weight: 'missing' }, true)).toBe('missing');
    expect(tileState('expiry', { ...ok, expiry: 'missing' }, false)).toBe('missing');
    expect(tileState('name', { ...ok, name: 'missing' }, true)).toBe('missing');
  });
  it('a weight of 0 and a past expiry are invalid', () => {
    expect(tileState('weight', { ...ok, weight: 'invalid' }, true)).toBe('invalid');
    expect(tileState('expiry', { ...ok, expiry: 'past' }, true)).toBe('invalid');
  });
  it('a name on no invoice line is offInvoice', () => {
    expect(tileState('name', { ...ok, name: 'offInvoice' }, false)).toBe('offInvoice');
  });
  it('a valid value is changed when edited, idle when not', () => {
    expect(tileState('weight', ok, true)).toBe('changed');
    expect(tileState('weight', ok, false)).toBe('idle');
    expect(tileState('name', ok, true)).toBe('changed');
  });
});

describe('itemOptions', () => {
  const TILAPIA = 'אמנון פילה 3-5 תפזורת - בד"ץ עדה חרדית';
  it('one row per invoice line, in invoice order, with its code', () => {
    expect(itemOptions([
      { item_code: '1001', item_name_hebrew: THIGHS, item_name_english: 'Chicken thighs' },
      { item_code: '1002', item_name_hebrew: TILAPIA, item_name_english: '' },
    ])).toEqual([
      { he: THIGHS, en: 'Chicken thighs', codes: ['1001'] },
      { he: TILAPIA, en: '', codes: ['1002'] },
    ]);
  });
  it('two lines with the same name become one row listing both codes', () => {
    const rows = itemOptions([
      { item_code: '1001', item_name_hebrew: THIGHS, item_name_english: 'Chicken thighs' },
      { item_code: '1002', item_name_hebrew: TILAPIA },
      { item_code: '1003', item_name_hebrew: THIGHS, item_name_english: 'Chicken thighs' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].codes).toEqual(['1001', '1003']);
  });
  it('drops nameless lines and tolerates null fields', () => {
    expect(itemOptions([
      { item_code: '9', item_name_hebrew: null, item_name_english: null },
      { item_code: null, item_name_hebrew: null, item_name_english: 'Salmon' },
    ])).toEqual([{ he: '', en: 'Salmon', codes: [] }]);
  });
});
