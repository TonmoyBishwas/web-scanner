import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { CartonCreator } from '@/components/terminal/CartonCreator';
import { LanguageContext } from './i18n';

/**
 * copy_note_weight_check on New carton (19/11): with the switch off the
 * screen renders byte for byte as origin/preview 74ca578 (before the note
 * question reached New carton), for a blank open and for a preset one, in
 * both languages. The markup is saved in test/fixtures/carton_creator_74ca578.json.
 * A screen handed `noteCartonKgOf` (switch on) opens on the same markup: the
 * question shows only after a Save it holds (lib/carton-creator-note.test.ts).
 *
 * Regenerate (only if New carton is meant to change with the switch off):
 * copy this file into a checkout of the older commit and run it with
 * CARTON_CREATOR_BASELINE_OUT=<dir>; it writes the file instead of comparing.
 */

const FIXTURE = path.resolve(__dirname, '../test/fixtures/carton_creator_74ca578.json');
const OUT = process.env.CARTON_CREATOR_BASELINE_OUT;
const noop = () => {};

// Glatt note 261066779, item 5086 meatballs: 28 cartons, 10.13 kg a carton.
const MEATBALLS = { item_code: '5086', item_name_hebrew: 'כדורי בשר', item_name_english: 'Meatballs', unit: 'kg' as const, quantity_kg: 283.64, box_count: 28 };
const ITEMS = [MEATBALLS, { item_code: '5090', item_name_hebrew: 'קבב', item_name_english: 'Kebab', unit: 'kg' as const, quantity_kg: 120, box_count: 12 }];

type Props = ComponentProps<typeof CartonCreator>;
const CASES: Array<{ name: string; lang: 'English' | 'Hebrew'; props: Props }> = [
  { name: 'blank-en', lang: 'English', props: { token: 'tok', items: ITEMS, palletNumber: 1, countOnSave: true, onBack: noop, onCreated: noop } },
  { name: 'blank-he-nolabels', lang: 'Hebrew', props: { token: 'tok', items: ITEMS, palletNumber: 0, countOnSave: true, cartonLabels: false, onBack: noop, onCreated: noop } },
  {
    name: 'preset-he', lang: 'Hebrew',
    props: { token: 'tok', items: ITEMS, palletNumber: 2, countOnSave: true, cartonLabels: false, preset: { item: MEATBALLS, weight: 28, quantity: 28, notice: 'n', lineTotal: 28 }, onBack: noop, onCreated: noop },
  },
  {
    name: 'preset-en-scan', lang: 'English',
    props: { token: 'tok', items: ITEMS, palletNumber: null, preset: { item: MEATBALLS, weight: 10.13, quantity: 3 }, onBack: noop, onCreated: noop },
  },
];

const render = (lang: 'English' | 'Hebrew', props: Props) =>
  renderToStaticMarkup(createElement(LanguageContext.Provider, { value: lang }, createElement(CartonCreator, props)));

describe('CartonCreator with copy_note_weight_check off', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T09:35:03Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('renders byte for byte as origin/preview 74ca578', () => {
    const html = Object.fromEntries(CASES.map((c) => [c.name, render(c.lang, c.props)]));
    if (OUT) {
      writeFileSync(path.join(OUT, path.basename(FIXTURE)), JSON.stringify(html, null, 1));
      return;
    }
    const saved = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    expect(Object.keys(saved)).toEqual(CASES.map((c) => c.name));
    for (const c of CASES) {
      expect(html[c.name].length).toBeGreaterThan(500);
      expect(html[c.name]).toBe(saved[c.name]);
    }
  });

  it('a screen handed the note weight (switch on) opens on the same markup', () => {
    if (OUT) return;
    const saved = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    for (const c of CASES) {
      const on = { ...c.props, noteCartonKgOf: () => 10.13 } as Props;
      expect(render(c.lang, on)).toBe(saved[c.name]);
    }
  });
});
