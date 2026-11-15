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

type NoteLine = Pick<MultiPalletSession['ocr_data'][number], 'quantity_kg' | 'box_count' | 'unit'>;

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
