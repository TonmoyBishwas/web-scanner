import { describe, it, expect } from 'vitest';
import { countPrefill, noteRemainingForPallet, type CountPrefillInput } from './count-prefill';

const kebab = { item_code: '97200001', item_name_hebrew: 'קבבונים', box_count: 15 };
const strog = { item_code: '7290003570867', item_name_hebrew: 'סטרוגונוף', box_count: 20 };
const thighs = { item_code: '7290003670338', item_name_hebrew: 'ירכיים', box_count: 12 };

function base(over: Partial<CountPrefillInput> = {}): CountPrefillInput {
  return {
    lines: [strog, thighs, kebab],
    palletCount: 1,
    currentPallet: 1,
    looseBoxCount: 0,
    isSplit: false,
    completedBoxCounts: [],
    meatCommitted: {},
    scannedTotal: 4,
    ...over,
  };
}

describe('noteRemainingForPallet', () => {
  it('only pallet, no loose: the whole note (IN264171048: 20+12+15)', () => {
    expect(noteRemainingForPallet(base())).toBe(47);
  });
  it('last pallet: note minus what earlier pallets booked', () => {
    expect(noteRemainingForPallet(base({ lines: [{ item_code: '1472', box_count: 130 }], palletCount: 2, currentPallet: 2, completedBoxCounts: [65] }))).toBe(65);
  });
  it('not knowable on pallet 1 of 2, with loose boxes to come, on a split job, or with a line missing its count', () => {
    expect(noteRemainingForPallet(base({ palletCount: 2, currentPallet: 1 }))).toBeNull();
    expect(noteRemainingForPallet(base({ looseBoxCount: 3 }))).toBeNull();
    expect(noteRemainingForPallet(base({ isSplit: true }))).toBeNull();
    expect(noteRemainingForPallet(base({ lines: [strog, { item_code: 'x', box_count: 0 }] }))).toBeNull();
    expect(noteRemainingForPallet(base({ lines: [] }))).toBeNull();
  });
});

describe('countPrefill — single-item shortcut', () => {
  it('offers the note line for a one-line note', () => {
    expect(countPrefill(base({ lines: [kebab], singleItemLine: kebab, scannedTotal: 2 })))
      .toEqual({ value: 15, source: 'note' });
  });
  it('capped by the item line when the note has other items', () => {
    expect(countPrefill(base({ singleItemLine: kebab, scannedTotal: 2 })))
      .toEqual({ value: 15, source: 'note' });
  });
  it('subtracts damaged-sticker cartons already declared for the item', () => {
    expect(countPrefill(base({ lines: [kebab], singleItemLine: kebab, meatCommitted: { '97200001': 5 }, scannedTotal: 2 })))
      .toEqual({ value: 10, source: 'note' });
  });
  it('the last pallet of a split item gets what pallet 1 left', () => {
    const line = { item_code: '1472', box_count: 130 };
    expect(countPrefill(base({ lines: [line], singleItemLine: line, palletCount: 2, currentPallet: 2, completedBoxCounts: [70], scannedTotal: 2 })))
      .toEqual({ value: 60, source: 'note' });
  });
  it('never falls back to the 2 samples: no note figure → nothing', () => {
    expect(countPrefill(base({ singleItemLine: null, scannedTotal: 2 }))).toBeNull();
    expect(countPrefill(base({ singleItemLine: kebab, palletCount: 2, currentPallet: 1, scannedTotal: 2 }))).toBeNull();
  });
  it('a note figure below the rows already scanned is still offered (48429: Set then explains)', () => {
    const line = { item_code: '1', box_count: 3 };
    expect(countPrefill(base({ lines: [line], singleItemLine: line, completedBoxCounts: [], scannedTotal: 4 })))
      .toEqual({ value: 3, source: 'note' });
  });
});

describe('countPrefill — mixed pallet', () => {
  it('prefers the note when it is knowable', () => {
    expect(countPrefill(base())).toEqual({ value: 47, source: 'note' });
  });
  it('falls back to the scanned count on pallet 1 of 2', () => {
    expect(countPrefill(base({ palletCount: 2, currentPallet: 1, scannedTotal: 6 })))
      .toEqual({ value: 6, source: 'scanned' });
  });
  it('offers the note even when the list is above it (48429: note 22, list 25 — a double count)', () => {
    expect(countPrefill(base({ lines: [{ item_code: 'a', box_count: 22 }], scannedTotal: 25 })))
      .toEqual({ value: 22, source: 'note' });
  });
  it('falls back to the scanned count when the note owes this pallet nothing', () => {
    expect(countPrefill(base({ lines: [{ item_code: 'a', box_count: 10 }], palletCount: 2, currentPallet: 2, completedBoxCounts: [10], scannedTotal: 5 })))
      .toEqual({ value: 5, source: 'scanned' });
  });
  it('a one-carton pallet is offered its one carton; an empty list nothing', () => {
    expect(countPrefill(base({ palletCount: 2, scannedTotal: 1 }))).toEqual({ value: 1, source: 'scanned' });
    expect(countPrefill(base({ palletCount: 2, scannedTotal: 0 }))).toBeNull();
  });
});
