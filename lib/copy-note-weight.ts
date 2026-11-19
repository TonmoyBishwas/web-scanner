/**
 * copy_note_weight_check (15/11, Baladi IN264207398, Priority draft
 * GR26000207): the "Different carton?" / identical save copies ONE carton's
 * weight onto many, and nothing compared that weight with the delivery note.
 * Turkey patties 90300662, note 900 kg / 90 cartons = 10 kg a carton, every
 * carton the same internal code 2000090300662 (no weight in it):
 *
 *  - pallet 1: the label OCR read 10.5 kg (printed nowhere on the label),
 *    David typed 60 in "Different carton?" and 59 copies got 10.5 → 630 kg;
 *  - pallet 2: the OCR read 16 kg (the nutrition table's protein per 100 g),
 *    29 copies → 480 kg.
 *
 * 1110 kg booked for 900. No doubt fired: the form's save confirms the
 * weight for every copy (lib/identical-boxes.ts weight_confirmed), and the
 * list check (lib/weight-sanity.ts) only knows the list — 60 cartons at
 * 10.5 have 10.5 as their own median, and 16 is not 3x off anything.
 *
 * Now, with the switch on, a save that would book 2+ copies at a weight off
 * the note's per-carton weight (its line's kg / cartons) by more than
 * COPY_NOTE_WEIGHT_REL, and by COPY_NOTE_WEIGHT_MIN_KG or more over the
 * copies, is held for one answer: book the note's weight, keep the weight
 * shown, or type another. Measured on every identical batch since 22/09 (30
 * batches of 2+ cartons with a kg line): 25 were within 0.0% of the note, 5
 * were 5% or more off and every one of them was a wrong booking (10.5/10 and
 * 16/10 here; 18.8/10 on IN264193474, booked 1447.6 kg for 770; 6/12 on
 * IN264184055, 600 for 1200; salmon cartons booked on the tilapia line of
 * IN264172698). Nothing fell between 0% and 5%; 3% leaves room under a
 * 10.5-for-10 misread and above the 2.1–2.8% of real catch-weight cartons
 * against their note's average. The minimum kg keeps two cartons a few
 * hundred grams off a note average from asking.
 *
 * Pure: the form asks, the page applies (lib/identical-boxes.ts).
 */
import type { Language, MultiPalletSession } from '@/types';

/** Off by more than this fraction of the note's per-carton weight. */
export const COPY_NOTE_WEIGHT_REL = 0.03;
/** …and by at least this many kg over all the copies. */
export const COPY_NOTE_WEIGHT_MIN_KG = 2;
/** A save of fewer copies is one carton weighing its own: never asked. */
export const COPY_NOTE_WEIGHT_MIN_COPIES = 2;

// Partial: New carton's own line type (CartonItemOption) leaves both figures optional.
type NoteLine = Partial<Pick<MultiPalletSession['ocr_data'][number], 'quantity_kg' | 'box_count' | 'unit'>>;

/**
 * The note's weight of one carton of a line: its kg over its cartons, to the
 * gram. Null when the line is in units, or either figure is missing.
 */
export function notePerCartonKg(line: NoteLine | null | undefined): number | null {
  if (!line || (line.unit && line.unit !== 'kg')) return null;
  const kg = Number(line.quantity_kg);
  const boxes = Number(line.box_count);
  if (!(kg > 0) || !(boxes > 0) || !Number.isInteger(boxes)) return null;
  return Math.round((kg / boxes) * 1000) / 1000;
}

/**
 * The note's per-carton weight for an item code over all the note's lines
 * (review 15/11): a code on two lines (a multi-invoice delivery, or one note
 * listing the item twice) gives their common weight, and null when they
 * disagree, so a save is never held against the other line's carton.
 * Lines without both figures say nothing either way.
 */
