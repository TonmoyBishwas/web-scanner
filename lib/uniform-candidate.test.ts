import { describe, it, expect } from 'vitest';
import { uniformCandidate, labelPrintsWeight, type UniformSampleRow } from './uniform-candidate';

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
