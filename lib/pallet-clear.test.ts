import { describe, expect, it } from 'vitest';
import {
  clampGroupCount,
  countGroupOf,
  groupRows,
  growGroupRows,
  parseClearMode,
  planLabelClear,
  rowsToShrink,
  type ClearableLabel,
} from './pallet-clear';

const L = (id: string, over: Partial<ClearableLabel> = {}): ClearableLabel => ({
  id, barcode: `28${id.padStart(14, '0')}`, status: 'created', origin: 'identical', pallet_number: 2, ...over,
});

describe('planLabelClear', () => {
  const labels = [
    L('1'),
    L('2', { origin: 'new_carton' }),
    L('3', { status: 'printed' }),
    L('4', { origin: 'receiving' }),
    L('5', { pallet_number: 1 }),
    L('6', { pallet_number: 0 }),
    L('7', { pallet_number: null }),
    L('8', { status: 'printed', origin: 'new_carton' }),
  ];
  const none = new Set<string>();
  const ids = (xs: ClearableLabel[]) => xs.map((x) => x.id);

  it('rows: unprinted identical / receiving labels on that pallet, never a New carton', () => {
    expect(ids(planLabelClear(labels, { mode: 'rows', pallet: 2, booked: none }))).toEqual(['1', '4']);
  });

  it('unprinted: every created label on that pallet, New carton included', () => {
    expect(ids(planLabelClear(labels, { mode: 'unprinted', pallet: 2, booked: none }))).toEqual(['1', '2', '4']);
  });

  it('void_printed: only printed labels on that pallet', () => {
    expect(ids(planLabelClear(labels, { mode: 'void_printed', pallet: 2, booked: none }))).toEqual(['3', '8']);
  });

  it('the loose pile is pallet 0; an unknown pallet is never touched', () => {
    expect(ids(planLabelClear(labels, { mode: 'unprinted', pallet: 0, booked: none }))).toEqual(['6']);
  });

  it('never a booked carton, printed or not', () => {
    const booked = new Set([L('1').barcode, L('3').barcode]);
    expect(ids(planLabelClear(labels, { mode: 'unprinted', pallet: 2, booked }))).toEqual(['2', '4']);
    expect(ids(planLabelClear(labels, { mode: 'void_printed', pallet: 2, booked }))).toEqual(['8']);
  });

  it('parseClearMode accepts only the three modes', () => {
    expect(parseClearMode('rows')).toBe('rows');
    expect(parseClearMode('void_printed')).toBe('void_printed');
    expect(parseClearMode('all')).toBeNull();
    expect(parseClearMode(undefined)).toBeNull();
  });
});

describe('identical group count', () => {
  type Row = { barcode: string; minted?: boolean; label_batch_id?: string; count_group?: string; image_data?: string; scanned_at?: string; weight?: number };
  const rows: Row[] = [
    { barcode: 'A' },
    { barcode: 'm1', minted: true, label_batch_id: 'b1', image_data: 'img', weight: 10 },
    { barcode: 'm2', minted: true, label_batch_id: 'b1', weight: 10 },
    { barcode: 'm3', minted: true, label_batch_id: 'b1', weight: 10 },
    { barcode: 'B' },
    { barcode: 'x1', minted: true, label_batch_id: 'b2' },
  ];

  it('a group is the batch a minted row was first saved as', () => {
    expect(countGroupOf(rows[0])).toBeNull();
    expect(countGroupOf(rows[1])).toBe('b1');
    expect(countGroupOf({ barcode: 'g', minted: true, label_batch_id: 'b9', count_group: 'b1' })).toBe('b1');
    expect(groupRows(rows, 'b1').map((r) => r.barcode)).toEqual(['m1', 'm2', 'm3']);
  });

  it('shrink takes the last rows, unprinted labels first', () => {
    expect(rowsToShrink(rows, 'b1', 1, new Set(['m1', 'm2', 'm3']))).toEqual(['m3']);
    // m3 is printed: the unprinted m2 and m1 go before it.
    expect(rowsToShrink(rows, 'b1', 2, new Set(['m1', 'm2']))).toEqual(['m2', 'm1']);
    expect(rowsToShrink(rows, 'b1', 3, new Set(['m2']))).toEqual(['m2', 'm3', 'm1']);
    expect(rowsToShrink(rows, 'b1', 0, new Set())).toEqual([]);
    expect(rowsToShrink(rows, 'b1', 9, new Set()).length).toBe(3);
  });

  it('grow adds one row per new label after the group, same data, own batch', () => {
    const grown = growGroupRows(rows, 'b1', [{ barcode: 'n1', batch_id: 'b3' }, { barcode: 'n2', batch_id: 'b3' }], 'T');
    expect(grown.map((r) => r.barcode)).toEqual(['A', 'm1', 'm2', 'm3', 'n1', 'n2', 'B', 'x1']);
    const n1 = grown[4];
    expect(n1).toMatchObject({ minted: true, label_batch_id: 'b3', count_group: 'b1', weight: 10, scanned_at: 'T' });
    expect(n1.image_data).toBeUndefined();
    expect(groupRows(grown, 'b1').length).toBe(5);
    // A later shrink of the group reaches the grown rows first.
    expect(rowsToShrink(grown, 'b1', 2, new Set(['n1', 'n2', 'm3']))).toEqual(['n2', 'n1']);
  });

  it('grow on an unknown group changes nothing', () => {
    expect(growGroupRows(rows, 'zz', [{ barcode: 'n1', batch_id: 'b3' }]).map((r) => r.barcode))
      .toEqual(rows.map((r) => r.barcode));
  });

  it('count bounds: 1..500 whole cartons', () => {
    expect(clampGroupCount(1)).toBe(1);
    expect(clampGroupCount(500)).toBe(500);
    expect(clampGroupCount(0)).toBeNull();
    expect(clampGroupCount(501)).toBeNull();
    expect(clampGroupCount(2.5)).toBeNull();
    expect(clampGroupCount(NaN)).toBeNull();
  });
});
