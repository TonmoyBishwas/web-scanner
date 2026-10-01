import { describe, it, expect } from 'vitest';
import {
  blockingLabels,
  barcodesBeingBooked,
  labelGateError,
  LABELS_NOT_PRINTED,
  type GateLabel,
} from './label-gate';

const identical = (barcode: string, batch = 'b-ident'): GateLabel => ({ barcode, batch_id: batch, origin: 'identical' });
const receiving = (barcode: string, batch = 'b-recv'): GateLabel => ({ barcode, batch_id: batch, origin: 'receiving' });
const newCarton = (barcode: string, batch = 'b-new'): GateLabel => ({ barcode, batch_id: batch, origin: 'new_carton' });

describe('blockingLabels', () => {
  it('nothing unprinted → nothing blocks', () => {
    expect(blockingLabels([], ['2826100100000001'])).toEqual({ count: 0, batchIds: [] });
  });

  it('an unprinted New carton label blocks even with an empty list (rule ii)', () => {
    expect(blockingLabels([newCarton('2826100100000001')], [])).toEqual({ count: 1, batchIds: ['b-new'] });
  });

  it('an identical label whose carton is on the list blocks (rule i)', () => {
    const gate = blockingLabels(
      [identical('2826100100000001'), identical('2826100100000002')],
      ['7290003571123', '2826100100000001', '2826100100000002'],
    );
    expect(gate).toEqual({ count: 2, batchIds: ['b-ident'] });
  });

  it('an identical label NOT on the list (orphan, batch 0877ca78) does not block', () => {
    expect(blockingLabels([identical('2826092455917503', '0877ca78')], ['7290003571123'])).toEqual({
      count: 0,
      batchIds: [],
    });
  });

  it('a receiving (edit-panel) label on the list blocks; off the list it does not', () => {
    expect(blockingLabels([receiving('2826100100000009')], ['2826100100000009']).count).toBe(1);
    expect(blockingLabels([receiving('2826100100000009')], ['2826100100000001']).count).toBe(0);
  });

  it('counts only what blocks: on-list + New carton, never the orphans', () => {
    const gate = blockingLabels(
      [
        identical('2826100100000001', 'A'),
        identical('2826100100000002', 'A'),
        identical('2826100100000003', 'ORPHAN'),
        newCarton('2826100100000004', 'N'),
        receiving('2826100100000005', 'R'),
      ],
      ['2826100100000001', '2826100100000002', '2826100100000005'],
    );
    expect(gate.count).toBe(4);
    expect(gate.batchIds).toEqual(['A', 'N', 'R']);
  });

  it('de-duplicates batch ids and a repeated label', () => {
    const gate = blockingLabels(
      [newCarton('2826100100000001', 'N'), newCarton('2826100100000002', 'N'), newCarton('2826100100000001', 'N')],
      [],
    );
    expect(gate).toEqual({ count: 2, batchIds: ['N'] });
  });

  it('accepts any iterable of list barcodes and ignores blanks', () => {
    const list = new Set(['', '2826100100000001']);
    expect(blockingLabels([identical('2826100100000001')], list).count).toBe(1);
    expect(blockingLabels([identical('2826100100000001')], [' 2826100100000001 ']).count).toBe(1);
  });
});

describe('barcodesBeingBooked', () => {
  it('collects scanned rows and the non-meat / damaged-sticker samples', () => {
    expect(
      barcodesBeingBooked({
        scanned_boxes: [{ barcode: '2826100100000001' }, { barcode: '7290003571123' }],
        nonmeat_items: [{ item_key: 'x', sample_barcode: '5000000000001' }],
        manual_items: [{ item_key: 'y', box_count: 3 }, { item_key: 'z', sample_barcode: ' 6000000000002 ' }],
      }),
    ).toEqual(['2826100100000001', '7290003571123', '5000000000001', '6000000000002']);
  });

  it('treats anything malformed as no barcodes', () => {
    expect(barcodesBeingBooked({})).toEqual([]);
    expect(barcodesBeingBooked({ scanned_boxes: 'nope', nonmeat_items: null, manual_items: [null, 5, { barcode: 1 }] })).toEqual([]);
    expect(barcodesBeingBooked({ scanned_boxes: [{ barcode: '' }, { barcode: '   ' }] })).toEqual([]);
  });

  it('feeds the gate: a booked identical carton blocks the request', () => {
    const codes = barcodesBeingBooked({ scanned_boxes: [{ barcode: '2826100100000001' }] });
    expect(blockingLabels([identical('2826100100000001')], codes).count).toBe(1);
  });
});

describe('labelGateError', () => {
  it('is the 409 body the page and the manual flows map', () => {
    expect(labelGateError({ count: 9, batchIds: ['A', 'N'] })).toEqual({
      success: false,
      error: LABELS_NOT_PRINTED,
      unprinted: 9,
      batch_ids: ['A', 'N'],
    });
    expect(LABELS_NOT_PRINTED).toBe('labels_not_printed');
  });
});
