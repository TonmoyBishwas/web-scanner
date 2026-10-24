import { describe, it, expect } from 'vitest';
import { normalizeString } from './string-utils';

describe('normalizeString', () => {
  it('drops spaces and punctuation, keeps letters and digits', () => {
    expect(normalizeString('Meatballs - Red Base')).toBe('meatballsredbase');
    expect(normalizeString('קציצות ברוטב. אדום')).toBe('קציצותברוטבאדום');
  });

  it('strips niqqud (PB2): a vowelled name normalises to its plain spelling', () => {
    expect(normalizeString('קִסְבֶּלָגָה בְּשַׂר טָחוּן טָרִי')).toBe('קסבלגהבשרטחוןטרי');
  });

  it('keeps geresh / gershayim as before', () => {
    expect(normalizeString('בד״ץ')).toBe('בד״ץ');
  });
});
