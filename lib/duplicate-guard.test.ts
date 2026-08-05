import { describe, it, expect } from 'vitest';
import { findDuplicateOwner } from './duplicate-guard';
import type { MultiPalletSession } from '@/types';

function session(overrides: Partial<MultiPalletSession> = {}): MultiPalletSession {
  return {
    token: 't1', chat_id: '111', pallet_count: 3, loose_box_count: 0,
    current_pallet: 1, document_number: 'INV1', ocr_data: [],
    status: 'active', created_at: '2026-08-05T10:00:00.000Z',
    mode: 'split', category: 'meat',
    roster: [{ chat_id: 'yossi', nickname: 'Yossi', quota: null }],
    pallets: [
      { n: 1, owner: 'yossi', status: 'done', lpn: 'LPN-A-P1', box_count: 2 },
      { n: 2, owner: 'david', status: 'claimed' },
    ],
    loose: null,
    completed_pallets: [
      { pallet_number: 1, lpn: 'LPN-A-P1', pallet_type: 'single', box_count: 2,
        barcodes: ['7290000000011', '7290000000012'] },
    ],
    ...overrides,
  } as MultiPalletSession;
}

describe('findDuplicateOwner', () => {
  it('flags a barcode already registered on another pallet', () => {
    const hit = findDuplicateOwner(session(), '7290000000011', 2);
    expect(hit).toEqual({ pallet_n: 1, owner: 'yossi' });
  });

  it('returns null for a barcode nobody has scanned', () => {
    expect(findDuplicateOwner(session(), '7290000009999', 2)).toBeNull();
  });

  it('ignores the pallet currently being scanned', () => {
    expect(findDuplicateOwner(session(), '7290000000011', 1)).toBeNull();
  });

  it('never fires on non-meat, where SKUs repeat by design', () => {
    const s = session({ category: 'non_meat' });
    expect(findDuplicateOwner(s, '7290000000011', 2)).toBeNull();
  });

  it('never fires on a single-mode session', () => {
    const s = session({ mode: 'single' });
    expect(findDuplicateOwner(s, '7290000000011', 2)).toBeNull();
  });

  it('fires when category is absent — a legacy session is meat', () => {
    // Potency: exercises the `?? 'meat'` default. Every other fixture sets
    // category explicitly, so without this test the default could be dropped
    // and a pre-feature meat session would silently lose the guard.
    const s = session();
    delete (s as { category?: string }).category;
    expect(findDuplicateOwner(s, '7290000000011', 2)).toEqual({ pallet_n: 1, owner: 'yossi' });
  });

  it('ignores a blank barcode even when a blank was recorded', () => {
    // Potency: the fixture deliberately holds '' in barcodes, so `includes('')`
    // would match and report a false collision if the `if (!barcode)` guard
    // were removed. Asserting against a fixture with no '' proves nothing.
    const s = session({
      completed_pallets: [
        {
          pallet_number: 1, lpn: 'LPN-A-P1', pallet_type: 'single', box_count: 2,
          barcodes: ['', '7290000000012'],
        },
      ],
    });
    expect(findDuplicateOwner(s, '', 2)).toBeNull();
  });
});