export function noteCartonKgForCode(
  lines: ReadonlyArray<NoteLine & { item_code?: string | number | null }> | null | undefined,
  code: string | null | undefined,
): number | null {
  if (!code || !lines) return null;
  const kgs = lines
    .filter((l) => String(l.item_code ?? '') === code)
    .map((l) => notePerCartonKg(l))
    .filter((kg): kg is number => kg !== null);
  if (kgs.length === 0) return null;
  return kgs.every((kg) => Math.abs(kg - kgs[0]) < 0.001) ? kgs[0] : null;
}

export interface CopyNoteGap {
  /** The note's per-carton weight. */
  noteKg: number;
  /** The weight the save would copy. */
  weight: number;
  /** Cartons the save would mint at that weight. */
  copies: number;
  /** |weight − noteKg| / noteKg. */
  rel: number;
  /** copies × |weight − noteKg|. */
  kgImpact: number;
}

/**
 * Should this save be held for the note question? The gap when it should,
 * null when not: no note weight, fewer than 2 copies, within 3%, or under
 * 2 kg over the copies.
 */
export function copyNoteWeightGap(a: { weight: number; copies: number; noteKg: number | null | undefined }): CopyNoteGap | null {
  const weight = Number(a.weight);
  const noteKg = Number(a.noteKg);
  const copies = Math.floor(Number(a.copies) || 0);
  if (!(noteKg > 0) || !(weight > 0) || copies < COPY_NOTE_WEIGHT_MIN_COPIES) return null;
  const diff = Math.abs(weight - noteKg);
  const rel = diff / noteKg;
  const kgImpact = Math.round(copies * diff * 1000) / 1000;
  // Float noise aside (10.3 vs 10 is 0.030000000000000072).
  if (rel <= COPY_NOTE_WEIGHT_REL + 1e-9 || kgImpact < COPY_NOTE_WEIGHT_MIN_KG - 1e-9) return null;
  return { noteKg, weight, copies, rel, kgImpact };
}

/** The worker's answer, kept on the form and traced (`copy_note_weight_choice`). */
export type CopyNoteChoice = 'note' | 'keep' | 'type';

/**
 * His answer as the form keeps it: the choice and the weight it settled
 * (null for 'type', which settles nothing until he types).
 */
export interface CopyNoteAnswer { choice: CopyNoteChoice; weight: number | null }

/**
 * The answer a button gives (review 15/11). "Keep" on a weight that is not
 * the source carton's own (he typed it, then kept it when asked again) is
 * his typed weight, so the source takes it like any other 'type'.
 */
export function copyNoteAnswerFor(choice: CopyNoteChoice, gap: CopyNoteGap, sampleWeight: number): CopyNoteAnswer {
  if (choice === 'note') return { choice, weight: gap.noteKg };
  if (choice === 'type') return { choice, weight: null };
  return { choice: Math.abs(gap.weight - Number(sampleWeight)) >= 0.001 ? 'type' : 'keep', weight: gap.weight };
}

/**
 * What Save does (review 15/11): ask, or save with the answer to carry.
 * A weight he already answered for saves with that answer again, so a save
 * retried after a failed POST still books the note's weight as `note_avg`
 * and still reweighs the source carton; any other weight is checked afresh,
 * and after "type" a weight within the note carries 'type'.
 */
export function copyNoteSaveStep(a: {
  weight: number; copies: number; noteKg: number | null | undefined; answer: CopyNoteAnswer | null;
}): { ask: CopyNoteGap } | { save: CopyNoteChoice | undefined } {
  if (a.answer && a.answer.weight !== null && Math.abs(a.answer.weight - a.weight) < 0.001) {
    return { save: a.answer.choice };
  }
  const gap = copyNoteWeightGap(a);
  if (gap) return { ask: gap };
  return { save: a.answer ? 'type' : undefined };
}

