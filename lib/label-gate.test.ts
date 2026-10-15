import { describe, it, expect } from 'vitest';
import {
  blockingLabels,
  barcodesBeingBooked,
  unprintedOnList,
  labelGateError,
  LABELS_NOT_PRINTED,
  labelPrintGateEnabled,
  printGate,
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

describe('Q5 — a New carton counted at its saved weight never blocks', () => {
  it('its label on the list being booked does not block; it is flagged instead', () => {
    const labels = [newCarton('2826101300000001', 'N')];
    const list = ['7290003670444015320158115072027', '2826101300000001'];
    expect(blockingLabels(labels, list)).toEqual({ count: 0, batchIds: [] });
    expect([...unprintedOnList(labels, list)]).toEqual(['2826101300000001']);
  });

  it('its label already booked on an earlier pallet / the loose pile does not block the next list', () => {
    const labels = [newCarton('2826101300000001', 'N')];
    expect(blockingLabels(labels, ['7290003670444015320158115072027'], ['2826101300000001']).count).toBe(0);
  });

  it('a New carton label on NO list still blocks (row deleted, or saved before Q5)', () => {
    expect(blockingLabels([newCarton('2826101300000009', 'N')], ['7290003670444015320158115072027'], ['2826101300000001']))
      .toEqual({ count: 1, batchIds: ['N'] });
  });

  it('twin / identical / receiving labels on the list still block exactly as before', () => {
    const labels = [identical('2826101300000002', 'T'), receiving('2826101300000003', 'R'), newCarton('2826101300000004', 'N')];
    const list = ['2826101300000002', '2826101300000003', '2826101300000004'];
    expect(blockingLabels(labels, list, list)).toEqual({ count: 2, batchIds: ['T', 'R'] });
    // A booked identical label is not this list's business (rule i only).
    expect(blockingLabels([identical('2826101300000002', 'T')], [], ['2826101300000002']).count).toBe(0);
  });

  it('unprintedOnList ignores labels off the list', () => {
    expect(unprintedOnList([newCarton('2826101300000001'), newCarton('2826101300000005')], ['2826101300000001']).size).toBe(1);
    expect(unprintedOnList([], ['2826101300000001']).size).toBe(0);
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

describe('LABEL_PRINT_GATE', () => {
  it('is off unless the env says on / true / 1', () => {
    expect(labelPrintGateEnabled(undefined)).toBe(false);
    expect(labelPrintGateEnabled('')).toBe(false);
    expect(labelPrintGateEnabled('off')).toBe(false);
    expect(labelPrintGateEnabled('no')).toBe(false);
    expect(labelPrintGateEnabled('on')).toBe(true);
    expect(labelPrintGateEnabled(' ON ')).toBe(true);
    expect(labelPrintGateEnabled('true')).toBe(true);
    expect(labelPrintGateEnabled('1')).toBe(true);
  });

  const labels = [identical('2826100100000001'), receiving('2826100100000002'), newCarton('2826100100000003')];
  const list = ['2826100100000001', '2826100100000002'];

  it('off: nothing blocks, not even a New carton on no list', () => {
    expect(printGate(labels, list, [], false)).toEqual({ count: 0, batchIds: [] });
  });

  it('on: the same rules as blockingLabels', () => {
    expect(printGate(labels, list, [], true)).toEqual(blockingLabels(labels, list, []));
    expect(printGate(labels, list, [], true).count).toBe(3);
  });

  it('off: every unprinted label on the list goes to the bot as label_printed:false', () => {
    // The completion routes flag exactly unprintedOnList — with the gate off
    // that now includes identical / receiving labels, not only New cartons.
    expect([...unprintedOnList(labels, list)].sort()).toEqual(['2826100100000001', '2826100100000002']);
  });
});
