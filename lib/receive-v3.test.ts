import { describe, expect, it } from 'vitest';
import { normalizeFormLines, type FormLine } from './receipt-form';
import {
  addSplitRowPatch,
  balanceSplit,
  dateCheck,
  differsFromNote,
  dottedToIso,
  expState,
  expandDate,
  initialV3Draft,
  isoToDotted,
  lineMode,
  lineStatusV3,
  mergeV3Draft,
  packagingOrder,
  palletOf,
  pkgWord,
  railState,
  remainingLines,
  removeSplitRowPatch,
  resetToNotePatch,
  restoreV3Draft,
  searchV3,
  serializeV3Draft,
  setCartonsPatch,
  setSplitQtyPatch,
  shortBy,
  shortSupplierName,
  shouldAutoOpenPalletList,
  splitBasis,
  splitState,
  startSplitPatch,
  typeDate,
  v3DraftStorageKey,
  type V3Draft,
  type V3LineDraft,
} from './receive-v3';

/**
 * lib/receive-v3.ts — the v3 receive form's pure logic (flag
 * receive_form_v3). Fixture: the Bnei Darom test form (18 lines, 06/11),
 * exactly as GET /api/receipt-form/{id} served it.
 */
const TODAY = '2026-11-06';

// [index, code, name_he, qty, unit, unit_label, weighed, cartons, packaging, per_pack, inner]
const RAW: [number, string, string, number, string, string, boolean, number, string, number | null, string | null][] = [
  [1, '92028', 'קסיבשאב גמבה קוביות פח 9 ליטר בד"ץ', 7, 'units', 'יחידות', false, 7, 'can', null, null],
  [2, '92029', 'קסיבשאב וופל מצופה בטעם אגוזים קרטון בד"ץ (40*12 יח\')', 8, 'cartons', 'קרטונים', false, 8, 'carton', null, null],
  [3, '92030', 'קסיבשאג חומץ 5% מכוהל בני דרום גלון בד"ץ', 3, 'units', 'יחידות', false, 1, 'carton', 3, 'gallon'],
  [4, '92031', 'קסיבשלא טחינה 18 ק"ג אלואזי בד"ץ', 2, 'units', 'יחידות', false, 2, 'bucket', null, null],
  [5, '92032', 'קסיבשמא כורכום 5 ק"ג בני דרום בד"ץ', 20, 'kg', 'ק"ג', true, 20, 'sack', null, null],
  [6, '92033', 'קסיבשעא מיונז 5 ק"ג תלמה בד"ץ', 2, 'units', 'יחידות', false, 2, 'bucket', null, null],
  [7, '92034', 'קסיבשפא מיץ לימון גלון 2 ליטר עסיס-אוסם בד"ץ', 18, 'units', 'יחידות', false, 3, 'carton', 6, 'gallon'],
  [8, '92035', 'קסיבשצא מיץ ענבים רמי לוי ליטר בד"ץ', 24, 'units', 'יחידות', false, 2, 'carton', 12, 'bottle'],
  [9, '92036', 'קסיבשקא מלח דק ק"ג בד"ץ', 156, 'units', 'יחידות', false, 13, 'carton', 12, 'unit'],
  [10, '92037', 'קסיבשתא מלפפון פרוס במלח 9 ליטר בד"ץ קבוצת יבנה', 7, 'units', 'יחידות', false, 7, 'can', null, null],
  [11, '92038', 'קסיבשא מנות אלף איים מיטב 1000 יח\' בד"ץ', 5, 'cartons', 'קרטונים', false, 5, 'carton', null, null],
  [12, '92039', 'קסיבשנא מנות רוטב שום מיטב 1000 יח\' בד"ץ', 5, 'cartons', 'קרטונים', false, 5, 'carton', null, null],
  [13, '92040', 'קסיבשטא סוכר עז ק"ג בד"ץ', 80, 'units', 'יחידות', false, 8, 'carton', 10, 'unit'],
  [14, '92041', 'קסיבשסא עגבניות קוביות A9 פריניר בד"ץ', 30, 'units', 'יחידות', false, 5, 'carton', 6, 'unit'],
  [15, '92042', 'קסיבשדא פטריות חתוך A9 בד"ץ', 12, 'units', 'יחידות', false, 2, 'carton', 6, 'unit'],
  [16, '92043', 'קסיבשרא פירורית זהב 10 ק"ג דווידוביץ שק צהוב בד"ץ', 3, 'packs', 'מארזים', false, 3, 'sack', null, null],
  [17, '92044', 'קסיבשהא פלפל שחור טחון ק"ג ברמן בד"ץ', 20, 'kg', 'ק"ג', true, 20, 'sack', null, null],
  [18, '92045', 'קסיבשחא פפריקה מתוקה ק"ג ברמן בד"ץ', 40, 'kg', 'ק"ג', true, 40, 'sack', null, null],
];