// ─── New carton (19/11) ───
//
// Glatt note 261066779, item 5086 meatballs, 10.13 kg a carton on the note:
// David saved New carton with 28 cartons and 28 in the weight (meant as the
// count, or the carton total) at 11:35:03, and the 28 cartons were counted
// at 28 kg each, 784 kg for ~284. New carton mints every carton at the one
// weight typed, a copy of a weight onto N cartons like the identical save,
// so the same question holds it: same switch, same thresholds, same texts.

/** The fields of an invoice line New carton books onto (components/terminal/CartonCreator.tsx). */
type CreatorLine = NoteLine & { item_code?: string | number | null };

/**
 * The note's per-carton weight of the line New carton books onto: by its
 * item code over all the note's lines, as the copy form reads it
 * (noteCartonKgForCode: a code on two lines that disagree says nothing), and
 * a line with no code by its own figures. A units line never has one.
 */
export function creatorNoteCartonKg(
  lines: ReadonlyArray<CreatorLine> | null | undefined,
  item: CreatorLine | null | undefined,
): number | null {
  if (!item || (item.unit && item.unit !== 'kg')) return null;
  const code = item.item_code === null || item.item_code === undefined ? '' : String(item.item_code);
  return code ? noteCartonKgForCode(lines, code) : notePerCartonKg(item);
}

/**
 * What New carton's Save does: ask, or save with the answer to carry
 * (copyNoteSaveStep, every carton of the save a copy at the typed weight).
 * Never asked with the switch off (`noteCartonKgOf` absent), in units mode,
 * or for an empty weight; one carton never (COPY_NOTE_WEIGHT_MIN_COPIES).
 */
export function creatorNoteSaveStep<I>(a: {
  noteCartonKgOf: ((item: I) => number | null) | undefined;
  item: I | null | undefined;
  /** The weight field as typed ('' = none). */
  weight: string | number;
  cartons: number;
  unitsMode?: boolean;
  answer: CopyNoteAnswer | null;
}): { ask: CopyNoteGap } | { save: CopyNoteChoice | undefined } {
  if (!a.noteCartonKgOf || a.unitsMode || a.item === null || a.item === undefined) return { save: undefined };
  const weight = Number(a.weight);
  if (!(weight > 0)) return { save: undefined };
  return copyNoteSaveStep({ weight, copies: a.cartons, noteKg: a.noteCartonKgOf(a.item), answer: a.answer });
}

// PROPOSED (text freeze, Mevaser 20/10): none of these is approved yet. They
// show only with scanner flag copy_note_weight_check on. {note} = the note's
// kg a carton, {w} = the weight about to be copied.
export const COPY_NOTE_WEIGHT_TEXT = {
  Hebrew: {
    // "Per the note {note} kg a carton, here {w} kg. Which weight to book?"
    ask: 'לפי התעודה {note} ק"ג לקרטון, כאן {w} ק"ג. איזה משקל לרשום?',
    // "Book {note} kg (per the note)"
    note: 'לרשום {note} ק"ג (לפי התעודה)',
    // "Keep {w} kg"
    keep: 'להשאיר {w} ק"ג',
    // "Type the weight"
    type: 'להקליד משקל',
  },
  English: {
    ask: 'The note says {note} kg a carton, this says {w} kg. Which weight to book?',
    note: 'Book {note} kg (the note)',
    keep: 'Keep {w} kg',
    type: 'Type the weight',
  },
} as const;

export type CopyNoteTextKey = keyof typeof COPY_NOTE_WEIGHT_TEXT.English;

/** One PROPOSED text, filled in. Weights shown as typed, trailing zeros dropped. */
export function copyNoteText(lang: Language | string | undefined, key: CopyNoteTextKey, vars: { note: number; w: number }): string {
  const set = lang === 'Hebrew' ? COPY_NOTE_WEIGHT_TEXT.Hebrew : COPY_NOTE_WEIGHT_TEXT.English;
  const kg = (x: number) => String(Math.round(x * 1000) / 1000);
  return set[key].replace('{note}', kg(vars.note)).replace('{w}', kg(vars.w));
}
