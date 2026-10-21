import { describe, expect, it } from 'vitest';
import { nextIncompleteLine, queryWords, searchKey, searchLines, type SearchableLine } from './receipt-form-search';

// Real lines from the 20/10 Bnei Darom form (receipt_forms f755dcba…, 18 lines).
const L = (index: number, code: string, name_he: string, name_en = ''): SearchableLine => ({ index, code, name_he, name_en });
const NOTE: SearchableLine[] = [
  L(1, '100580', 'עגבניות קוביות A9 פריניר בד"ץ'),
  L(2, '120143', 'פלפל שיפקה פח 9 ליטר בד"ץ'),
  L(3, '352123', 'פפריקה מתוקה ק"ג ברמן בד"ץ'),
  L(4, '111111', 'פקדון בקבוק לפי 12 בקרטון'),
  L(5, '310502', 'פתיתי סויה בטעם שווארמה 1 ק"ג'),
  L(6, '200178', 'פתיתים עגולים שיבולים 10 ק"ג בד"ץ'),
  L(7, '340110', 'חרדל 5 ק"ג תלמה בד"ץ', 'Mustard 5 kg Telma'),
  L(8, '340113', 'מיונז 5 ק"ג תלמה בד"ץ'),
  L(9, '250308', 'מיץ לימון גלון 2 ליטר עסיס'),
  L(10, '400001', 'מְלָפְפוֹנִים כבושים 12 יח׳'),
];
const idx = (q: string) => searchLines(NOTE, q).lines.map((l) => l.index);

describe('searchKey', () => {
  it('drops quotes, gershayim, geresh, spaces and symbols', () => {
    expect(searchKey('ק"ג בד"ץ')).toBe('קגבדצ');
    expect(searchKey('ק״ג בד״ץ')).toBe('קגבדצ');
    expect(searchKey("12 יח׳")).toBe('12יח');
  });
  it('folds final letters', () => {
    expect(searchKey('פקדון')).toBe('פקדונ');
    expect(searchKey('ךםןףץ')).toBe('כמנפצ');
  });
  it('strips niqqud', () => {
    expect(searchKey('מְלָפְפוֹנִים')).toBe('מלפפונימ');
  });
  it('lower-cases Latin and keeps digits', () => {
    expect(searchKey('A9 Telma-5')).toBe('a9telma5');
  });
  it('empty in, empty out', () => {
    expect(searchKey(null)).toBe('');
    expect(queryWords('   ')).toEqual([]);
  });
});

describe('searchLines', () => {
  it('empty query shows every line, not active', () => {
    const r = searchLines(NOTE, '  ');
    expect(r.active).toBe(false);
    expect(r.lines).toHaveLength(NOTE.length);
  });
  it('finds by a Hebrew word typed with or without a final letter', () => {
    expect(idx('פקדון')).toEqual([4]);
    expect(idx('פקדונ')).toEqual([4]);
    expect(idx('פקדו')).toEqual([4]);
  });
  it('all words must match, in any order', () => {
    expect(idx('תלמה חרדל')).toEqual([7]);
    expect(idx('תלמה')).toEqual([7, 8]);
  });
  it('finds a name typed without niqqud against a pointed name', () => {
    expect(idx('מלפפונים')).toEqual([10]);
  });
  it('quotes do not matter: ק"ג = קג = ק״ג', () => {
    expect(idx('פפריקה ק"ג')).toEqual([3]);
    expect(idx('פפריקה קג')).toEqual([3]);
  });
  it('finds by supplier code (whole or part)', () => {
    expect(idx('340110')).toEqual([7]);
    expect(idx('3401')).toEqual([7, 8]);
  });
  it('a small whole number also matches the line number', () => {
    expect(idx('4')).toContain(4);
  });
  it('finds by the English name', () => {
    expect(idx('mustard')).toEqual([7]);
  });
  it('keeps note order', () => {
    expect(idx('בד"ץ')).toEqual([1, 2, 3, 6, 7, 8]);
  });
  it('typo fallback only when nothing matches strictly', () => {
    const r = searchLines(NOTE, 'פרינר'); // OCR spelling on the other form copy
    expect(r.fuzzy).toBe(true);
    expect(r.lines.map((l) => l.index)).toEqual([1]);
    expect(searchLines(NOTE, 'מיונז').fuzzy).toBe(false);
  });
  it('no match → empty, active', () => {
    const r = searchLines(NOTE, 'שוקולד');
    expect(r).toMatchObject({ active: true, fuzzy: false });
    expect(r.lines).toEqual([]);
  });
});

describe('nextIncompleteLine', () => {
  const order = [1, 2, 3, 4, 5];
  const todo = new Set([2, 4]);
  const inc = (i: number) => todo.has(i);
  it('no search: first incomplete line', () => {
    expect(nextIncompleteLine(order, inc, null)).toEqual({ index: 2, clearSearch: false });
  });
  it('search on: first incomplete line among the results', () => {
    expect(nextIncompleteLine(order, inc, new Set([3, 4]))).toEqual({ index: 4, clearSearch: false });
  });
  it('results all done: global next, and the search must clear', () => {
    expect(nextIncompleteLine(order, inc, new Set([1, 3]))).toEqual({ index: 2, clearSearch: true });
  });
  it('nothing incomplete → null', () => {
    expect(nextIncompleteLine(order, () => false, new Set([1]))).toBeNull();
  });
});
