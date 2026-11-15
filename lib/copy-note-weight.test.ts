import { describe, it, expect } from 'vitest';
import {
  COPY_NOTE_WEIGHT_TEXT, copyNoteAnswerFor, copyNoteSaveStep, copyNoteText, copyNoteWeightGap, noteCartonKgForCode, notePerCartonKg,
} from './copy-note-weight';
import { cartonOwnCodes, matchInvoiceItem } from './invoice-match';
import {
  applyNoteChoiceToSource, expandIdenticalBoxes, sourceTakesFormWeight, sourceTakesNoteChoice, type IdenticalForm,
} from './identical-boxes';
import { replaceIdenticalSample } from './weight-check';
import { weightSourceOf } from './weight-source';
import type { MultiPalletBoxScan } from '@/types';

/**
 * copy_note_weight_check (15/11). Baladi IN264207398 (delivery 3e749206,
 * Priority draft GR26000207): turkey patties 90300662, note 900 kg / 90
 * cartons, every carton the internal code 2000090300662 (no weight).
 * Pallet 1: label OCR 10.5 kg, "Different carton?" total 60 → 59 copies at
 * 10.5. Pallet 2: label OCR 16 kg (the protein figure), total 30 → 29
 * copies at 16. 1110 kg booked for 900.
 */
type Row = MultiPalletBoxScan & {
  ocr_status?: string; weight_checked?: boolean; weight_typed?: boolean;
  weight_suspect?: { typical?: number; reason: 'name_number' | 'ratio'; name?: string };
};

const LINE = { item_code: '90300662', quantity_kg: 900, box_count: 90, unit_weight_kg: 0 };
const NAME = 'קציצות הודו 20 גרם - מילגם - בד"ץ עדה חרדית';
const SRC = '2000090300662';
const source = (weight: number): Row => ({
  barcode: SRC, sku: SRC, item_name: 'Turkey patties 20g - Milgam - Eda Charedit', item_name_hebrew: NAME,
  weight, ocr_weight: weight, expiry: '2027-05-01', production_date: '2026-11-01',
  scanned_at: '2026-11-15T09:20:00Z', ocr_status: 'done',
});
const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ barcode: `2826111500${String(i).padStart(6, '0')}`, batch_id: 'b15' }));
const total = (rows: ReadonlyArray<{ weight: number }>) => Math.round(rows.reduce((a, b) => a + b.weight, 0) * 1000) / 1000;
const form = (weight: number, extra: Partial<IdenticalForm> = {}): IdenticalForm => ({
  weight, expiry: '2027-05-01', production_date: '2026-11-01', weight_confirmed: true, ...extra,
});

/** The page's "Different carton?" save: copies at the form weight, the source reweighed by the note answer. */
function differentCarton(src: Row, copies: number, f: IdenticalForm): Row[] {
  // As the page: a "Different carton?" copy is a twin (handleIdenticalCreated).
  const rows = expandIdenticalBoxes(src, labels(copies), f).map((r) => ({ ...r, twin: true }));
  return replaceIdenticalSample<Row>([src], {
    sourceBarcode: SRC, anotherOf: true, rows, form: f, saved: copies,
    reweighSource: false, reweighByNote: sourceTakesNoteChoice(src, f), opts: {},
  });
}

describe('notePerCartonKg', () => {
  it("the note's kg over its cartons, to the gram", () => {
    expect(notePerCartonKg(LINE)).toBe(10);
    expect(notePerCartonKg({ quantity_kg: 909.24, box_count: 73 })).toBe(12.455);
  });

  it('null for a units line, or a line missing either figure', () => {
    expect(notePerCartonKg({ ...LINE, unit: 'units' })).toBeNull();
    expect(notePerCartonKg({ ...LINE, box_count: 0 })).toBeNull();
    expect(notePerCartonKg({ ...LINE, box_count: undefined })).toBeNull();
    expect(notePerCartonKg({ ...LINE, quantity_kg: 0 })).toBeNull();
    expect(notePerCartonKg(undefined)).toBeNull();
    expect(notePerCartonKg({ ...LINE, unit: 'kg' })).toBe(10);
  });
});

