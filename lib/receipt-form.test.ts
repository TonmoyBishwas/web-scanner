import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  applySameDateToAll,
  countWantingExpiry,
  draftToAnswers,
  expiryError,
  fmtQty,
  formatDdMmYyyy,
  initialDraft,
  isOver,
  isRealIsoDate,
  isShort,
  markRestNoExpiry,
  maxExpiryIso,
  normalizeFormHeader,
  normalizeFormLines,
  parseAnswers,
  parseDecimal,
  parseWholeOrBlank,
  remainingCount,
  restoreDraft,
  serializeDraft,
  todayInJerusalem,
  validateAnswers,
  type Answers,
  type FormLine,
  type LineAnswer,
} from './receipt-form';

const TODAY = '2026-10-13';

function line(over: Partial<FormLine> = {}): FormLine {
  return {
    index: 1,
    code: '100',
    name_he: 'טחינה גולמית',
    name_en: 'Raw tahini',
    qty: 10,
    unit: 'units',
    unit_label: "יח'",
    weighed: false,
    cartons: 2,
    packaging: 'bucket',
    needs_expiry: true,
    ...over,
  };
}

function answer(over: Partial<LineAnswer> = {}): LineAnswer {
  return {
    index: 1,
    received_qty: 10,
    cartons: 2,
    packaging: 'bucket',
    expiry_date: '2027-01-01',
    no_expiry: false,
    gap: null,
    gap_note: null,
    ...over,
  };
}

function answers(lines: LineAnswer[], over: Partial<Answers> = {}): Answers {
  return { pallets: null, lines, extras: [], ...over };
}

describe('dates', () => {
  it('todayInJerusalem uses Israel, not UTC', () => {
    // 22:30 UTC on 13 Oct is already 14 Oct in Israel (UTC+3 in October).
    expect(todayInJerusalem(new Date('2026-10-13T22:30:00Z'))).toBe('2026-10-14');
    expect(todayInJerusalem(new Date('2026-10-13T20:30:00Z'))).toBe('2026-10-13');
  });

  it('isRealIsoDate refuses impossible and loose dates', () => {
    expect(isRealIsoDate('2027-02-28')).toBe(true);
    expect(isRealIsoDate('2028-02-29')).toBe(true);
    expect(isRealIsoDate('2027-02-29')).toBe(false);
    expect(isRealIsoDate('2027-13-01')).toBe(false);
    expect(isRealIsoDate('1/2/2027')).toBe(false);
    expect(isRealIsoDate('')).toBe(false);
    expect(isRealIsoDate(null)).toBe(false);
  });

  it('expiryError: on/before today refused, tomorrow ok, 15 years is the limit', () => {
    expect(expiryError(TODAY, TODAY)).toBe('expiry_not_future');
    expect(expiryError('2026-10-12', TODAY)).toBe('expiry_not_future');
    expect(expiryError('2026-10-14', TODAY)).toBeNull();
    expect(maxExpiryIso(TODAY)).toBe('2041-10-13');
    expect(expiryError('2041-10-13', TODAY)).toBeNull();
    expect(expiryError('2041-10-14', TODAY)).toBe('expiry_too_far');
    expect(expiryError('2026-02-30', TODAY)).toBe('expiry_invalid');
  });

  it('helpers', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(formatDdMmYyyy('2026-10-03')).toBe('03/10/2026');
    expect(formatDdMmYyyy('')).toBe('');
  });
});

describe('quantities', () => {
  it('short / over use a float-noise epsilon only', () => {
    expect(isShort({ qty: 10 }, 9.999)).toBe(true);
    expect(isShort({ qty: 10 }, 9.9996)).toBe(false);
    expect(isShort({ qty: 10 }, 10)).toBe(false);
    expect(isOver({ qty: 10 }, 10.001)).toBe(true);
    expect(isOver({ qty: 10 }, 10.0004)).toBe(false);
    expect(isShort({ qty: 10 }, NaN)).toBe(false);
  });

  it('parseDecimal accepts a decimal comma, refuses junk and blanks', () => {
    expect(parseDecimal('12,5')).toBe(12.5);
    expect(parseDecimal(' 7 ')).toBe(7);
    expect(parseDecimal('0')).toBe(0);
    expect(parseDecimal('.5')).toBe(0.5);
    expect(Number.isNaN(parseDecimal(''))).toBe(true);
    expect(Number.isNaN(parseDecimal('-1'))).toBe(true);
    expect(Number.isNaN(parseDecimal('1e3'))).toBe(true);
    expect(Number.isNaN(parseDecimal('abc'))).toBe(true);
  });

  it('parseWholeOrBlank', () => {
    expect(parseWholeOrBlank('')).toBeNull();
    expect(parseWholeOrBlank(' 4 ')).toBe(4);
    expect(Number.isNaN(parseWholeOrBlank('4.5') as number)).toBe(true);
  });

  it('fmtQty trims float noise', () => {
    expect(fmtQty(0.1 + 0.2)).toBe('0.3');
    expect(fmtQty(12)).toBe('12');
  });
});

