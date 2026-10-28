import { describe, expect, it } from 'vitest';
import { initialDraft, type FormLine, type LineDraft } from './receipt-form';
import {
  groupByPackage,
  inWalk,
  isDated,
  lineNames,
  nextUndated,
  prevInWalk,
  walkOrder,
  walkProgress,
  walkStart,
} from './receive-walk';

const TODAY = '2026-10-28';

function line(over: Partial<FormLine> = {}): FormLine {
  return {
    index: 1,
    code: '100',
    name_he: 'מיונז',
    name_en: '',
    qty: 10,
    unit: 'units',
    unit_label: "יח'",
    weighed: false,
    cartons: 2,
    packaging: 'carton',
    per_pack: null,
    inner: null,
    needs_expiry: true,
    ...over,
  };
}

describe('lineNames', () => {
  it('Priority name as title, the printed name as subtitle (bot 28/10: name_he = Priority name)', () => {
    expect(lineNames(line({ name_he: 'מיונז', name_printed: 'מיזן' }))).toEqual({ title: 'מיונז', subtitle: 'מיזן' });
  });
  it('an explicit priority_name wins over name_he', () => {
    expect(lineNames(line({ name_he: 'מיזן', priority_name: 'מיונז', name_printed: 'מיזן' }))).toEqual({
      title: 'מיונז',
      subtitle: 'מיזן',
    });
  });
  it('no subtitle when the printed name reads the same (quotes, spaces, finals folded)', () => {
    expect(lineNames(line({ name_he: 'שמן קנולה 1 ל"', name_printed: 'שמן קנולה 1 ל' })).subtitle).toBe('');
    expect(lineNames(line({ name_he: 'סוכר' })).subtitle).toBe('');
  });
  it('an old row (no printed / Priority name) keeps name_he; an English-only line its English name', () => {
    expect(lineNames(line({ name_he: 'טחינה' }))).toEqual({ title: 'טחינה', subtitle: '' });
    expect(lineNames(line({ name_he: '', name_en: 'Tahini' }))).toEqual({ title: 'Tahini', subtitle: '' });
  });
});

describe('the walk', () => {
  const lines = [
    line({ index: 1, packaging: 'carton' }),
    line({ index: 2, needs_expiry: false, packaging: 'sack' }), // produce: never in the walk
    line({ index: 3, packaging: 'bucket' }),
    line({ index: 4, packaging: null }),
    line({ index: 5, packaging: 'carton' }),
  ];
  const drafts = (patch: Record<number, Partial<LineDraft>> = {}) =>
    initialDraft(lines).lines.map((d) => ({ ...d, ...(patch[d.index] ?? {}) }));

  it('inWalk: needs an expiry and was not marked "did not arrive"', () => {
    expect(inWalk(lines[0], { qty: '10' })).toBe(true);
    expect(inWalk(lines[0], { qty: '0' })).toBe(false);
    expect(inWalk(lines[0], { qty: '' })).toBe(true); // being edited: still asked
    expect(inWalk(lines[1], { qty: '10' })).toBe(false);
  });

  it('isDated: "no expiry", or a date the form accepts', () => {
    expect(isDated({ expiry: '', noExpiry: true }, TODAY)).toBe(true);
    expect(isDated({ expiry: '2026-12-01', noExpiry: false }, TODAY)).toBe(true);
    expect(isDated({ expiry: '2026-10-28', noExpiry: false }, TODAY)).toBe(false); // today is refused
    expect(isDated({ expiry: '12.1', noExpiry: false }, TODAY)).toBe(false);
    expect(isDated({ expiry: '', noExpiry: false }, TODAY)).toBe(false);
  });

  it('walkOrder and walkProgress', () => {
    const d = drafts({ 3: { qty: '0' }, 5: { expiry: '2027-01-01' } });
    expect(walkOrder(lines, d)).toEqual([1, 4, 5]);
    expect(walkProgress(lines, d, TODAY)).toEqual({ dated: 1, total: 3 });
    expect(walkProgress(lines, drafts({ 1: { noExpiry: true } }), TODAY)).toEqual({ dated: 1, total: 4 });
  });

  it('nextUndated skips dated lines, wraps, never returns `from`', () => {
    const order = [1, 3, 4, 5];
    const undated = (i: number) => i !== 3;
    expect(nextUndated(order, undated, 1)).toBe(4);
    expect(nextUndated(order, undated, 5)).toBe(1); // wraps
    expect(nextUndated(order, undated, null)).toBe(1);
    expect(nextUndated(order, (i) => i === 4, 4)).toBeNull(); // only this one left
    expect(nextUndated(order, () => false, 1)).toBeNull();
    expect(nextUndated([], () => true, null)).toBeNull();
    expect(nextUndated(order, undated, 99)).toBe(1); // not in the walk: from the start
  });

  it('prevInWalk and walkStart', () => {
    expect(prevInWalk([1, 3, 4], 3)).toBe(1);
    expect(prevInWalk([1, 3, 4], 1)).toBeNull();
    expect(prevInWalk([1, 3, 4], null)).toBeNull();
    expect(walkStart([1, 3, 4], (i) => i === 3)).toBe(3);
    expect(walkStart([1, 3, 4], () => false)).toBe(1);
    expect(walkStart([], () => true)).toBeNull();
  });

  it('groupByPackage: the dropdown order, the worker\'s choice first, unknown under "other" last', () => {
    const d = drafts({ 5: { packaging: 'bucket' } });
    expect(groupByPackage(lines, d, [1, 3, 4, 5])).toEqual([
      { packaging: 'carton', lines: [1] },
      { packaging: 'bucket', lines: [3, 5] },
      { packaging: 'other', lines: [4] },
    ]);
    expect(groupByPackage(lines, d, [])).toEqual([]);
  });
});