describe('copyNoteWeightGap — IN264207398', () => {
  it('pallet 1: 59 copies at 10.5 kg against 10 kg a carton → held (5%, 29.5 kg)', () => {
    const gap = copyNoteWeightGap({ weight: 10.5, copies: 59, noteKg: 10 });
    expect(gap).not.toBeNull();
    expect(gap!.rel).toBeCloseTo(0.05, 6);
    expect(gap!.kgImpact).toBe(29.5);
  });

  it('pallet 2: 29 copies at 16 kg → held (60%, 174 kg)', () => {
    const gap = copyNoteWeightGap({ weight: 16, copies: 29, noteKg: 10 });
    expect(gap!.rel).toBeCloseTo(0.6, 6);
    expect(gap!.kgImpact).toBe(174);
  });

  it('the earlier wrong copies the data found are held too', () => {
    // IN264193474: 76 turkey schnitzel copies at 18.8 for 10 kg cartons (booked 1447.6 for 770).
    expect(copyNoteWeightGap({ weight: 18.8, copies: 76, noteKg: 10 })).not.toBeNull();
    // IN264184055: 99 minced turkey copies at 6 for 12 kg cartons (booked 600 for 1200).
    expect(copyNoteWeightGap({ weight: 6, copies: 99, noteKg: 12 })).not.toBeNull();
  });
});

describe('copyNoteWeightGap — saves that go through as before', () => {
  it('a fixed-weight copy at the note weight (peas 79 x 10, kebab 19 x 8)', () => {
    expect(copyNoteWeightGap({ weight: 10, copies: 79, noteKg: 10 })).toBeNull();
    expect(copyNoteWeightGap({ weight: 8, copies: 19, noteKg: 8 })).toBeNull();
  });

  it('a legitimate variable-weight copy near the note average: chicken thighs 12.54 vs 12.283 (2.1%)', () => {
    expect(copyNoteWeightGap({ weight: 12.54, copies: 20, noteKg: 12.283 })).toBeNull();
    // Chicken drumsticks 15.18 vs 14.761 (2.8%) — the widest real carton seen on a one-tap twin.
    expect(copyNoteWeightGap({ weight: 15.18, copies: 10, noteKg: 14.761 })).toBeNull();
  });

  it('a few cartons a little over 3% off: under 2 kg in all is not asked', () => {
    // 2 x 13.0 kg against 12.455 (4.4%) = 1.09 kg.
    expect(copyNoteWeightGap({ weight: 13, copies: 2, noteKg: 12.455 })).toBeNull();
    // 3% exactly (10.3 vs 10) is within: float noise is not a gap.
    expect(copyNoteWeightGap({ weight: 10.3, copies: 50, noteKg: 10 })).toBeNull();
    expect(copyNoteWeightGap({ weight: 10.31, copies: 50, noteKg: 10 })).not.toBeNull();
  });

  it('one copy is one carton weighing its own; no note weight is no question', () => {
    expect(copyNoteWeightGap({ weight: 16, copies: 1, noteKg: 10 })).toBeNull();
    expect(copyNoteWeightGap({ weight: 16, copies: 29, noteKg: null })).toBeNull();
    expect(copyNoteWeightGap({ weight: 16, copies: 29, noteKg: undefined })).toBeNull();
    expect(copyNoteWeightGap({ weight: 0, copies: 29, noteKg: 10 })).toBeNull();
  });
});

describe('the thresholds against the 30 identical batches of 2+ cartons since 22/09', () => {
  // Every batch with a kg line: |copied − note per carton| / note, and copies.
  // 25 at 0.0%; the 5 off ones are the wrong bookings named in lib/copy-note-weight.ts.
  const off = [
    { weight: 15, copies: 6, noteKg: 10 }, // IN264172698 salmon cartons on the tilapia line
    { weight: 6, copies: 99, noteKg: 12 }, // IN264184055
    { weight: 18.8, copies: 76, noteKg: 10 }, // IN264193474
    { weight: 10.5, copies: 59, noteKg: 10 }, // IN264207398 pallet 1
    { weight: 16, copies: 29, noteKg: 10 }, // IN264207398 pallet 2
  ];
  it('3% and 2 kg hold all five, and no batch at the note weight', () => {
    expect(off.every((b) => copyNoteWeightGap(b))).toBe(true);
    expect(copyNoteWeightGap({ weight: 12.5, copies: 12, noteKg: 12.5 })).toBeNull();
  });
});

