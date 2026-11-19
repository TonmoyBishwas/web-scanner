import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * copy_note_weight_check on New carton (19/11, Glatt 261066779): the screen
 * itself, driven tap by tap. The repo renders components only to static
 * HTML (no DOM), so this file runs CartonCreator as a plain function under
 * a small hook runtime: `react`'s hooks are swapped for slot-based ones, the
 * element tree it returns is searched for the real buttons and inputs, and
 * their own onClick / onChange handlers are called. Child components are not
 * rendered (their props, children included, are searched as they are).
 *
 * Real case: item 5086 meatballs, note 10.13 kg a carton; David saved New
 * carton with 28 cartons at 28 kg each at 11:35:03 — 784 kg for ~284.
 */

const H = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  mounted: false,
  effects: [] as Array<() => unknown>,
  lang: 'English' as 'English' | 'Hebrew',
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const slot = <T,>(init: () => T): number => {
    const i = H.i++;
    if (!(i in H.slots)) H.slots[i] = init();
    return i;
  };
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => {
      const i = slot(() => (typeof init === 'function' ? (init as () => T)() : init));
      const set = (next: T | ((p: T) => T)) => {
        H.slots[i] = typeof next === 'function' ? (next as (p: T) => T)(H.slots[i] as T) : next;
      };
      return [H.slots[i] as T, set];
    },
    useRef: <T,>(init: T) => H.slots[slot(() => ({ current: init }))],
    useMemo: <T,>(fn: () => T) => fn(),
    useCallback: <T,>(fn: T) => fn,
    useEffect: (fn: () => unknown) => {
      if (!H.mounted) H.effects.push(fn);
    },
    useContext: () => H.lang,
  };
});

const traced = vi.hoisted(() => [] as Array<{ event: string; data: Record<string, unknown> }>);
vi.mock('@/lib/scanner-trace', () => ({
  trace: (_cat: string, event: string, data: Record<string, unknown> = {}) => { traced.push({ event, data }); },
}));

import { CartonCreator } from '@/components/terminal/CartonCreator';
import { CopyNoteAsk } from '@/components/terminal/CopyNoteAsk';
import { t } from './i18n';
import { copyNoteText, creatorNoteCartonKg } from './copy-note-weight';
import { asNewCartonRows, expandIdenticalBoxes, newCartonBatch } from './identical-boxes';
import { weightSourceOf } from './weight-source';
import { localIsoDate } from './edit-panel-state';
import type { CartonLabel } from '@/types';

type Props = ComponentProps<typeof CartonCreator>;

// Glatt note 261066779, item 5086 meatballs: 28 cartons, 283.64 kg = 10.13 a carton.
const MEATBALLS = { item_code: '5086', item_name_hebrew: 'כדורי בשר', item_name_english: 'Meatballs', unit: 'kg' as const, quantity_kg: 283.64, box_count: 28 };
const SOUP = { item_code: '7001', item_name_hebrew: 'מרק', item_name_english: 'Soup', unit: 'units' as const, quantity_kg: 40, box_count: 4 };
const ITEMS = [MEATBALLS, SOUP];

let fetchBodies: Array<Record<string, unknown>>;
let fetchStatus: Array<{ status: number; body: unknown }>;
let created: unknown[][];

function label(n: number, body: Record<string, unknown>) {
  return {
    id: `l${n}`, batch_id: String(body.batch_id), barcode: `28261119${String(n).padStart(8, '0')}`, serial: `C-${n}`,
    item_code: body.item_code, item_name_hebrew: body.item_name_hebrew, item_name_english: body.item_name_english,
    weight_kg: body.weight_kg, quantity: 1, production_date: body.production_date, expiry_date: body.expiry_date, origin: 'new_carton',
  };
}

