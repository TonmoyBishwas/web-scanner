import { describe, it, expect } from 'vitest';
import { deleteAllQuestion } from './delete-all-confirm';
import { t } from './i18n/server';

const ask = (action: Parameters<typeof deleteAllQuestion>[0], loose: boolean, count: number, lang = 'Hebrew') => {
  const q = deleteAllQuestion(action, loose, count);
  return t(lang, q.key, q.vars);
};

describe('deleteAllQuestion', () => {
  it("asks the client's own words for a pallet, with the count", () => {
    expect(ask('rows', false, 126)).toBe('למחוק את כל 126 הקרטונים במשטח?');
    expect(ask('rows', false, 126, 'English')).toBe('Delete all 126 cartons on the pallet?');
  });

  it('asks about the loose cartons on the loose list', () => {
    expect(ask('rows', true, 9)).toBe('למחוק את כל 9 הקרטונים הבודדים?');
    expect(ask('rows', true, 9, 'English')).toBe('Delete all 9 loose cartons?');
  });

  it('one carton reads as a sentence, never "all 1 cartons"', () => {
    expect(ask('rows', false, 1)).toBe('למחוק את הקרטון שבמשטח?');
    expect(ask('rows', true, 1)).toBe('למחוק את הקרטון הבודד?');
    expect(ask('unprinted', false, 1)).toBe('למחוק את המדבקה שלא הודפסה?');
    expect(ask('void_printed', false, 1)).toBe('לבטל את המדבקה שהודפסה?');
  });

  it('labels and voids name their own counts', () => {
    expect(ask('unprinted', false, 4)).toBe('למחוק את כל 4 המדבקות שלא הודפסו?');
    expect(ask('void_printed', false, 3, 'English')).toBe('Cancel 3 printed labels?');
  });

  it('deletes are red; voiding printed labels is amber', () => {
    expect(deleteAllQuestion('rows', false, 5).tone).toBe('danger');
    expect(deleteAllQuestion('unprinted', true, 5).tone).toBe('danger');
    expect(deleteAllQuestion('void_printed', false, 5).tone).toBe('warn');
    expect(t('Hebrew', deleteAllQuestion('rows', false, 5).confirmKey)).toBe('כן, מחק');
  });
});
