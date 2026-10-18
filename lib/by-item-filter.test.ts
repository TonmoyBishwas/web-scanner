import { describe, expect, it } from 'vitest';
import {
  UNIDENTIFIED_ITEM_KEY,
  buildItemChips,
  distinctItemCount,
  effectiveItemFilter,
  itemFilterKey,
  matchesItemFilter,
} from './by-item-filter';
import type { GroupableBox } from './group-key';

const B = (barcode: string, he = '', en = ''): GroupableBox => ({
  barcode, item_name_hebrew: he, item_name: en,
});

describe('itemFilterKey', () => {
  it('uses the product group key', () => {
    expect(itemFilterKey(B('1', 'שריר בקר 8', 'Beef shin'))).toBe('he:שרירבקר8');
    expect(itemFilterKey(B('2', '', 'Beef shin'))).toBe('en:beefshin');
  });

  it('puts every unnamed carton under one Unidentified key', () => {
    expect(itemFilterKey(B('1'))).toBe(UNIDENTIFIED_ITEM_KEY);
    expect(itemFilterKey(B('2'))).toBe(UNIDENTIFIED_ITEM_KEY);
  });

  it('applies accepted merges', () => {
    const merges = new Map([['he:שרירבקר', 'he:שרירבקר8']]);
    expect(itemFilterKey(B('1', 'שריר בקר'), merges)).toBe('he:שרירבקר8');
  });
});

describe('buildItemChips', () => {
  const boxes = [
    B('1', 'שריר בקר 8', 'Beef shin no. 8'),
    B('2', 'אנטריקוט', 'Entrecote'),
    B('3'),
    B('4', 'שריר בקר 8', 'Beef shin no. 8'),
    B('5'),
    B('6', 'שריר בקר 8', ''),
  ];

  it('one chip per item in first-scan order, counts, Unidentified last', () => {
    const chips = buildItemChips(boxes, 'he');
    expect(chips).toEqual([
      { key: 'he:שרירבקר8', name: 'שריר בקר 8', count: 3 },
      { key: 'he:אנטריקוט', name: 'אנטריקוט', count: 1 },
      { key: UNIDENTIFIED_ITEM_KEY, name: null, count: 2 },
    ]);
    expect(distinctItemCount(chips)).toBe(2);
  });

  it('shows English names to English workers, falling back to Hebrew', () => {
    const chips = buildItemChips([B('1', 'שריר בקר 8', ''), B('2', 'שריר בקר 8', 'Beef shin'), B('3', 'כבד', '')], 'en');
    expect(chips.map((c) => c.name)).toEqual(['Beef shin', 'כבד']);
  });

  it('shows Hebrew names to Hebrew workers, falling back to English', () => {
    const chips = buildItemChips([B('1', '', 'Liver')], 'he');
    expect(chips).toEqual([{ key: 'en:liver', name: 'Liver', count: 1 }]);
  });

  it('merged groups are one chip', () => {
    const merges = new Map([['he:שרירבקר', 'he:שרירבקר8']]);
    const chips = buildItemChips([B('1', 'שריר בקר 8'), B('2', 'שריר בקר')], 'he', merges);
    expect(chips).toEqual([{ key: 'he:שרירבקר8', name: 'שריר בקר 8', count: 2 }]);
  });

  it('empty list → no chips', () => {
    expect(buildItemChips([], 'he')).toEqual([]);
    expect(distinctItemCount([])).toBe(0);
  });

  it('counts follow the list live (a carton finishing OCR moves chips)', () => {
    const before = buildItemChips([B('1', 'כבד'), B('2')], 'he');
    expect(before.map((c) => c.count)).toEqual([1, 1]);
    const after = buildItemChips([B('1', 'כבד'), B('2', 'כבד')], 'he');
    expect(after).toEqual([{ key: 'he:כבד', name: 'כבד', count: 2 }]);
  });
});

describe('effectiveItemFilter', () => {
  const chips = buildItemChips([B('1', 'כבד'), B('2')], 'he');

  it('keeps a filter whose item is still listed', () => {
    expect(effectiveItemFilter('he:כבד', chips)).toBe('he:כבד');
    expect(effectiveItemFilter(UNIDENTIFIED_ITEM_KEY, chips)).toBe(UNIDENTIFIED_ITEM_KEY);
  });

  it('drops a filter whose cartons are gone', () => {
    expect(effectiveItemFilter('he:אנטריקוט', chips)).toBeNull();
    expect(effectiveItemFilter('he:כבד', [])).toBeNull();
  });

  it('no selection → no filter', () => {
    expect(effectiveItemFilter(null, chips)).toBeNull();
  });
});

describe('matchesItemFilter', () => {
  const boxes = [B('1', 'כבד'), B('2', 'אנטריקוט'), B('3'), B('4', 'כבד')];

  it('no filter shows every carton', () => {
    expect(boxes.filter((b) => matchesItemFilter(b, null))).toHaveLength(4);
  });

  it('an item filter shows only that item', () => {
    expect(boxes.filter((b) => matchesItemFilter(b, 'he:כבד')).map((b) => b.barcode)).toEqual(['1', '4']);
  });

  it('the Unidentified filter shows only unnamed cartons', () => {
    expect(boxes.filter((b) => matchesItemFilter(b, UNIDENTIFIED_ITEM_KEY)).map((b) => b.barcode)).toEqual(['3']);
  });

  it('respects merges', () => {
    const merges = new Map([['he:אנטריקוט', 'he:כבד']]);
    expect(boxes.filter((b) => matchesItemFilter(b, 'he:כבד', merges)).map((b) => b.barcode)).toEqual(['1', '2', '4']);
  });
});