beforeEach(() => {
  H.slots = []; H.i = 0; H.mounted = false; H.effects = []; H.lang = 'English';
  traced.length = 0;
  fetchBodies = [];
  fetchStatus = [];
  created = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    fetchBodies.push(body);
    const next = fetchStatus.shift();
    if (next) return { status: next.status, json: async () => next.body };
    const n = Number(body.quantity);
    return { status: 200, json: async () => ({ success: true, batch_id: body.batch_id, labels: Array.from({ length: n }, (_, i) => label(i + 1, body)) }) };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A save not awaited by its handler (an answer's `void save()`) has finished. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** One screen: render, find, tap, type. */
function screen(props: Partial<Props> = {}) {
  const all: Props = {
    token: 'tok', items: ITEMS, palletNumber: 1, countOnSave: true,
    onBack: () => {}, onCreated: (...a: unknown[]) => { created.push(a); },
    ...props,
  } as Props;
  const render = (): ReactElement => {
    H.i = 0;
    const el = CartonCreator(all) as ReactElement;
    if (!H.mounted) {
      H.mounted = true;
      for (const fn of H.effects.splice(0)) fn();
    }
    return el;
  };
  const walk = (node: ReactNode, out: ReactElement[] = []): ReactElement[] => {
    if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
    if (!isValidElement(node)) return out;
    // The shared question has no hooks: rendered in place, so its buttons are found.
    if (node.type === CopyNoteAsk) return walk(CopyNoteAsk(node.props as ComponentProps<typeof CopyNoteAsk>), out);
    out.push(node);
    const p = node.props as { children?: ReactNode };
    walk(p.children, out);
    return out;
  };
  const textOf = (node: ReactNode): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (isValidElement(node)) {
      const el = node as ReactElement<{ children?: ReactNode; name?: string }>;
      // An icon (MI) is a name, not text.
      if (typeof el.type !== 'string' && el.props.name && !el.props.children) return '';
      if (el.type === CopyNoteAsk) return textOf(CopyNoteAsk(el.props as unknown as ComponentProps<typeof CopyNoteAsk>));
      return textOf(el.props.children);
    }
    return '';
  };
  const els = () => walk(render());
  const buttons = () => els().filter((e) => e.type === 'button') as Array<ReactElement<{ onClick?: () => unknown; children?: ReactNode }>>;
  const button = (text: string) => {
    const b = buttons().find((x) => textOf(x.props.children).includes(text));
    if (!b) throw new Error(`no button "${text}" in: ${buttons().map((x) => textOf(x.props.children)).join(' | ')}`);
    return b;
  };
  const input = (mode: 'numeric' | 'decimal') => {
    const i = els().find((e) => e.type === 'input' && (e.props as { inputMode?: string }).inputMode === mode);
    if (!i) throw new Error(`no ${mode} input`);
    return i as ReactElement<{ value: string; onChange: (e: { target: { value: string } }) => void }>;
  };
  const hasIcon = (node: ReactNode, name: string): boolean => walk(node).some((e) => (e.props as { name?: string }).name === name);
  return {
    /** Tap a date field (0 = production, 1 = expiry): its calendar opens. */
    openDate: (i: 0 | 1) => {
      const dates = buttons().filter((b) => hasIcon(b.props.children, 'event'));
      dates[i].props.onClick?.();
    },
    /** OK on the open calendar with this day. */
    pickDate: (iso: string) => {
      const cal = els().find((e) => typeof (e.props as { onPick?: unknown }).onPick === 'function');
      if (!cal) throw new Error('no calendar open');
      (cal.props as { onPick: (iso: string) => void }).onPick(iso);
    },
    /** An icon-only button, by its aria-label. */
    tapLabel: async (aria: string) => {
      const b = buttons().find((x) => (x.props as { 'aria-label'?: string })['aria-label'] === aria);
      if (!b) throw new Error(`no button labelled "${aria}"`);
      await b.props.onClick?.();
      await settle();
    },
    text: () => textOf(render()),
    has: (text: string) => buttons().some((x) => textOf(x.props.children).includes(text)),
    tap: async (text: string) => { await button(text).props.onClick?.(); await settle(); },
    pick: async (name: string) => { await button(name).props.onClick?.(); await settle(); },
    type: (mode: 'numeric' | 'decimal', value: string) => input(mode).props.onChange({ target: { value } }),
    value: (mode: 'numeric' | 'decimal') => input(mode).props.value,
  };
}

const save = (n: number) => t('English', n === 1 ? 'carton.saveOne' : 'carton.save', { count: n });
const events = (name: string) => traced.filter((e) => e.event === name).map((e) => e.data);

describe('New carton, switch off (no noteCartonKgOf): exactly as before', () => {
  it('28 cartons at 28 kg save at once, one POST with the typed weight, no question', async () => {
    const s = screen();
    await s.pick('כדורי בשר');
    s.type('numeric', '28');
    s.type('decimal', '28');
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(1);
    const { batch_id, ...body } = fetchBodies[0];
    expect(typeof batch_id).toBe('string');
    expect(body).toEqual({
      token: 'tok', pallet_number: 1, item_code: '5086', item_name_hebrew: 'כדורי בשר', item_name_english: 'Meatballs',
      weight_kg: 28, quantity: 28, production_date: null, expiry_date: null, notes: null, print_barcode: true,
    });
    expect(created).toHaveLength(1);
    // onCreated(count, batchId, labels): three arguments, as before.
    expect(created[0]).toHaveLength(3);
    expect(created[0][0]).toBe(28);
    expect(created[0][1]).toBe(batch_id);
    expect(events('copy_note_weight_ask')).toEqual([]);
    expect(traced.map((e) => e.event)).toEqual(['carton_item_pick', 'carton_save_tap']);
  });

  it('an empty weight saves weight_kg null (label-only screen)', async () => {
    const s = screen({ countOnSave: false, palletNumber: null });
    await s.pick('כדורי בשר');
    s.type('numeric', '3');
    await s.tap(save(3));
    expect(fetchBodies[0].weight_kg).toBeNull();
    expect(created[0]).toHaveLength(3);
  });
});

// ─── switch on ───

const ON = { noteCartonKgOf: (item: Parameters<NonNullable<Props['noteCartonKgOf']>>[0]) => creatorNoteCartonKg(ITEMS, item) };
const ask = (w: number) => copyNoteText('English', 'ask', { note: 10.13, w });
const btn = (key: 'note' | 'keep' | 'type', w: number) => copyNoteText('English', key, { note: 10.13, w });

/** The rows the page books from a save (onCreated → newCartonBatch → the identical expansion). */
function bookedRows(call: unknown[]) {
  const [, , labels, noteChoice] = call as [number, string, CartonLabel[], 'note' | 'keep' | 'type' | undefined];
  const batch = newCartonBatch(labels, noteChoice)!;
  return asNewCartonRows(expandIdenticalBoxes(batch.sample, batch.refs, batch.form));
}

async function meatballs28(weight: string, props: Partial<Props> = ON) {
  const s = screen(props);
  await s.pick('כדורי בשר');
  s.type('numeric', '28');
  s.type('decimal', weight);
  await s.tap(save(28));
  return s;
}

describe('New carton, switch on — Glatt 261066779, 5086 meatballs, 10.13 kg a carton', () => {
  it('28 cartons at 28 kg: Save is held for the note question, nothing saved yet', async () => {
    const s = await meatballs28('28');
    expect(fetchBodies).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(s.text()).toContain(ask(28));
    expect(s.has(btn('note', 28))).toBe(true);
    expect(s.has(btn('keep', 28))).toBe(true);
    expect(s.has(btn('type', 28))).toBe(true);
    // The Save button gives way to the question.
    expect(s.has(save(28))).toBe(false);
    expect(events('copy_note_weight_ask')).toEqual([{
      origin: 'new_carton', item_code: '5086', weight: 28, note_kg: 10.13, copies: 28, rel: 1.764, kg_impact: 500.36,
    }]);
  });

  it('"book the note\'s weight" books all 28 at 10.13 kg as the note\'s weight (note_avg), ~284 kg', async () => {
    const s = await meatballs28('28');
    await s.tap(btn('note', 28));
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ weight_kg: 10.13, quantity: 28, item_code: '5086' });
    expect(created).toHaveLength(1);
    expect(created[0][3]).toBe('note');
    const rows = bookedRows(created[0]);
    expect(rows).toHaveLength(28);
    expect(rows.every((r) => r.weight === 10.13 && r.weight_from_note === true && r.new_carton)).toBe(true);
    expect(new Set(rows.map((r) => weightSourceOf(r)))).toEqual(new Set(['note_avg']));
    expect(Math.round(rows.reduce((kg, r) => kg + r.weight, 0) * 100) / 100).toBe(283.64);
    // The batch form carries the answer, as the copy form's does.
    expect(newCartonBatch(created[0][2] as CartonLabel[], 'note')!.form).toMatchObject({ note_choice: 'note', weight_from_note: true, weight_confirmed: true });
    expect(events('copy_note_weight_choice')).toEqual([{
      origin: 'new_carton', item_code: '5086', choice: 'note', weight: 28, note_kg: 10.13, copies: 28, kg_impact: 500.36,
    }]);
    expect(s.value('decimal')).toBe('10.13');
  });

  it('"keep" books as typed: 28 × 28 kg, weight_source typed', async () => {
    const s = await meatballs28('28');
    await s.tap(btn('keep', 28));
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ weight_kg: 28, quantity: 28 });
    expect(created[0][3]).toBe('keep');
    const rows = bookedRows(created[0]);
    expect(rows.every((r) => r.weight === 28 && r.weight_from_note === undefined)).toBe(true);
    expect(new Set(rows.map((r) => weightSourceOf(r)))).toEqual(new Set(['typed']));
    expect(newCartonBatch(created[0][2] as CartonLabel[], 'keep')!.form).toMatchObject({ note_choice: 'keep' });
    expect(newCartonBatch(created[0][2] as CartonLabel[], 'keep')!.form.weight_from_note).toBeUndefined();
  });

  it('"type another" empties the weight; a weight still off asks again, one within the note saves', async () => {
    const s = await meatballs28('28');
    await s.tap(btn('type', 28));
    expect(fetchBodies).toHaveLength(0);
    expect(s.value('decimal')).toBe('');
    expect(s.has(save(28))).toBe(true);
    s.type('decimal', '2.8');
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(0);
    expect(s.text()).toContain(ask(2.8));
    expect(events('copy_note_weight_ask').map((e) => e.weight)).toEqual([28, 2.8]);
    // Typing again takes the question away; 10.1 is within 3% of 10.13.
    s.type('decimal', '10.1');
    expect(s.has(save(28))).toBe(true);
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ weight_kg: 10.1, quantity: 28 });
    expect(created[0][3]).toBe('type');
    expect(new Set(bookedRows(created[0]).map((r) => weightSourceOf(r)))).toEqual(new Set(['typed']));
  });

  it('a failed save after "book the note\'s weight" retries at the note\'s weight without asking again', async () => {
    fetchStatus.push({ status: 500, body: { success: false } });
    const s = await meatballs28('28');
    await s.tap(btn('note', 28));
    expect(fetchBodies).toHaveLength(1);
    expect(created).toHaveLength(0);
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(2);
    expect(fetchBodies[1]).toMatchObject({ weight_kg: 10.13, quantity: 28 });
    // Same content, same batch: the retry never mints a second set.
    expect(fetchBodies[1].batch_id).toBe(fetchBodies[0].batch_id);
    expect(created[0][3]).toBe('note');
    expect(events('copy_note_weight_ask')).toHaveLength(1);
  });

  it('another count takes the question away (it was asked for 28 cartons)', async () => {
    const s = await meatballs28('28');
    s.type('numeric', '1');
    expect(s.has(save(1))).toBe(true);
    await s.tap(save(1));
    // One carton weighs its own: never asked.
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ weight_kg: 28, quantity: 1 });
    expect(created[0]).toHaveLength(3);
  });

  it('28 cartons at 10.1 kg save at once (within 3%): no question, onCreated as before', async () => {
    await meatballs28('10.1');
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ weight_kg: 10.1, quantity: 28 });
    expect(created[0]).toHaveLength(3);
    expect(events('copy_note_weight_ask')).toEqual([]);
  });

  it('one carton at 28 kg is never asked', async () => {
    const s = screen(ON);
    await s.pick('כדורי בשר');
    s.type('decimal', '28');
    await s.tap(save(1));
    expect(fetchBodies).toHaveLength(1);
    expect(events('copy_note_weight_ask')).toEqual([]);
  });

  it('a units line is never asked', async () => {
    const s = screen(ON);
    await s.pick('מרק');
    s.type('numeric', '4');
    s.type('decimal', '40');
    await s.tap(save(4));
    expect(fetchBodies).toHaveLength(1);
    expect(events('copy_note_weight_ask')).toEqual([]);
  });

  it('asks in Hebrew in the copy form\'s words', async () => {
    H.lang = 'Hebrew';
    const s = screen(ON);
    await s.pick('כדורי בשר');
    s.type('numeric', '28');
    s.type('decimal', '28');
    await s.tap(t('Hebrew', 'carton.save', { count: 28 }));
    expect(s.text()).toContain('לפי התעודה 10.13 ק"ג לקרטון, כאן 28 ק"ג. איזה משקל לרשום?');
    expect(s.has('לרשום 10.13 ק"ג (לפי התעודה)')).toBe(true);
    expect(s.has('להשאיר 28 ק"ג')).toBe(true);
    expect(s.has('להקליד משקל')).toBe(true);
  });
});