const LINES: FormLine[] = normalizeFormLines(
  RAW.map(([index, code, name_he, qty, unit, unit_label, weighed, cartons, packaging, per_pack, inner]) => ({
    index, code, name_he, name_en: '', qty, unit, unit_label, weighed, cartons, packaging, per_pack, inner, needs_expiry: true,
  })),
);
const L = (i: number) => LINES[i - 1];

/** A draft with `pallets` and line i patched. */
function draftWith(pallets: number, patches: Record<number, Partial<V3LineDraft>> = {}, loose: Record<number, number> = {}): V3Draft {
  const d = initialV3Draft(LINES);
  return {
    ...d,
    stage: 'list',
    pallets,
    loose,
    lines: d.lines.map((l) => (patches[l.index] ? { ...l, ...patches[l.index] } : l)),
  };
}
const D = (draft: V3Draft, i: number) => draft.lines[i - 1];

describe('lineMode (spec 7.1, the Bnei Darom fixture)', () => {
  it("same / pack / kg per line (the prototype's three modes only)", () => {
    const byMode = { same: [] as number[], pack: [] as number[], kg: [] as number[] };
    for (const l of LINES) byMode[lineMode(l)].push(l.index);
    expect(byMode).toEqual({
      same: [1, 2, 4, 6, 10, 11, 12, 16],
      pack: [3, 7, 8, 9, 13, 14, 15],
      kg: [5, 17, 18],
    });
  });

  it('a counted line whose packages are not its units and no per_pack: one stepper (pack layout), never two fields [INFERRED]', () => {
    expect(lineMode({ ...L(1), cartons: 2, qty: 7 })).toBe('pack');
    expect(lineMode({ ...L(1), cartons: null })).toBe('pack');
    // The stepper changes the packages only: the 7 units stay (no per_pack to derive them from).
    const line = { ...L(1), cartons: 2, qty: 7 };
    const d = { ...D(draftWith(1), 1), qty: '7', cartons: '2' };
    expect(setCartonsPatch(line, d, '3')).toEqual({ cartons: '3', edited: true });
  });
});

describe('initialV3Draft', () => {
  it('pre-fills from the note, step 1 first, 0 pallets', () => {
    const d = initialV3Draft(LINES);
    expect(d).toMatchObject({ stage: 'pallets', pallets: 0, loose: {}, lastPallet: null, extras: [] });
    expect(d.lines[2]).toEqual({
      index: 3, qty: '3', cartons: '1', packaging: 'carton', expiry: '', noExpiry: false, split: null,
      gap: null, gapNote: '', pallet: null, ack: false, edited: false,
    });
  });
});