describe('the source carton takes the answered weight', () => {
  it('pallet 1, "book the note": 60 cartons at 10 kg = 600 kg, every one note_avg', () => {
    const src = source(10.5);
    expect(weightSourceOf(src)).toBe('label_ocr');
    // identical_source_weight alone does nothing here: the form weight is the source's.
    expect(sourceTakesFormWeight(src, form(10.5), 59)).toBe(false);
    const list = differentCarton(src, 59, form(10, { note_choice: 'note', weight_from_note: true }));
    expect(list).toHaveLength(60);
    expect(total(list)).toBe(600);
    expect(list.every((r) => weightSourceOf(r) === 'note_avg')).toBe(true);
    expect(list.some((r) => r.weight_suspect)).toBe(false);
  });

  it('pallet 2, "type": 11 typed for 29 copies — the source takes 11, typed', () => {
    const src = source(16);
    const list = differentCarton(src, 29, form(11, { note_choice: 'type' }));
    expect(total(list)).toBe(330);
    expect(weightSourceOf(list[0])).toBe('typed');
    expect(list.slice(1).every((r) => weightSourceOf(r) === 'typed')).toBe(true);
  });

  it('"keep": the source and the copies keep 10.5, the copies stay identical copies', () => {
    const src = source(10.5);
    const f = form(10.5, { note_choice: 'keep' });
    expect(sourceTakesNoteChoice(src, f)).toBe(false);
    const list = differentCarton(src, 59, f);
    expect(total(list)).toBe(630);
    expect(list[0]).toBe(src);
    // twin_copy, as box_inventory holds for these 59 today.
    expect(list.slice(1).every((r) => weightSourceOf(r) === 'twin_copy')).toBe(true);
  });

  it('no answer (switch off, or no gap): exactly as before', () => {
    const src = source(10.5);
    expect(sourceTakesNoteChoice(src, form(10))).toBe(false);
    expect(applyNoteChoiceToSource([src], SRC, form(10))[0]).toBe(src);
  });

  it('a reading he saved in the edit panel takes his later answer too', () => {
    const src = { ...source(10.5), weight_checked: true };
    expect(sourceTakesNoteChoice(src, form(10, { note_choice: 'note', weight_from_note: true }))).toBe(true);
  });

  it("never a carton whose own barcode gives the weight", () => {
    // A 31-digit label: 10.15 kg in chars 14–18.
    const coded: Row = { ...source(10.15), barcode: '7290002195832010150130622102027' };
    expect(weightSourceOf(coded)).toBe('label_barcode');
    expect(sourceTakesNoteChoice(coded, form(10, { note_choice: 'note', weight_from_note: true }))).toBe(false);
  });

  it('an edit that changes a note-weight carton makes it typed', () => {
    const [copy] = expandIdenticalBoxes(source(10.5), labels(1), form(10, { note_choice: 'note', weight_from_note: true }));
    expect(weightSourceOf(copy)).toBe('note_avg');
    expect(weightSourceOf({ ...copy, weight: 9.8, weight_typed: true })).toBe('typed');
  });

  it("a copy of a note-weight carton at a weight of its own is not note_avg", () => {
    const [noted] = expandIdenticalBoxes(source(10.5), labels(1), form(10, { note_choice: 'note', weight_from_note: true }));
    const [again] = expandIdenticalBoxes(noted, labels(1), form(10.2));
    expect(again.weight_from_note).toBeUndefined();
    expect(weightSourceOf(again)).toBe('typed');
  });
});

describe('the PROPOSED texts', () => {
  it('Hebrew and English carry the same keys', () => {
    expect(Object.keys(COPY_NOTE_WEIGHT_TEXT.Hebrew).sort()).toEqual(Object.keys(COPY_NOTE_WEIGHT_TEXT.English).sort());
  });

  it('fill in the note and the read weight', () => {
    expect(copyNoteText('English', 'ask', { note: 10, w: 10.5 }))
      .toBe('The note says 10 kg a carton, this says 10.5 kg. Which weight to book?');
    expect(copyNoteText('Hebrew', 'note', { note: 12.455, w: 13 })).toBe('לרשום 12.455 ק"ג (לפי התעודה)');
    expect(copyNoteText('Hebrew', 'keep', { note: 10, w: 16 })).toBe('להשאיר 16 ק"ג');
  });
});

