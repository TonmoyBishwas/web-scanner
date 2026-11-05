import { describe, expect, it } from 'vitest';
import { cartonLabelsShown, cartonSaveKey, identicalTotalKey, lpnLabelsShown, perCartonDeleteShown } from './label-switches';
import { t } from './i18n/server';

describe('label switches read from the session features', () => {
  it('absent features: everything as today', () => {
    for (const f of [undefined, null, {}]) {
      expect(cartonLabelsShown(f)).toBe(true);
      expect(lpnLabelsShown(f)).toBe(true);
      expect(perCartonDeleteShown(f)).toBe(true);
    }
  });

  it('only an explicit false hides a label switch', () => {
    expect(cartonLabelsShown({ carton_labels: false })).toBe(false);
    expect(cartonLabelsShown({ carton_labels: true })).toBe(true);
    expect(lpnLabelsShown({ lpn_labels: false })).toBe(false);
    expect(lpnLabelsShown({ carton_labels: false })).toBe(true);
  });

  it('top_bar_delete_only on: no per-carton delete', () => {
    expect(perCartonDeleteShown({ top_bar_delete_only: true })).toBe(false);
    expect(perCartonDeleteShown({ top_bar_delete_only: false })).toBe(true);
  });
});

describe('cartonSaveKey: no new text', () => {
  it('labels on: the keys used today', () => {
    expect(cartonSaveKey(1, true, 'carton')).toEqual({ key: 'carton.saveOne' });
    expect(cartonSaveKey(4, true, 'carton')).toEqual({ key: 'carton.save', params: { count: 4 } });
    expect(cartonSaveKey(1, true, 'identical')).toEqual({ key: 'identical.saveOne' });
    expect(cartonSaveKey(4, true, 'identical')).toEqual({ key: 'identical.save', params: { count: 4 } });
  });

  it('labels off: the approved units wording, which names cartons', () => {
    expect(cartonSaveKey(1, false, 'carton')).toEqual({ key: 'carton.unitsSaveOne' });
    expect(cartonSaveKey(4, false, 'identical')).toEqual({ key: 'carton.unitsSave', params: { n: 4 } });
    const he = t('Hebrew', cartonSaveKey(4, false, 'carton').key, cartonSaveKey(4, false, 'carton').params);
    expect(he).toContain('4');
    expect(he).not.toContain('מדבק');
    expect(t('Hebrew', cartonSaveKey(1, false, 'identical').key)).not.toContain('מדבק');
  });
});

describe('identicalTotalKey', () => {
  it('labels on: as today', () => {
    expect(identicalTotalKey(false, true)).toBe('identical.willSave');
    expect(identicalTotalKey(true, true)).toBe('identical.willAdd');
  });
  it('labels off: the label-free line', () => {
    expect(identicalTotalKey(false, false)).toBe('identical.willAdd');
    expect(t('Hebrew', identicalTotalKey(false, false), { add: 3, listed: 1 })).not.toContain('מדבק');
  });
});