describe('date typing (spec 7.5)', () => {
  const typeAll = (keys: string) => {
    let v = '';
    for (const k of keys) {
      const raw = v + k;
      v = typeDate(raw, v, raw.length);
    }
    return v;
  };

  it('dots after 2 and 4 digits; 8 digits', () => {
    expect(typeAll('12052027')).toBe('12.05.2027');
    expect(typeAll('1205')).toBe('12.05');
    expect(typeAll('12')).toBe('12');
  });

  it("6 digits whose year part is not 19/20 expand at once ('120527' → 12.05.2027)", () => {
    expect(typeAll('120527')).toBe('12.05.2027');
    expect(typeAll('010525')).toBe('01.05.2025');
  });

  it('6 digits ending 19/20 stay until blur (the worker may be typing 2027); blur expands any 6 digits', () => {
    expect(typeAll('120520')).toBe('12.05.20');
    expect(typeAll('120519')).toBe('12.05.19');
    expect(expandDate('12.05.20')).toBe('12.05.2020');
    expect(expandDate('12.05.27')).toBe('12.05.2027');
    expect(expandDate('12.05.2027')).toBe('12.05.2027');
    expect(expandDate('12.05')).toBe('12.05');
  });

  it('more than 8 digits are cut; non-digits dropped', () => {
    expect(typeDate('12.05.20271', '12.05.2027', 11)).toBe('12.05.2027');
    expect(typeDate('12a/05', '', 6)).toBe('12.05');
  });

  it('backspace right after a dot deletes the digit before it (cursor-aware)', () => {
    // An ordinary backspace on a digit.
    expect(typeDate('12.0', '12.05', 4)).toBe('12.0');
    // '12.05', cursor after the dot, backspace: only the dot went → the '2' before it goes.
    expect(typeDate('1205', '12.05', 2)).toBe('10.5');
    // '12.' + cursor after the dot; deleting the dot ('12' left, same digits) removes '2'.
    expect(typeDate('12', '12.', 2)).toBe('1');
    // Deleting the second dot of '12.05.2' at the cursor after it removes the '5'.
    expect(typeDate('12.052', '12.05.2', 5)).toBe('12.02');
  });

  it('dottedToIso / isoToDotted', () => {
    expect(dottedToIso('12.05.2027')).toBe('2027-05-12');
    expect(dottedToIso('31.02.2027')).toBeNull();
    expect(dottedToIso('12.05.27')).toBeNull();
    expect(isoToDotted('2027-05-12')).toBe('12.05.2027');
    expect(isoToDotted('junk')).toBe('');
  });

  it('dateCheck: empty, partial, invalid, past (today too), far, ok — the server rule', () => {
    expect(dateCheck('', TODAY)).toBe('empty');
    expect(dateCheck('12.05', TODAY)).toBe('partial');
    expect(dateCheck('31.02.2027', TODAY)).toBe('invalid');
    expect(dateCheck('06.11.2026', TODAY)).toBe('past');
    expect(dateCheck('01.05.2025', TODAY)).toBe('past');
    expect(dateCheck('07.11.2026', TODAY)).toBe('ok');
    expect(dateCheck('01.01.2045', TODAY)).toBe('far');
    expect(dateCheck('06.11.2041', TODAY)).toBe('ok');
    expect(dateCheck('07.11.2041', TODAY)).toBe('far');
  });
});

