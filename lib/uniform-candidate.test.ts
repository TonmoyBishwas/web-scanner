import { describe, it, expect } from 'vitest';
import { uniformCandidate, labelPrintsWeight, uniformAfterEditAllowed, uniformListSettled, type UniformSampleRow } from './uniform-candidate';

const keyOf = (b: UniformSampleRow) => `he:${b.item_name_hebrew}`;
const opts = { minSamples: 2, tolerance: 0.0001 };
const row = (barcode: string, weight: number, extra: Partial<UniformSampleRow> = {}): UniformSampleRow => ({
  barcode, weight, item_name_hebrew: 'קבב מוסדי', item_name: '', ...extra,
});

// Two catch-weight cartons, same GTIN and same 12.35 kg, different expiry
// digits — byte-different codes, so both are on the list.
const CW1 = '7290002195832012350128430052027';
const CW2 = '7290002195832012350128431052027';

describe('uniformCandidate', () => {
  it('two cartons of one product at one weight → the shortcut', () => {
    const c = uniformCandidate([row('7290004456856001', 8), row('7290004456856002', 8)], keyOf, opts);
    expect(c).toMatchObject({ avg_weight: 8, sample_barcodes: ['7290004456856001', '7290004456856002'] });
  });

  it('fewer than two samples → nothing', () => {
    expect(uniformCandidate([row('1', 8)], keyOf, opts)).toBeNull();
  });

  it('weights 1 g apart → nothing (catch weight)', () => {
    expect(uniformCandidate([row('1', 10.09), row('2', 10.089)], keyOf, opts)).toBeNull();
  });

  it('two products → nothing', () => {
    expect(uniformCandidate([row('1', 8), row('2', 8, { item_name_hebrew: 'קציצות' })], keyOf, opts)).toBeNull();
  });

  it('a minted row on the list → nothing', () => {
    expect(uniformCandidate([row('1', 8), row('2', 8, { minted: true })], keyOf, opts)).toBeNull();
  });

  it('31-digit labels that print their own weight are skipped, even at one weight (19/10)', () => {
    expect(labelPrintsWeight(CW1)).toBe(true);
    expect(uniformCandidate([row(CW1, 12.35), row(CW2, 12.35)], keyOf, opts)).toBeNull();
  });

  it('one self-weight label among the samples is enough to skip', () => {
    expect(uniformCandidate([row(CW1, 12.35), row('7290002195832', 12.35)], keyOf, opts)).toBeNull();
  });

  it('a 13-digit EAN prints no weight', () => {
    expect(labelPrintsWeight('7290004456856')).toBe(false);
    expect(labelPrintsWeight('NOBC-48429-P1-1')).toBe(false);
  });
});

