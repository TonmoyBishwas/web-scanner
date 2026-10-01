import { describe, it, expect } from 'vitest';
import {
  isMintedLabelBarcode,
  parseBatchId,
  newBatchId,
  batchIdForPayload,
  batchMatchesRequest,
  chunked,
  printCountSteps,
  parseLabelOrigin,
  toUnprintedLabels,
  labelTags,
  sortUnprintedFirst,
  rowsOnList,
  openListsForPhase,
  liveRowPlaces,
  sessionBookedBarcodes,
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

describe('batchIdForPayload', () => {
  it('the same save content keeps its id (a retry after a lost response)', () => {
    const ids = new Map<string, string>();
    const a = batchIdForPayload(ids, { quantity: 12, weight_kg: 10.2 });
    expect(batchIdForPayload(ids, { quantity: 12, weight_kg: 10.2 })).toBe(a);
    expect(parseBatchId(a)).toBe(a.toLowerCase());
  });

  it('changed content gets a new id — and going back to the first content its old one', () => {
    const ids = new Map<string, string>();
    const a = batchIdForPayload(ids, { quantity: 12, weight_kg: 10.2 });
    const b = batchIdForPayload(ids, { quantity: 14, weight_kg: 10.4 });
    expect(b).not.toBe(a);
    expect(batchIdForPayload(ids, { quantity: 12, weight_kg: 10.2 })).toBe(a);
  });
});

describe('batchMatchesRequest', () => {
  const row = {
    item_code: '1234', item_name_hebrew: 'אמנון', item_name_english: 'Tilapia', weight_kg: 10.2,
    production_date: '2026-09-20', expiry_date: '2026-10-20', notes: null, print_barcode: true,
    origin: 'identical' as const, source_barcode: '7290001455258', pallet_number: 2,
  };
  const req = {
    itemCode: '1234', itemNameHebrew: 'אמנון', itemNameEnglish: 'Tilapia', weightKg: 10.2, quantity: 2,
    productionDate: '2026-09-20', expiryDate: '2026-10-20', notes: null, printBarcode: true,
    origin: 'identical' as const, sourceBarcode: '7290001455258', palletNumber: 2,
  };

  it('the same save → the stored batch answers it', () => {
    expect(batchMatchesRequest([row, row], req)).toBe(true);
  });

  it('a numeric weight read back as a string, a DD/MM date, blank vs null → still the same', () => {
    expect(batchMatchesRequest(
      [{ ...row, weight_kg: '10.20' as unknown as number, notes: '' }, row],
      { ...req, expiryDate: '20/10/2026', notes: undefined },
    )).toBe(true);
  });

  it('another count, weight, date, item or pallet → not this batch', () => {
    expect(batchMatchesRequest([row, row], { ...req, quantity: 3 })).toBe(false);
    expect(batchMatchesRequest([row, row], { ...req, weightKg: 10.4 })).toBe(false);
    expect(batchMatchesRequest([row, row], { ...req, expiryDate: '2026-10-21' })).toBe(false);
    expect(batchMatchesRequest([row, row], { ...req, itemNameHebrew: 'סלמון' })).toBe(false);
    expect(batchMatchesRequest([row, row], { ...req, palletNumber: 3 })).toBe(false);
    expect(batchMatchesRequest([row, row], { ...req, weightKg: null })).toBe(false);
  });

  it('nothing stored → no match', () => {
    expect(batchMatchesRequest([], req)).toBe(false);
  });
});

describe('chunked', () => {
  it('slices of at most n, in order', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 200)).toEqual([]);
    expect(chunked(Array.from({ length: 500 }, (_, i) => i), 200).map((c) => c.length)).toEqual([200, 200, 100]);
  });
});

describe('printCountSteps', () => {
  it('a fresh batch is one step (every label at 0)', () => {
    expect(printCountSteps(Array(64).fill(0))).toEqual([0]);
  });

  it('distinct counts, highest first — a bumped row is never re-matched', () => {
    expect(printCountSteps([0, 1, 0, 2, 1])).toEqual([2, 1, 0]);
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

describe('openListsForPhase / liveRowPlaces', () => {
  const pallet = [{ barcode: 'A' }, { barcode: 'B' }];
  const loose = [{ barcode: 'L1' }];

  it('maps the open pallet list to the current pallet while it is scanned', () => {
    for (const phase of ['scanning', 'confirming']) {
      expect(openListsForPhase(phase)).toEqual({ pallet: true, loose: false });
      expect(liveRowPlaces({ phase, currentPallet: 3, pallet, loose })).toEqual(new Map([['A', 3], ['B', 3]]));
    }
  });

  it('maps only the loose pile during the loose phase (the last pallet is booked)', () => {
    for (const phase of ['loose_scanning', 'loose_confirming']) {
      expect(openListsForPhase(phase)).toEqual({ pallet: false, loose: true });
      expect(liveRowPlaces({ phase, currentPallet: 3, pallet, loose })).toEqual(new Map([['L1', 'loose']]));
    }
  });

  it('maps nothing once the rows are booked (pallet_done, all_done) or before scanning', () => {
    for (const phase of ['pallet_done', 'all_done', 'job', 'loading', 'error']) {
      expect(openListsForPhase(phase)).toEqual({ pallet: false, loose: false });
      expect(liveRowPlaces({ phase, currentPallet: 3, pallet, loose }).size).toBe(0);
    }
  });
});

describe('sessionBookedBarcodes', () => {
  it('collects every completed pallet\'s barcodes and the loose pile\'s', () => {
    const booked = sessionBookedBarcodes({
      completed_pallets: [
        { pallet_number: 1, barcodes: ['2826100100000001', '7290004456825'] },
        { pallet_number: 2 }, // a non-meat / declared-count pallet records none
        { pallet_number: 3, barcodes: ['2826100100000002', '', 7] },
      ],
      loose_barcodes: ['2826100100000003'],
    });
    expect([...booked].sort()).toEqual(['2826100100000001', '2826100100000002', '2826100100000003', '7290004456825']);
  });

  it('is empty for a session with nothing booked or a malformed payload', () => {
    expect(sessionBookedBarcodes({ completed_pallets: [] }).size).toBe(0);
    expect(sessionBookedBarcodes({ completed_pallets: 'x', loose_barcodes: {} }).size).toBe(0);
    expect(sessionBookedBarcodes(null).size).toBe(0);
    expect(sessionBookedBarcodes('{"completed_pallets":[]}').size).toBe(0);
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
