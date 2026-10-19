import { describe, expect, it } from 'vitest';
import { acceptDoubts, sharedDoubt, weightDoubts, type DoubtedRow } from './weight-review';

const KEBAB = 'קבב מוסדי 8 קג - גורמה';
const doubt = { reason: 'name_number' as const, name: 'Frozen kebab 8g' };
const row = (barcode: string, weight: number, extra: Partial<DoubtedRow> = {}): DoubtedRow & { barcode: string } => ({
  barcode, weight, item_name_hebrew: KEBAB, item_name: '', ...extra,
});

describe('weightDoubts', () => {
  it('lists doubted rows the worker has not confirmed', () => {
    const rows = [row('a', 8, { weight_suspect: doubt }), row('b', 8), row('c', 8, { weight_suspect: doubt, weight_checked: true })];
    expect(weightDoubts(rows).map((r) => r.barcode)).toEqual(['a']);
  });
});

describe('sharedDoubt', () => {
  it('offers one decision when the doubts are one item at one weight', () => {
    const rows = [row('a', 8, { weight_suspect: doubt }), row('b', 8, { weight_suspect: doubt }), row('c', 12.1)];
    expect(sharedDoubt(rows)).toEqual({ weight: 8, name: KEBAB });
  });
  it('none for a mix of weights or items, or no doubts', () => {
    expect(sharedDoubt([row('a', 8, { weight_suspect: doubt }), row('b', 8.2, { weight_suspect: doubt })])).toBeNull();
    expect(sharedDoubt([
      row('a', 8, { weight_suspect: doubt }),
      row('b', 8, { weight_suspect: doubt, item_name_hebrew: 'קציצות בקר' }),
    ])).toBeNull();
    expect(sharedDoubt([row('a', 8)])).toBeNull();
  });
});

describe('acceptDoubts', () => {
  it('confirms every doubted row and changes nothing else', () => {
    const rows = [row('a', 8, { weight_suspect: doubt }), row('b', 12)];
    const out = acceptDoubts(rows);
    expect(out[0]).toEqual({ ...row('a', 8), weight_suspect: undefined, weight_checked: true });
    expect(out[1]).toBe(rows[1]);
  });
  it('can confirm only some rows', () => {
    const rows = [row('a', 8, { weight_suspect: doubt }), row('b', 8, { weight_suspect: doubt })];
    const out = acceptDoubts(rows, new Set(['b']));
    expect(out[0].weight_suspect).toEqual(doubt);
    expect(out[1].weight_checked).toBe(true);
  });
});
