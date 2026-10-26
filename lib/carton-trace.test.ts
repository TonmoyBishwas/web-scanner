import { describe, it, expect } from 'vitest';
import { cartonSaveBlock, cartonSaveTapData } from './carton-trace';

const OPEN = { selected: true, saving: false, count: 14, dateError: null, weightMissing: false, expiryMissing: false };

describe('cartonSaveBlock (Wall Dan 25/10: 3 min 20 s of silence in New carton)', () => {
  it('a Save that goes through is not blocked', () => {
    expect(cartonSaveBlock(OPEN)).toBeNull();
  });

  it('names what held Save back, in the order the form checks it', () => {
    expect(cartonSaveBlock({ ...OPEN, selected: false })).toBe('item');
    expect(cartonSaveBlock({ ...OPEN, saving: true })).toBe('saving');
    expect(cartonSaveBlock({ ...OPEN, count: 0 })).toBe('count');
    expect(cartonSaveBlock({ ...OPEN, dateError: 'expiry before production' })).toBe('date');
    expect(cartonSaveBlock({ ...OPEN, weightMissing: true })).toBe('weight');
    expect(cartonSaveBlock({ ...OPEN, expiryMissing: true })).toBe('expiry');
    expect(cartonSaveBlock({ ...OPEN, dateError: 'x', weightMissing: true, expiryMissing: true })).toBe('date');
  });
});

describe('cartonSaveTapData', () => {
  const tap = {
    itemCode: '501004',
    quantity: 14,
    weight: '10.5',
    production: '2026-10-20',
    expiry: '2026-11-20',
    notes: 'torn sticker, from the top row',
    blocked: null,
  };

  it('carries what the worker entered', () => {
    expect(cartonSaveTapData(tap)).toEqual({
      item_code: '501004',
      quantity: 14,
      weight: '10.5',
      production: '2026-10-20',
      expiry: '2026-11-20',
      notes_len: 30,
      blocked: null,
    });
  });

  it('never the free-text notes, only their length', () => {
    const data = cartonSaveTapData(tap);
    expect(JSON.stringify(data)).not.toContain('torn sticker');
    expect(cartonSaveTapData({ ...tap, notes: '   ' }).notes_len).toBe(0);
  });

  it('a blank date is null, not an empty string', () => {
    const data = cartonSaveTapData({ ...tap, itemCode: undefined, production: '', expiry: '', blocked: 'expiry' });
    expect(data.item_code).toBeNull();
    expect(data.production).toBeNull();
    expect(data.expiry).toBeNull();
    expect(data.blocked).toBe('expiry');
  });
});
