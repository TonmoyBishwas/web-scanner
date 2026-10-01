import { describe, it, expect } from 'vitest';
import {
  isMintedLabelBarcode,
  parseBatchId,
  newBatchId,
  parseLabelOrigin,
  toUnprintedLabels,
  labelTags,
  sortUnprintedFirst,
  rowsOnList,
  loadLabelSize,
  labelSheetUrl,
  type LiveRowPlace,
} from './label-batches';

describe('isMintedLabelBarcode', () => {
  it('is 28 + 14 digits, nothing else', () => {
    expect(isMintedLabelBarcode('2826092455917503')).toBe(true);
    expect(isMintedLabelBarcode(' 2826092455917503 ')).toBe(true);
    expect(isMintedLabelBarcode('7290003571123')).toBe(false); // supplier GTIN
    expect(isMintedLabelBarcode('2000090300667')).toBe(false); // supplier in-house 20…
    expect(isMintedLabelBarcode('282609245591750')).toBe(false); // 15 digits
    expect(isMintedLabelBarcode('NOBC-IN26-P1-3')).toBe(false);
    expect(isMintedLabelBarcode(undefined)).toBe(false);
  });
});

describe('parseBatchId', () => {
  it('accepts a UUID (lower-cased) and refuses anything else', () => {
    expect(parseBatchId('84DDA933-0C38-4162-B654-61A09C03A239')).toBe('84dda933-0c38-4162-b654-61a09c03a239');
    expect(parseBatchId('not-a-uuid')).toBeNull();
    expect(parseBatchId("x'; drop table carton_labels;--")).toBeNull();
    expect(parseBatchId(42)).toBeNull();
    expect(parseBatchId(undefined)).toBeNull();
  });
});

describe('newBatchId', () => {
  it('is a UUID the server accepts, different every time', () => {
    const a = newBatchId();
    const b = newBatchId();
    expect(parseBatchId(a)).toBe(a.toLowerCase());
    expect(a).not.toBe(b);
  });
});

describe('parseLabelOrigin', () => {
  it('keeps identical / receiving, defaults the rest to new_carton', () => {
    expect(parseLabelOrigin('identical')).toBe('identical');
    expect(parseLabelOrigin('receiving')).toBe('receiving');
    expect(parseLabelOrigin('new_carton')).toBe('new_carton');
    expect(parseLabelOrigin('anything')).toBe('new_carton');
    expect(parseLabelOrigin(undefined)).toBe('new_carton');
  });
});

describe('toUnprintedLabels', () => {
  it('keeps the fields the page needs and drops printed / malformed rows', () => {
    const out = toUnprintedLabels([
      { barcode: '2826092455917503', batch_id: 'b1', origin: 'identical', pallet_number: 2, status: 'created' },
      { barcode: '2826092455917504', batch_id: 'b1', origin: 'identical', pallet_number: 2, status: 'printed' },
      { barcode: '2826092455917505', batch_id: 'b2', origin: 'weird', pallet_number: null },
      { batch_id: 'b3' },
      null,
    ]);
    expect(out).toEqual([
      { barcode: '2826092455917503', batch_id: 'b1', origin: 'identical', pallet_number: 2 },
      { barcode: '2826092455917505', batch_id: 'b2', origin: 'new_carton', pallet_number: null },
    ]);
    expect(toUnprintedLabels({ nope: true })).toEqual([]);
  });
});

describe('labelTags', () => {
  it('names the pallet, the loose pile, and New carton', () => {
    expect(labelTags({ origin: 'identical', pallet_number: 3 })).toEqual([{ kind: 'pallet', n: 3 }]);
    expect(labelTags({ origin: 'identical', pallet_number: 0 })).toEqual([{ kind: 'loose' }]);
    expect(labelTags({ origin: 'new_carton', pallet_number: 2 })).toEqual([{ kind: 'new_carton' }, { kind: 'pallet', n: 2 }]);
    expect(labelTags({ origin: 'new_carton', pallet_number: null })).toEqual([{ kind: 'new_carton' }]);
    expect(labelTags({ origin: 'receiving', pallet_number: null })).toEqual([]);
  });
});

describe('sortUnprintedFirst', () => {
  it('moves unprinted batches to the top and keeps the order otherwise', () => {
    const batches = [
      { id: 'a', count: 2, printedCount: 2 },
      { id: 'b', count: 6, printedCount: 0 },
      { id: 'c', count: 1, printedCount: 1 },
      { id: 'd', count: 3, printedCount: 1 },
    ];
    expect(sortUnprintedFirst(batches).map((b) => b.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(batches.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd']); // not mutated
  });
});

describe('rowsOnList', () => {
  const live = new Map<string, LiveRowPlace>([
    ['A', 1], ['B', 1], ['C', 1], ['L1', 'loose'],
  ]);

  it('counts the batch rows still on a list and says where', () => {
    expect(rowsOnList(['A', 'B', 'C', 'X'], live)).toEqual({ count: 3, place: 1 });
    expect(rowsOnList(['L1'], live)).toEqual({ count: 1, place: 'loose' });
  });

  it('is zero when nothing is on a list', () => {
    expect(rowsOnList(['X', 'Y'], live)).toEqual({ count: 0, place: null });
    expect(rowsOnList(['A'], undefined)).toEqual({ count: 0, place: null });
    expect(rowsOnList(['A'], new Map())).toEqual({ count: 0, place: null });
  });
});

describe('loadLabelSize', () => {
  it('falls back to 10x15 without browser storage', () => {
    expect(loadLabelSize()).toBe('10x15');
  });
});

describe('labelSheetUrl', () => {
  it('addresses the sheet by batch, size and language', () => {
    expect(labelSheetUrl({ token: 'Zr1/Ys', batchIds: ['b1', 'b2'], size: 'a4', language: 'Hebrew' }))
      .toBe('/labels/print?token=Zr1%2FYs&batches=b1%2Cb2&size=a4&lang=Hebrew');
  });
});