describe('validateAnswers', () => {
  it('accepts a complete form', () => {
    const v = validateAnswers([line()], answers([answer()]), TODAY);
    expect(v.ok).toBe(true);
    expect(remainingCount(v)).toBe(0);
  });

  it('a needs-expiry line that arrived wants a date or "no expiry"', () => {
    expect(validateAnswers([line()], answers([answer({ expiry_date: null })]), TODAY).lines[1]).toEqual([
      'expiry_missing',
    ]);
    expect(validateAnswers([line()], answers([answer({ expiry_date: null, no_expiry: true })]), TODAY).ok).toBe(true);
    // a line that needs none
    expect(validateAnswers([line({ needs_expiry: false })], answers([answer({ expiry_date: null })]), TODAY).ok).toBe(
      true,
    );
  });

  it('a line received 0 needs no expiry, but needs a reason', () => {
    const v = validateAnswers([line()], answers([answer({ received_qty: 0, expiry_date: null })]), TODAY);
    expect(v.lines[1]).toEqual(['gap_missing']);
    const ok = validateAnswers(
      [line()],
      answers([answer({ received_qty: 0, expiry_date: null, gap: 'wont' })]),
      TODAY,
    );
    expect(ok.ok).toBe(true);
  });

  it('refuses an expiry on/before today, a bad date, too far, and date + no-expiry together', () => {
    const one = (expiry_date: string, no_expiry = false) =>
      validateAnswers([line()], answers([answer({ expiry_date, no_expiry })]), TODAY).lines[1];
    expect(one(TODAY)).toEqual(['expiry_not_future']);
    expect(one('2020-01-01')).toEqual(['expiry_not_future']);
    expect(one('2027-02-30')).toEqual(['expiry_invalid']);
    expect(one('2050-01-01')).toEqual(['expiry_too_far']);
    expect(one('2027-01-01', true)).toEqual(['expiry_conflict']);
    // a date given on a line that does not need one is still judged
    expect(
      validateAnswers([line({ needs_expiry: false })], answers([answer({ expiry_date: TODAY })]), TODAY).lines[1],
    ).toEqual(['expiry_not_future']);
  });

  it('short lines need a reason; "other" needs a note 1..500', () => {
    const v = (a: Partial<LineAnswer>) =>
      validateAnswers([line()], answers([answer({ received_qty: 8, ...a })]), TODAY).lines[1];
    expect(v({})).toEqual(['gap_missing']);
    expect(v({ gap: 'will' })).toBeUndefined();
    expect(v({ gap: 'other', gap_note: '  ' })).toEqual(['gap_note_missing']);
    expect(v({ gap: 'other', gap_note: 'broken bucket' })).toBeUndefined();
    expect(v({ gap: 'other', gap_note: 'x'.repeat(501) })).toEqual(['gap_note_too_long']);
    expect(v({ gap: 'maybe' as never })).toEqual(['gap_invalid']);
  });

  it('over lines need no reason', () => {
    expect(validateAnswers([line()], answers([answer({ received_qty: 12 })]), TODAY).ok).toBe(true);
  });

  it('bad numbers and packaging', () => {
    const v = (a: Partial<LineAnswer>) => validateAnswers([line()], answers([answer(a)]), TODAY).lines[1];
    expect(v({ received_qty: NaN })).toEqual(['qty_invalid']);
    expect(v({ received_qty: -1 })).toEqual(['qty_invalid']);
    expect(v({ received_qty: 2e6 })).toEqual(['qty_invalid']);
    expect(v({ cartons: 1.5 })).toEqual(['cartons_invalid']);
    expect(v({ cartons: -1 })).toEqual(['cartons_invalid']);
    expect(v({ cartons: null })).toBeUndefined();
    expect(v({ packaging: 'barrel' as never })).toEqual(['packaging_invalid']);
    expect(v({ packaging: null })).toBeUndefined();
  });

  it('every form line exactly once', () => {
    const two = [line(), line({ index: 2 })];
    expect(validateAnswers(two, answers([answer()]), TODAY).form).toContain('lines_mismatch');
    expect(validateAnswers(two, answers([answer(), answer()]), TODAY).form).toContain('lines_mismatch');
    expect(validateAnswers(two, answers([answer(), answer({ index: 3 })]), TODAY).form).toContain('lines_mismatch');
    expect(validateAnswers(two, answers([answer({ index: 2 }), answer()]), TODAY).ok).toBe(true);
  });

  it('pallets and extras', () => {
    expect(validateAnswers([line()], answers([answer()], { pallets: 3 }), TODAY).ok).toBe(true);
    expect(validateAnswers([line()], answers([answer()], { pallets: 1.5 }), TODAY).form).toEqual(['pallets_invalid']);
    expect(validateAnswers([line()], answers([answer()], { pallets: -1 }), TODAY).form).toEqual(['pallets_invalid']);
    const ex = validateAnswers(
      [line()],
      answers([answer()], {
        extras: [
          { name: 'Sugar', quantity: 5, unit: 'kg' },
          { name: '', quantity: 0, unit: 'boxes' as never },
        ],
      }),
      TODAY,
    );
    expect(ex.extras[0]).toBeUndefined();
    expect(ex.extras[1]).toEqual(['extra_name_missing', 'extra_qty_invalid', 'extra_unit_invalid']);
    expect(remainingCount(ex)).toBe(1);
    const many = Array.from({ length: 21 }, () => ({ name: 'x', quantity: 1, unit: 'units' as const }));
    expect(validateAnswers([line()], answers([answer()], { extras: many }), TODAY).form).toContain('too_many_extras');
  });
});

