/**
 * scripts/replay-name-check.ts on 48696 (bot items 2 + 8, 04/11): with the
 * bot's matching name ("כתף עגל" for the line read "ברווז", code
 * 7290008432894) the veal sticker finds its line; goulash and wings keep theirs.
 */
import { describe, expect, it } from 'vitest';
import { replaySession, type SessionExport } from '../scripts/replay-name-check-core';

const before = [
  { item_code: '7290008432894', item_name_hebrew: 'ברווז קפוא (מוסד)', item_name_english: 'Frozen Duck' },
  { item_code: '7290015760553', item_name_hebrew: 'בשר גולש (מוסד) קפוא', item_name_english: 'Frozen Goose Meat' },
  { item_code: '7290006289353', item_name_hebrew: 'כנפיים עוף וול דאן בדץ', item_name_english: 'Frozen Chicken Wings' },
];
const after = before.map((l) => (l.item_code === '7290008432894' ? { ...l, item_name_hebrew: 'כתף עגל' } : l));

const session: SessionExport = {
  token: 'zc0OjN6GaKPyvrfOJh7rx',
  ocr_before: before,
  ocr_after: after,
  stickers: [
    { he: 'כתף עגל (מוסדי)\nקפוא וויל דאן בדץ', en: 'Veal Shoulder (Institutional) Frozen Weil Dan Badatz' },
    { he: 'בשר גולש (מוסד) קפוא', en: 'Frozen Goose Meat (Institutional)' },
    { he: 'בשר גולש (מוסדי)\nקפוא וול דאן בדץ', en: 'Frozen Goose Meat' },
    { he: 'כנפיים עוף וול דאן בדץ', en: 'WELL DONE Chicken Wings' },
    { he: 'כנפיים עוף ול דאן בדץ', en: 'Frozen Chicken Wings' },
  ],
};

describe('name check replay (48696)', () => {
  it('veal sticker: no line before, the veal line after', () => {
    const [veal] = replaySession(session);
    expect(veal.before).toBeNull();
    expect(veal.after).toBe('7290008432894');
  });
  it('goulash and wings stickers keep their line', () => {
    for (const r of replaySession(session).slice(1)) {
      expect(r.after).toBe(r.before);
      expect(r.before).not.toBeNull();
    }
  });
});