// Review 19/11: an answer saves without Save's tap, so Save's date guards must
// still hold — a date changed (or today moved) under the question never
// books 28 cartons on an expiry Save refuses.
const dayFromToday = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localIsoDate(d); };

describe('New carton, switch on — the question never gets past Save\'s date checks', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('an expiry on/before today picked under the question takes it away; Save then refuses the date', async () => {
    const s = await meatballs28('28');
    expect(s.text()).toContain(ask(28));
    s.openDate(1);
    s.pickDate(dayFromToday(-1));
    expect(s.text()).not.toContain(ask(28));
    expect(s.has(btn('note', 28))).toBe(false);
    expect(s.text()).toContain(t('English', 'dates.expiryNotFuture'));
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(events('carton_save_tap').at(-1)?.blocked).toBe('date');
  });

  it('a valid expiry picked under the question takes it away too; Save asks again, then saves on the answer', async () => {
    const s = await meatballs28('28');
    s.openDate(1);
    s.pickDate(dayFromToday(30));
    expect(s.has(btn('note', 28))).toBe(false);
    await s.tap(save(28));
    expect(events('copy_note_weight_ask')).toHaveLength(2);
    await s.tap(btn('note', 28));
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ weight_kg: 10.13, quantity: 28, expiry_date: dayFromToday(30) });
  });

  it('a preset carton whose required expiry is cleared under the question: no save, Save refuses it', async () => {
    const s = screen({ ...ON, preset: { item: MEATBALLS, quantity: 28, weight: 28 } });
    s.openDate(1);
    s.pickDate(dayFromToday(30));
    await s.tap(save(28));
    expect(s.text()).toContain(ask(28));
    await s.tapLabel(t('English', 'terminal.clearExpiry'));
    expect(s.has(btn('keep', 28))).toBe(false);
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(0);
    expect(events('carton_save_tap').at(-1)?.blocked).toBe('expiry');
  });

  it('today moves past the expiry while the question shows: the answer saves nothing, Save refuses the date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 19, 23, 50));
    const s = screen(ON);
    await s.pick('כדורי בשר');
    s.type('numeric', '28');
    s.type('decimal', '28');
    s.openDate(1);
    s.pickDate('2026-11-20');
    await s.tap(save(28));
    expect(s.text()).toContain(ask(28));
    vi.setSystemTime(new Date(2026, 10, 20, 0, 10));
    await s.tap(btn('note', 28));
    expect(fetchBodies).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(events('copy_note_weight_choice').at(-1)).toMatchObject({ choice: 'note', blocked: 'date' });
    expect(s.has(save(28))).toBe(true);
    await s.tap(save(28));
    expect(fetchBodies).toHaveLength(0);
    expect(events('carton_save_tap').at(-1)?.blocked).toBe('date');
  });
});