describe('parseAnswers (untrusted JSON)', () => {
  const good = {
    pallets: 2,
    lines: [
      {
        index: 1,
        received_qty: 10,
        cartons: null,
        packaging: 'bucket',
        expiry_date: '2027-01-01',
        no_expiry: false,
        gap: null,
        gap_note: null,
      },
    ],
    extras: [{ name: ' Salt ', quantity: 2, unit: 'kg' }],
  };

  it('accepts the contract shape and trims extra names', () => {
    const a = parseAnswers(good);
    expect(a?.pallets).toBe(2);
    expect(a?.lines[0].packaging).toBe('bucket');
    expect(a?.extras[0].name).toBe('Salt');
  });

  it('refuses wrong types', () => {
    expect(parseAnswers(null)).toBeNull();
    expect(parseAnswers([])).toBeNull();
    expect(parseAnswers({ ...good, pallets: '2' })).toBeNull();
    expect(parseAnswers({ ...good, lines: 'x' })).toBeNull();
    expect(parseAnswers({ ...good, lines: [{ ...good.lines[0], received_qty: '10' }] })).toBeNull();
    expect(parseAnswers({ ...good, lines: [{ ...good.lines[0], index: 1.5 }] })).toBeNull();
    expect(parseAnswers({ ...good, lines: [{ ...good.lines[0], expiry_date: 20270101 }] })).toBeNull();
    expect(parseAnswers({ ...good, extras: [{ name: 1, quantity: 1, unit: 'kg' }] })).toBeNull();
  });

  it('missing optionals default safely; a blank date is null', () => {
    const a = parseAnswers({ lines: [{ index: 1, received_qty: 0, expiry_date: '' }] });
    expect(a).toEqual({
      pallets: null,
      lines: [
        {
          index: 1,
          received_qty: 0,
          cartons: null,
          packaging: null,
          expiry_date: null,
          no_expiry: false,
          gap: null,
          gap_note: null,
        },
      ],
      extras: [],
    });
  });
});

describe('row normalisation', () => {
  it('normalizeFormLines tolerates drift', () => {
    const out = normalizeFormLines([
      { index: 3, name_he: 'סוכר', qty: '25', packaging: 'sack', cartons: 4, needs_expiry: true, weighed: true },
      { name_he: 'מלח', qty: 'abc', packaging: 'barrel', cartons: -1 },
      null,
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ index: 3, qty: 25, packaging: 'sack', cartons: 4, needs_expiry: true, weighed: true });
    expect(out[1]).toMatchObject({ index: 2, qty: 0, packaging: null, cartons: null, needs_expiry: false, name_en: '' });
    expect(normalizeFormLines('nope')).toEqual([]);
  });

  it('normalizeFormHeader', () => {
    expect(normalizeFormHeader({ supplier: 'בני דרום', invoice_number: 123, invoice_date: '2026-10-12' }, 26)).toEqual({
      supplier: 'בני דרום',
      invoice_number: '123',
      invoice_date: '2026-10-12',
      line_count: 26,
    });
    expect(normalizeFormHeader(null, 2).invoice_date).toBe('');
  });
});

