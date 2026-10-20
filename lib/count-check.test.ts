import { describe, expect, it } from 'vitest';
import { cartonsOnListFor, listAboveTotal, newCartonQuantity } from './count-check';
import type { InvoiceItem } from './invoice-match';

const drumsticks: InvoiceItem = { item_code: '7290006289360', item_name_hebrew: 'שוקיים וול דאן בדץ', item_name_english: 'Drumsticks' };
const wings: InvoiceItem = { item_code: '7290000000001', item_name_hebrew: 'כנפיים', item_name_english: 'Wings' };

const nobc = (n: number, name = 'שוקיים וול דאן בדץ') => ({ barcode: `NOBC-48429-P1-${n}`, item_name_hebrew: name });
const label = (n: number, name = 'שוקיים וול דאן בדץ') => ({ barcode: `28000000000000${String(n).padStart(2, '0')}`, item_name_hebrew: name });

/** Document 48429 as it stood at 14:05: 3 photo captures + 22 labels. */
const list48429 = [nobc(1), nobc(2), nobc(3), ...Array.from({ length: 22 }, (_, i) => label(i + 1))];

describe('listAboveTotal', () => {
  it('48429: 25 on the list, 22 entered — 3 extra, the 3 photo captures ticked', () => {
    expect(listAboveTotal(22, list48429)).toEqual({
      declared: 22, onList: 25, extra: 3,
      suggested: ['NOBC-48429-P1-1', 'NOBC-48429-P1-2', 'NOBC-48429-P1-3'],
    });
  });
  it('nothing to say when the list is at or under the total', () => {
    expect(listAboveTotal(25, list48429)).toBeNull();
    expect(listAboveTotal(40, list48429)).toBeNull();
  });
  it('ticks nothing when the photo captures are not exactly the extra', () => {
    expect(listAboveTotal(23, list48429)?.suggested).toEqual([]);
    expect(listAboveTotal(20, list48429)?.suggested).toEqual([]);
    expect(listAboveTotal(1, [label(1), label(2)])).toEqual({ declared: 1, onList: 2, extra: 1, suggested: [] });
  });
  it('no total, no verdict', () => {
    expect(listAboveTotal(0, list48429)).toBeNull();
    expect(listAboveTotal(NaN, list48429)).toBeNull();
  });
});

describe('cartonsOnListFor', () => {
  it('48429: the 3 photo captures are on the list for the drumsticks line', () => {
    expect(cartonsOnListFor(drumsticks.item_code, [nobc(1), nobc(2), nobc(3)], [drumsticks]))
      .toEqual({ total: 3, noBarcode: 3 });
  });
  it('a one-line note claims every row, even one whose OCR name drifted', () => {
    expect(cartonsOnListFor(drumsticks.item_code, [nobc(1, 'שוקיים'), nobc(2, '')], [drumsticks]))
      .toEqual({ total: 2, noBarcode: 2 });
  });
  it('a note with several lines counts only the rows matching this one', () => {
    const rows = [nobc(1), label(1, 'כנפיים'), label(2, 'כנפיים'), label(3)];
    expect(cartonsOnListFor(drumsticks.item_code, rows, [drumsticks, wings])).toEqual({ total: 2, noBarcode: 1 });
    expect(cartonsOnListFor(wings.item_code, rows, [drumsticks, wings])).toEqual({ total: 2, noBarcode: 0 });
  });
  it('no item code or no note: nothing claimed', () => {
    expect(cartonsOnListFor('', list48429, [drumsticks])).toEqual({ total: 0, noBarcode: 0 });
    expect(cartonsOnListFor(drumsticks.item_code, list48429, [])).toEqual({ total: 0, noBarcode: 0 });
  });
});

describe('newCartonQuantity', () => {
  it('48429: 22 on the line, 3 on the list — opens on the 19 still to label', () => {
    expect(newCartonQuantity({ onList: 3, lineBoxes: 22, lineMaySpread: false })).toEqual({ quantity: 19, left: 19 });
  });
  it('nothing on the list yet: 1, as before', () => {
    expect(newCartonQuantity({ onList: 0, lineBoxes: 22, lineMaySpread: false })).toEqual({ quantity: 1, left: 22 });
  });
  it('the line may sit on another pallet or the loose pile: 1, no remainder', () => {
    expect(newCartonQuantity({ onList: 3, lineBoxes: 22, lineMaySpread: true })).toEqual({ quantity: 1, left: null });
  });
  it('the line is already full on the list: still 1 (his call), 0 left', () => {
    expect(newCartonQuantity({ onList: 22, lineBoxes: 22, lineMaySpread: false })).toEqual({ quantity: 1, left: 0 });
    expect(newCartonQuantity({ onList: 25, lineBoxes: 22, lineMaySpread: false })).toEqual({ quantity: 1, left: 0 });
  });
  it('no carton count on the line: 1', () => {
    expect(newCartonQuantity({ onList: 3, lineBoxes: null, lineMaySpread: false })).toEqual({ quantity: 1, left: null });
  });
});