describe('uniformAfterEditAllowed (flag uniform_after_count, 04/11)', () => {
  // Glatt ground turkey: 25-digit codes whose weight field is 0001 — the
  // label prints no net weight; the worker types 8 kg on each.
  const G1 = '1' + '02465' + '010010' + '0001' + '000708241';
  const G2 = '1' + '02465' + '010010' + '0001' + '000708309';
  const open = { confirmedBoxCount: 0, pendingSingle: false };

  it('two weightless-label cartons typed at the same weight: allowed, and they are a candidate', () => {
    const rows = [row(G1, 8), row(G2, 8)];
    expect(labelPrintsWeight(G1)).toBe(false);
    expect(uniformAfterEditAllowed(rows, open)).toBe(true);
    expect(uniformCandidate(rows, keyOf, opts)).toMatchObject({ avg_weight: 8, sample_barcodes: [G1, G2] });
  });

  it('a declared total closes it', () => {
    expect(uniformAfterEditAllowed([row(G1, 8), row(G2, 8)], { confirmedBoxCount: 50, pendingSingle: false })).toBe(false);
  });

  it('a single-item answer already in progress closes it', () => {
    expect(uniformAfterEditAllowed([row(G1, 8), row(G2, 8)], { confirmedBoxCount: 0, pendingSingle: true })).toBe(false);
  });

  it('any minted row on the list closes it — a 28… label, a twin, a New carton row, a NOBC- marker', () => {
    expect(uniformAfterEditAllowed([row(G1, 8), row(G2, 8), row('2826110400000017', 8)], open)).toBe(false);
    expect(uniformAfterEditAllowed([row(G1, 8), row('7290004456856001', 8, { minted: true })], open)).toBe(false);
    expect(uniformAfterEditAllowed([row(G1, 8), { barcode: '7290004456856001', twin: true } as never], open)).toBe(false);
    expect(uniformAfterEditAllowed([row(G1, 8), { barcode: '7290004456856001', new_carton: true } as never], open)).toBe(false);
    expect(uniformAfterEditAllowed([row(G1, 8), row('NOBC-261063350-1-3', 8)], open)).toBe(false);
  });

  it('a weight he typed (barcode_source typed) is not minted', () => {
    expect(uniformAfterEditAllowed([row(G1, 8, { barcode_source: 'typed' } as never), row(G2, 8)], open)).toBe(true);
  });

  // Review blocker (04/11): the candidate sees only finished rows with a
  // weight, so 2 typed at 8 kg beside 2 still 0 kg / needs_review raised the
  // question, and "whole pallet" + total auto-confirmed the 0 kg cartons.
  describe('4 cartons, 2 typed at 8 kg, 2 still 0 kg / needs_review', () => {
    const G3 = '1' + '02465' + '010010' + '0001' + '000708377';
    const G4 = '1' + '02465' + '010010' + '0001' + '000708412';
    type R = UniformSampleRow & { ocr_status?: string; needs_review?: boolean };
    const typed = (b: string): R => ({ ...row(b, 8), ocr_status: 'done' });
    const unread = (b: string): R => ({ ...row(b, 0), ocr_status: 'done', needs_review: true });
    // The page's filter for what the candidate sees (maybeTriggerUniformPrompt).
    const doneOf = (rows: R[]) => rows.filter((b) => b.ocr_status === 'done' && b.weight > 0);
    // What the page asks: allowed after the save, a candidate, and the list settled.
    const prompts = (rows: R[]) => {
      if (!uniformAfterEditAllowed(rows, open)) return false;
      const c = uniformCandidate(doneOf(rows), keyOf, opts);
      return !!c && uniformListSettled(rows, c.name_key, keyOf);
    };

    it('two of four edited → no prompt (the 0 kg rows hold it)', () => {
      const rows = [typed(G1), typed(G2), unread(G3), unread(G4)];
      // The hole: the candidate alone would have asked.
      expect(uniformCandidate(doneOf(rows), keyOf, opts)).not.toBeNull();
      expect(uniformAfterEditAllowed(rows, open)).toBe(false);
      expect(uniformListSettled(rows, 'he:קבב מוסדי', keyOf)).toBe(false);
      expect(prompts(rows)).toBe(false);
    });

    it('three of four edited → still no prompt', () => {
      expect(prompts([typed(G1), typed(G2), typed(G3), unread(G4)])).toBe(false);
    });

    it('all four edited → the prompt, with all four as samples', () => {
      const rows = [typed(G1), typed(G2), typed(G3), typed(G4)];
      expect(prompts(rows)).toBe(true);
      expect(uniformCandidate(doneOf(rows), keyOf, opts)).toMatchObject({ avg_weight: 8, sample_barcodes: [G1, G2, G3, G4] });
    });

    it('a same-product row at 0 kg with no review flag still holds it', () => {
      const rows = [typed(G1), typed(G2), { ...row(G3, 0), ocr_status: 'done' }];
      expect(uniformAfterEditAllowed(rows, open)).toBe(true);
      expect(uniformListSettled(rows, 'he:קבב מוסדי', keyOf)).toBe(false);
      expect(prompts(rows)).toBe(false);
    });

    it('a failed read on the list holds it; a 0 kg row of another product alone does not', () => {
      const failed: R = { ...row(G3, 0, { item_name_hebrew: '' }), ocr_status: 'failed' };
      expect(prompts([typed(G1), typed(G2), failed])).toBe(false);
      const other: R = { ...row(G3, 0, { item_name_hebrew: 'קציצות' }), ocr_status: 'done' };
      expect(uniformListSettled([typed(G1), typed(G2), other], 'he:קבב מוסדי', keyOf)).toBe(true);
    });
  });
});