describe('draft', () => {
  const lines = [
    line(),
    line({ index: 2, needs_expiry: false, cartons: null, packaging: null }),
    line({ index: 3, qty: 12.5, weighed: true, unit: 'kg', unit_label: 'ק"ג' }),
  ];

  it('initialDraft pre-fills from the note', () => {
    const d = initialDraft(lines);
    expect(d.lines[0]).toMatchObject({ qty: '10', cartons: '2', packaging: 'bucket', expiry: '', noExpiry: false });
    expect(d.lines[1]).toMatchObject({ cartons: '', packaging: '' });
    expect(d.lines[2].qty).toBe('12.5');
  });

  it('as pre-filled, only the needs-expiry lines block', () => {
    const v = validateAnswers(lines, draftToAnswers(lines, initialDraft(lines)), TODAY);
    expect(Object.keys(v.lines)).toEqual(['1', '3']);
    expect(remainingCount(v)).toBe(2);
  });

  it('same date fills only needs-expiry lines with no date and no "no expiry"', () => {
    const d = initialDraft(lines);
    d.lines[2] = { ...d.lines[2], noExpiry: true };
    const out = applySameDateToAll(lines, d.lines, '2027-05-01');
    expect(out.map((l) => l.expiry)).toEqual(['2027-05-01', '', '']);
    const again = applySameDateToAll(lines, out, '2028-01-01');
    expect(again[0].expiry).toBe('2027-05-01'); // never overwrites a date
  });

  it('the rest have no expiry', () => {
    const d = initialDraft(lines);
    d.lines[0] = { ...d.lines[0], expiry: '2027-05-01' };
    const out = markRestNoExpiry(lines, d.lines);
    expect(out.map((l) => l.noExpiry)).toEqual([false, false, true]);
    expect(countWantingExpiry(lines, out)).toBe(0);
    expect(validateAnswers(lines, draftToAnswers(lines, { ...d, lines: out }), TODAY).ok).toBe(true);
  });

  it('draftToAnswers drops a stale reason once the line is no longer short, and the date under "no expiry"', () => {
    const d = initialDraft(lines);
    d.lines[0] = { ...d.lines[0], gap: 'other', gapNote: 'x', expiry: '2027-01-01', noExpiry: true };
    const a = draftToAnswers(lines, d);
    expect(a.lines[0]).toMatchObject({ gap: null, gap_note: null, expiry_date: null, no_expiry: true });
    d.lines[0] = { ...d.lines[0], qty: '4', gap: 'other', gapNote: '  late truck ' };
    expect(draftToAnswers(lines, d).lines[0]).toMatchObject({ received_qty: 4, gap: 'other', gap_note: 'late truck' });
    d.lines[0] = { ...d.lines[0], gap: 'will' };
    expect(draftToAnswers(lines, d).lines[0].gap_note).toBeNull();
  });

  it('draftToAnswers: blank quantity is invalid; extras and pallets parsed', () => {
    const d = initialDraft(lines);
    d.lines[1] = { ...d.lines[1], qty: '' };
    d.pallets = '3';
    d.extras = [{ key: 'a', name: ' Oil ', quantity: '2,5', unit: 'litres' }];
    const a = draftToAnswers(lines, d);
    expect(Number.isNaN(a.lines[1].received_qty)).toBe(true);
    expect(a.pallets).toBe(3);
    expect(a.extras).toEqual([{ name: 'Oil', quantity: 2.5, unit: 'litres' }]);
    expect(validateAnswers(lines, a, TODAY).lines[2]).toEqual(['qty_invalid']);
  });

  it('restoreDraft round-trips and refuses a draft for other lines', () => {
    const d = initialDraft(lines);
    d.lines[0] = { ...d.lines[0], expiry: '2027-01-01' };
    d.extras = [{ key: 'k', name: 'x', quantity: '1', unit: 'units' }];
    const raw = serializeDraft(d);
    expect(restoreDraft(raw, lines)).toEqual(d);
    expect(restoreDraft(raw, lines.slice(0, 2))).toBeNull();
    expect(restoreDraft(raw, [lines[1], lines[0], lines[2]])).toBeNull();
    expect(restoreDraft('{bad json', lines)).toBeNull();
    expect(restoreDraft(null, lines)).toBeNull();
    expect(restoreDraft(JSON.stringify({ v: 2, draft: d }), lines)).toBeNull();
  });
});