describe('review 15/11', () => {
  // The session's own lines (scan_sessions BZMt00q0IXGUZOS5rsspY).
  const SESSION_LINES = [
    { item_code: '7290003670444', item_name_english: '', item_name_hebrew: "שווקיים עוף בינוני קפוא תפז' ע", quantity_kg: 1239.93, box_count: 84, unit_weight_kg: 0 },
    { item_code: '90300662', item_name_english: '', item_name_hebrew: NAME, quantity_kg: 900, box_count: 90, unit_weight_kg: 0 },
  ];

  it('IN264207398 replay: the carton finds its line as the page does, the note says 10 kg, both saves are held', () => {
    for (const [weight, typed] of [[10.5, 60], [16, 30]] as const) {
      const src = source(weight);
      const line = matchInvoiceItem(src.item_name_hebrew, src.item_name, SESSION_LINES, cartonOwnCodes(src));
      expect(line?.item_code).toBe('90300662');
      const noteKg = noteCartonKgForCode(SESSION_LINES, line!.item_code);
      expect(noteKg).toBe(10);
      const step = copyNoteSaveStep({ weight, copies: typed - 1, noteKg, answer: null });
      expect('ask' in step && step.ask.copies).toBe(typed - 1);
    }
  });

  it('a code on two lines: their common weight, none when they disagree', () => {
    // HkhrfV6AchNhMQVi23k-P: 90300680 on two lines, 600/60 and 100/10.
    expect(noteCartonKgForCode([{ ...LINE, item_code: 'X', quantity_kg: 600, box_count: 60 }, { ...LINE, item_code: 'X', quantity_kg: 100, box_count: 10 }], 'X')).toBe(10);
    // The first line used to win: 20 kg cartons of the second line were held against 10.
    expect(noteCartonKgForCode([{ ...LINE, item_code: 'X', quantity_kg: 600, box_count: 60 }, { ...LINE, item_code: 'X', quantity_kg: 100, box_count: 5 }], 'X')).toBeNull();
    // A line without figures says nothing either way.
    expect(noteCartonKgForCode([{ ...LINE, item_code: 'X', box_count: undefined }, { ...LINE, item_code: 'X' }], 'X')).toBe(10);
    expect(noteCartonKgForCode([LINE], null)).toBeNull();
    expect(noteCartonKgForCode([LINE], 'other')).toBeNull();
    expect(noteCartonKgForCode(undefined, '90300662')).toBeNull();
  });

  it('a save retried after a failed POST keeps his "book the note" answer (note_avg, the source reweighed)', () => {
    const asked = copyNoteWeightGap({ weight: 10.5, copies: 59, noteKg: 10 })!;
    const answer = copyNoteAnswerFor('note', asked, 10.5);
    // The field now shows 10; the old Save found no gap and saved with no answer.
    expect(copyNoteSaveStep({ weight: 10, copies: 59, noteKg: 10, answer })).toEqual({ save: 'note' });
  });

  it('"keep" on the source\'s own weight is keep, and asked once per weight', () => {
    const asked = copyNoteWeightGap({ weight: 10.5, copies: 59, noteKg: 10 })!;
    const answer = copyNoteAnswerFor('keep', asked, 10.5);
    expect(answer).toEqual({ choice: 'keep', weight: 10.5 });
    expect(copyNoteSaveStep({ weight: 10.5, copies: 59, noteKg: 10, answer })).toEqual({ save: 'keep' });
    // Another weight is checked afresh.
    expect('ask' in copyNoteSaveStep({ weight: 16, copies: 59, noteKg: 10, answer })).toBe(true);
  });

  it('"type", then 11 typed and kept when asked again: the source takes 11 (was left at 16)', () => {
    const first = copyNoteWeightGap({ weight: 16, copies: 29, noteKg: 10 })!;
    expect(copyNoteAnswerFor('type', first, 16)).toEqual({ choice: 'type', weight: null });
    const again = copyNoteSaveStep({ weight: 11, copies: 29, noteKg: 10, answer: { choice: 'type', weight: null } });
    expect('ask' in again).toBe(true);
    const kept = copyNoteAnswerFor('keep', (again as { ask: typeof first }).ask, 16);
    expect(kept).toEqual({ choice: 'type', weight: 11 });
    const list = differentCarton(source(16), 29, form(11, { note_choice: kept.choice }));
    expect(total(list)).toBe(330);
    expect(weightSourceOf(list[0])).toBe('typed');
  });

  it('"type", then a weight within the note: saved as typed, no second question', () => {
    expect(copyNoteSaveStep({ weight: 10.1, copies: 29, noteKg: 10, answer: { choice: 'type', weight: null } })).toEqual({ save: 'type' });
  });

  it('never asked: no answer carried', () => {
    expect(copyNoteSaveStep({ weight: 10, copies: 59, noteKg: 10, answer: null })).toEqual({ save: undefined });
    expect(copyNoteSaveStep({ weight: 16, copies: 29, noteKg: null, answer: null })).toEqual({ save: undefined });
  });
});
