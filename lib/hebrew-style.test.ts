import { describe, expect, it } from 'vitest';
import { he } from './i18n/he';
import { PACKAGING_LABELS, PACKAGING_PLURAL, PACKAGING_SINGULAR } from './receipt-form';

// Mevaser 21/10, rule 2: no slash gender forms (מלא/י, ענה/י, לחץ/י); the
// plural imperative only (מלאו, ענו, לחצו).
const SLASH_GENDER = /[֐-׿]+\/[יהתו]{1,2}(?![֐-׿])/;

describe('Hebrew style rules (Mevaser 21/10)', () => {
  it('no slash gender form in any Hebrew text', () => {
    const texts: [string, string][] = [
      ...Object.entries(he as Record<string, string>),
      ...[PACKAGING_LABELS, PACKAGING_PLURAL, PACKAGING_SINGULAR].flatMap((m) =>
        Object.entries(m).map(([k, v]) => [k, v.he] as [string, string]),
      ),
    ];
    expect(texts.filter(([, v]) => SLASH_GENDER.test(v))).toEqual([]);
  });
});