describe('expState / palletOf / lineStatusV3 (spec 7.3)', () => {
  it('status order: fix → gap → expiry → pallet → ready', () => {
    let d = draftWith(2, { 4: { qty: 'x' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('fix');
    d = draftWith(2, { 4: { qty: '1' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('gap');
    d = draftWith(2, { 4: { qty: '1', gap: 'other', gapNote: '  ' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('gap');
    d = draftWith(2, { 4: { qty: '1', gap: 'will' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('expiry');
    d = draftWith(2, { 4: { qty: '1', gap: 'will', expiry: '12.05' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('expiry');
    d = draftWith(2, { 4: { qty: '1', gap: 'will', expiry: '12.05.2025' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('fix');
    d = draftWith(2, { 4: { qty: '1', gap: 'will', expiry: '12.05.2027' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('pallet');
    d = draftWith(2, { 4: { qty: '1', gap: 'will', expiry: '12.05.2027', pallet: 2 } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('ready');
  });

  it('more than 1e6, or a junk package count, is fix', () => {
    let d = draftWith(1, { 4: { qty: '1000001' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('fix');
    d = draftWith(1, { 4: { cartons: '2x', expiry: '12.05.2027' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('fix');
  });

  it('over the note needs no reason', () => {
    const d = draftWith(1, { 4: { qty: '5', expiry: '12.05.2027' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('ready');
  });

  it('quantity 0 needs no expiry and no pallet (but a reason)', () => {
    let d = draftWith(2, { 4: { qty: '0', gap: 'wont' } });
    expect(expState(L(4), D(d, 4), TODAY)).toBe('ok');
    expect(palletOf(L(4), D(d, 4), d)).toBe('none');
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('ready');
    d = draftWith(2, { 4: { qty: '0' } });
    expect(lineStatusV3(L(4), D(d, 4), d, TODAY)).toBe('gap');
  });

  it('a line that does not need an expiry is fine with none; "no expiry" is always ok', () => {
    const line = { ...L(4), needs_expiry: false };
    const d = draftWith(1);
    expect(expState(line, D(d, 4), TODAY)).toBe('ok');
    expect(lineStatusV3(line, D(d, 4), d, TODAY)).toBe('ready');
    expect(expState(L(4), D(d, 4), TODAY)).toBe('empty');
    expect(expState(L(4), { ...D(d, 4), noExpiry: true }, TODAY)).toBe('ok');
    expect(expState(L(4), { ...D(d, 4), expiry: '01.01.2045' }, TODAY)).toBe('far');
  });

  it('palletOf: 0 pallets → loose; 1 → 1; 2 with no choice → null; a choice above the count → null; ticked loose → loose', () => {
    expect(palletOf(L(1), D(draftWith(0), 1), draftWith(0))).toBe('loose');
    expect(palletOf(L(1), D(draftWith(1), 1), draftWith(1))).toBe(1);
    expect(palletOf(L(1), D(draftWith(2), 1), draftWith(2))).toBeNull();
    let d = draftWith(2, { 1: { pallet: 2 } });
    expect(palletOf(L(1), D(d, 1), d)).toBe(2);
    d = draftWith(1, { 1: { pallet: 2 } });
    expect(palletOf(L(1), D(d, 1), d)).toBe(1);
    d = { ...draftWith(3, { 1: { pallet: 3 } }) };
    d.pallets = 2; // lowered below the chosen pallet: "חסר משטח" again
    expect(palletOf(L(1), D(d, 1), d)).toBeNull();
    expect(lineStatusV3(L(1), { ...D(d, 1), expiry: '12.05.2027' }, d, TODAY)).toBe('pallet');
    d = draftWith(2, {}, { 1: 3 });
    expect(palletOf(L(1), D(d, 1), d)).toBe('loose');
  });

  it('remainingLines: indexes not ready, in note order', () => {
    const ready = { expiry: '12.05.2027' };
    const patches: Record<number, Partial<V3LineDraft>> = {};
    for (const l of LINES) patches[l.index] = ready;
    delete patches[2];
    delete patches[14];
    const d = draftWith(1, patches);
    expect(remainingLines(LINES, d, TODAY)).toEqual([2, 14]);
    expect(remainingLines(LINES, draftWith(1, Object.fromEntries(LINES.map((l) => [l.index, ready]))), TODAY)).toEqual([]);
  });
});

describe('the rail (spec 7.3)', () => {
  it('step 1 done once acknowledged or edited and not short-without-reason / broken', () => {
    let d = draftWith(2);
    expect(railState(L(4), D(d, 4), d, TODAY)).toEqual({ s1: false, s2: false, s3: false, active: 1 });
    d = draftWith(2, { 4: { ack: true } });
    expect(railState(L(4), D(d, 4), d, TODAY)).toEqual({ s1: true, s2: false, s3: false, active: 2 });
    d = draftWith(2, { 4: { ack: true, qty: '1' } });
    expect(railState(L(4), D(d, 4), d, TODAY).s1).toBe(false);
    d = draftWith(2, { 4: { edited: true, expiry: '12.05.2027' } });
    expect(railState(L(4), D(d, 4), d, TODAY)).toEqual({ s1: true, s2: true, s3: false, active: 3 });
    d = draftWith(2, { 4: { edited: true, expiry: '12.05.2027', pallet: 1 } });
    expect(railState(L(4), D(d, 4), d, TODAY)).toEqual({ s1: true, s2: true, s3: true, active: 3 });
  });

  it('the inline pallet list opens by itself only with ≥ 2 pallets, no pallet, steps 1–2 done, not closed by ×', () => {
    const d = draftWith(2, { 4: { ack: true, expiry: '12.05.2027' } });
    expect(shouldAutoOpenPalletList(L(4), D(d, 4), d, TODAY, false)).toBe(true);
    expect(shouldAutoOpenPalletList(L(4), D(d, 4), d, TODAY, true)).toBe(false);
    const one = { ...d, pallets: 1 };
    expect(shouldAutoOpenPalletList(L(4), D(one, 4), one, TODAY, false)).toBe(false);
    const notAck = draftWith(2, { 4: { expiry: '12.05.2027' } });
    expect(shouldAutoOpenPalletList(L(4), D(notAck, 4), notAck, TODAY, false)).toBe(false);
    const set = draftWith(2, { 4: { ack: true, expiry: '12.05.2027', pallet: 2 } });
    expect(shouldAutoOpenPalletList(L(4), D(set, 4), set, TODAY, false)).toBe(false);
  });
});

describe('step 1 edits (spec 7.2)', () => {
  it('same: the quantity follows the package count; blank = 0', () => {
    const d = D(draftWith(1), 4);
    expect(setCartonsPatch(L(4), d, '1')).toEqual({ cartons: '1', qty: '1', edited: true });
    expect(setCartonsPatch(L(4), d, '')).toEqual({ cartons: '', qty: '0', edited: true });
    expect(setCartonsPatch(L(4), d, '007')).toEqual({ cartons: '7', qty: '7', edited: true });
  });

  it('pack: the units total follows while it equalled packages × per pack', () => {
    const d = D(draftWith(1), 7); // 3 cartons × 6 = 18
    expect(setCartonsPatch(L(7), d, '4')).toEqual({ cartons: '4', qty: '24', edited: true });
  });

  it('pack: a total the worker typed stays', () => {
    const d = { ...D(draftWith(1), 7), qty: '17' };
    expect(setCartonsPatch(L(7), d, '4')).toEqual({ cartons: '4', edited: true });
  });

  it('kg: packages alone', () => {
    const d = D(draftWith(1), 5);
    expect(setCartonsPatch(L(5), d, '19')).toEqual({ cartons: '19', edited: true });
  });

  it('resetToNotePatch / differsFromNote / shortBy', () => {
    const d = { ...D(draftWith(1), 7), qty: '12', cartons: '2', packaging: 'box' as const, gap: 'other' as const, gapNote: 'x', split: [{ qty: '1', date: '' }] };
    expect(differsFromNote(L(7), d)).toBe(true);
    expect(shortBy(L(7), d)).toBe(6);
    const reset = { ...d, ...resetToNotePatch(L(7)) };
    expect(reset).toMatchObject({ qty: '18', cartons: '3', packaging: 'carton', gap: null, gapNote: '', split: null });
    expect(differsFromNote(L(7), reset)).toBe(false);
    expect(shortBy(L(7), reset)).toBe(0);
    expect(differsFromNote(L(5), { ...D(draftWith(1), 5), qty: '20.0' })).toBe(false);
    expect(shortBy(L(5), { ...D(draftWith(1), 5), qty: '19.5' })).toBe(0.5);
  });
});

describe('split by expiry (spec 7.4)', () => {
  it("basis: step 1's quantity for every mode (the prototype's splitState tot = qty)", () => {
    expect(splitBasis(L(7), D(draftWith(1), 7))).toBe(18); // pack: 3 cartons × 6 = 18 units
    expect(splitBasis(L(7), { ...D(draftWith(1), 7), qty: '17' })).toBe(17); // a typed total
    expect(splitBasis(L(4), D(draftWith(1), 4))).toBe(2);
    expect(splitBasis(L(5), D(draftWith(1), 5))).toBe(20);
  });

  it('start: the whole basis on the current date + an empty row, no expiry off', () => {
    const d = { ...D(draftWith(1), 7), expiry: '12.05.2027', noExpiry: true };
    expect(startSplitPatch(L(7), d)).toEqual({ split: [{ qty: '18', date: '12.05.2027' }, { qty: '', date: '' }], noExpiry: false });
  });

  it('rows after the first re-balance row 1; row 1 does not', () => {
    const d = { ...D(draftWith(1), 7), split: [{ qty: '18', date: '12.05.2027' }, { qty: '', date: '' }] };
    const p = setSplitQtyPatch(L(7), d, 1, '6');
    expect(p.split).toEqual([{ qty: '12', date: '12.05.2027' }, { qty: '6', date: '' }]);
    const p2 = setSplitQtyPatch(L(7), { ...d, split: p.split! }, 0, '5');
    expect(p2.split).toEqual([{ qty: '5', date: '12.05.2027' }, { qty: '6', date: '' }]);
    expect(balanceSplit([{ qty: '0', date: '' }, { qty: '5', date: '' }], 3)[0].qty).toBe('0');
  });

  it('state: left, adds up, over, missing, bad date', () => {
    const base = D(draftWith(1), 7);
    let s = splitState(L(7), { ...base, split: [{ qty: '12', date: '12.05.2027' }, { qty: '', date: '' }] }, TODAY);
    expect(s).toEqual({ total: 18, sum: 12, left: 6, over: false, missing: true, bad: null });
    s = splitState(L(7), { ...base, split: [{ qty: '12', date: '12.05.2027' }, { qty: '6', date: '20.06.2027' }] }, TODAY);
    expect(s).toEqual({ total: 18, sum: 18, left: 0, over: false, missing: false, bad: null });
    s = splitState(L(7), { ...base, split: [{ qty: '18', date: '12.05.2027' }, { qty: '2', date: '20.06.2027' }] }, TODAY);
    expect(s.over).toBe(true);
    s = splitState(L(7), { ...base, split: [{ qty: '12', date: '12.05.2025' }, { qty: '6', date: '31.02.2027' }] }, TODAY);
    expect(s.bad).toBe('past');
  });

  it('expState of a split: over → over, a bad date → its code, missing/left → partial, else ok', () => {
    const base = D(draftWith(1), 7);
    expect(expState(L(7), { ...base, split: [{ qty: '18', date: '12.05.2027' }, { qty: '2', date: '20.06.2027' }] }, TODAY)).toBe('over');
    expect(expState(L(7), { ...base, split: [{ qty: '12', date: '01.01.2045' }, { qty: '6', date: '20.06.2027' }] }, TODAY)).toBe('far');
    expect(expState(L(7), { ...base, split: [{ qty: '12', date: '12.05.2027' }, { qty: '', date: '20.06.2027' }] }, TODAY)).toBe('partial');
    expect(expState(L(7), { ...base, split: [{ qty: '2', date: '12.05.2027' }, { qty: '1', date: '20.06.2027' }] }, TODAY)).toBe('partial'); // 3 of 18
    expect(expState(L(7), { ...base, split: [{ qty: '12', date: '12.05.2027' }, { qty: '6', date: '20.06.2027' }] }, TODAY)).toBe('ok');
  });

  it('+ row holds what is left (max 3 rows); × to one row ends the split with its date', () => {
    // Line 9: 13 cartons × 12 = 156 units; the rows count units.
    const d = { ...D(draftWith(1), 9), split: [{ qty: '100', date: '12.05.2027' }, { qty: '6', date: '' }] };
    const p = addSplitRowPatch(L(9), d, TODAY);
    expect(p.split).toEqual([...d.split, { qty: '50', date: '' }]);
    expect(addSplitRowPatch(L(9), { ...d, split: p.split! }, TODAY)).toEqual({});
    expect(removeSplitRowPatch(L(9), { ...d, split: p.split! }, 1).split).toEqual([
      { qty: '106', date: '12.05.2027' },
      { qty: '50', date: '' },
    ]);
    expect(removeSplitRowPatch(L(9), d, 1)).toEqual({ split: null, expiry: '12.05.2027' });
  });
});

describe('packaging words and list (spec 5.12, 7.6)', () => {
  it('pkgWord: singular for 1, plural otherwise; other = אריזה for 1; unknown = אריזות', () => {
    expect(pkgWord(1, 'bucket', 'he')).toBe('דלי');
    expect(pkgWord(3, 'bucket', 'he')).toBe('דליים');
    expect(pkgWord(1, 'other', 'he')).toBe('אריזה');
    expect(pkgWord(2, 'other', 'he')).toBe('אריזות');
    expect(pkgWord(2, '', 'he')).toBe('אריזות');
    expect(pkgWord(2, null, 'en')).toBe('packages');
    expect(pkgWord(1, 'carton', 'en')).toBe('carton');
    expect(pkgWord(4, 'unit', 'he')).toBe('יחידות');
  });

  it("packagingOrder: the note's first, then carton, sack, bag, pack, bucket, the rest, other last", () => {
    expect(packagingOrder('jar', '')).toEqual([
      'jar', 'carton', 'sack', 'bag', 'pack', 'bucket', 'can', 'bottle', 'gallon', 'crate', 'tray', 'box', 'unit', 'other',
    ]);
    expect(packagingOrder('carton', '')[0]).toBe('carton');
    expect(packagingOrder(null, '').length).toBe(14);
    expect(packagingOrder('other', '').at(-1)).toBe('other');
  });

  it('packagingOrder filter: singular or plural word; other always stays', () => {
    expect(packagingOrder('carton', 'דלי')).toEqual(['bucket', 'other']);
    expect(packagingOrder('carton', 'שקי')).toEqual(['sack', 'bag', 'other']); // שקים, שקית
    expect(packagingOrder('carton', 'שקית')).toEqual(['bag', 'other']);
    expect(packagingOrder('carton', 'קרטונים')).toEqual(['carton', 'other']);
    expect(packagingOrder('carton', 'zzz')).toEqual(['other']);
  });
});

describe('draft persistence (spec 6.6)', () => {
  it('the storage key is per form and not the classic one', () => {
    expect(v3DraftStorageKey('abc')).toBe('receipt-form-v3-draft:abc');
  });

  it('serialize → restore round-trips', () => {
    const d = draftWith(2, { 4: { qty: '1', gap: 'will', expiry: '12.05.2027', pallet: 2, ack: true } }, { 1: 3 });
    d.lastPallet = 2;
    d.extras = [{ key: 'k1', name: 'קטשופ', quantity: '2', unit: 'cartons' }];
    const r = restoreV3Draft(serializeV3Draft(d, LINES, 1), LINES);
    expect(r).not.toBeNull();
    expect(r!.rev).toBe(1);
    expect(r!.added).toEqual([]);
    expect(r!.draft).toEqual(d);
  });

  it('a junk, classic or empty draft is not restored', () => {
    expect(restoreV3Draft(null, LINES)).toBeNull();
    expect(restoreV3Draft('{', LINES)).toBeNull();
    expect(restoreV3Draft(JSON.stringify({ v: 2, rev: 1, fp: {}, draft: { pallets: '', lines: [], extras: [] } }), LINES)).toBeNull();
  });

  it('a new page (two-page note) merges by index: new lines start from the note', () => {
    const first = LINES.slice(0, 10);
    const d = { ...initialV3Draft(first), stage: 'list' as const, pallets: 2 };
    d.lines[0] = { ...d.lines[0], expiry: '12.05.2027', pallet: 1 };
    const r = restoreV3Draft(serializeV3Draft(d, first, 1), LINES);
    expect(r!.added).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(r!.draft.lines).toHaveLength(18);
    expect(r!.draft.lines[0]).toMatchObject({ expiry: '12.05.2027', pallet: 1 });
    expect(r!.draft.lines[12]).toMatchObject({ index: 13, qty: '80', expiry: '', ack: false });
    expect(r!.draft).toMatchObject({ stage: 'list', pallets: 2 });
  });

  it('an index that now holds another item resets to the note, and its loose entry goes', () => {
    const d = draftWith(2, { 1: { expiry: '12.05.2027' } }, { 1: 2, 2: 8 });
    const raw = serializeV3Draft(d, LINES, 1);
    const changed = LINES.map((l) => (l.index === 1 ? { ...l, code: 'OTHER' } : l));
    const r = restoreV3Draft(raw, changed)!;
    expect(r.draft.lines[0].expiry).toBe('');
    expect(r.draft.loose).toEqual({ 2: 8 });
  });

  it('mergeV3Draft drops loose entries of lines no longer on the note', () => {
    const d = draftWith(2, {}, { 1: 2, 18: 1 });
    const m = mergeV3Draft(d, null, LINES.slice(0, 10));
    expect(m.draft.loose).toEqual({ 1: 2 });
    expect(m.draft.lines).toHaveLength(10);
  });
});

describe('shortSupplierName (header row 1, step 1, status)', () => {
  it("the prototype's short name from the full legal name", () => {
    expect(shortSupplierName('שיווק והפצה בני דרום אגש"ח בע"מ')).toBe('בני דרום');
    expect(shortSupplierName('שיווק והפצה בני דרום אגש״ח בע״מ')).toBe('בני דרום');
    expect(shortSupplierName('🧪 בדיקה / TEST · שיווק והפצה בני דרום אגש"ח בע"מ')).toBe('🧪 בני דרום');
    expect(shortSupplierName('מיטב תעשיות מזון (1990) בע"מ')).toBe('מיטב תעשיות מזון');
    expect(shortSupplierName('Acme Foods Ltd.')).toBe('Acme Foods');
    expect(shortSupplierName('תלמה')).toBe('תלמה');
  });

  it('never leaves nothing', () => {
    expect(shortSupplierName('בע"מ')).toBe('בע"מ');
    expect(shortSupplierName('שיווק')).toBe('שיווק');
    expect(shortSupplierName('')).toBe('');
  });
});

describe('searchV3 (the prototype filter)', () => {
  it('every word a plain substring of a name or the code; quotes ignored; empty = all', () => {
    expect(searchV3(LINES, '').active).toBe(false);
    expect(searchV3(LINES, '   ').lines).toHaveLength(LINES.length);
    expect(searchV3(LINES, 'מיץ').lines.map((l) => l.index)).toEqual([7, 8]);
    expect(searchV3(LINES, 'מיץ ענבים').lines.map((l) => l.index)).toEqual([8]);
    expect(searchV3(LINES, '92043').lines.map((l) => l.index)).toEqual([16]);
    expect(searchV3(LINES, 'בדץ').lines).toHaveLength(LINES.length); // בד"ץ with the quote dropped
  });

  it('no typo matching and no line numbers (the shared form search has both)', () => {
    expect(searchV3(LINES, 'פרינר').lines).toEqual([]); // the line says פריניר
    expect(searchV3(LINES, '4').lines.map((l) => l.index)).toEqual(LINES.filter((l) => /4/.test(l.name_he + ' ' + l.code)).map((l) => l.index));
  });
});
