import { describe, it, expect } from 'vitest';
import { isSplitSession, splitStateOf, applySplitState } from './session-mode';
import { buildSlots } from './pallet-slots';
import type { MultiPalletSession } from '@/types';

function base(): MultiPalletSession {
  return {
    token: 't1', chat_id: '111', pallet_count: 3, loose_box_count: 0,
    current_pallet: 1, document_number: 'INV1', ocr_data: [],
    completed_pallets: [], status: 'active', created_at: '2026-08-05T10:00:00.000Z',
  } as MultiPalletSession;
}

describe('isSplitSession', () => {
  it('treats a legacy session with no mode as single', () => {
    expect(isSplitSession(base())).toBe(false);
  });

  it('treats an explicit single session as single', () => {
    expect(isSplitSession({ ...base(), mode: 'single' })).toBe(false);
  });

  it('recognises a split session', () => {
    const s = { ...base(), mode: 'split' as const, roster: [], pallets: buildSlots(3), loose: null };
    expect(isSplitSession(s)).toBe(true);
  });
});

describe('splitStateOf / applySplitState', () => {
  it('round-trips the split state', () => {
    const s = {
      ...base(), mode: 'split' as const,
      roster: [{ chat_id: 'yossi', nickname: 'Yossi', quota: 2 }],
      pallets: buildSlots(3), loose: null,
    };
    const state = splitStateOf(s);
    expect(state.pallets).toHaveLength(3);
    const back = applySplitState(s, { ...state, pallets: buildSlots(4) });
    expect(back.pallets).toHaveLength(4);
    expect(back.pallet_count).toBe(4);
  });

  it('throws when asked for split state on a single session', () => {
    expect(() => splitStateOf(base())).toThrow();
  });
});
