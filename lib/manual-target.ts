/**
 * Manual capture target hint (04/11, Well Done note 48745; flag
 * `manual_target_hint`, lib/scanner-flags.ts).
 *
 * Wall Dan cartons carry only a 6-digit serial under the bars, which the
 * camera reads but refuses as a carton barcode ('too_short'), so every
 * carton went through the photo tap — and the photo went to the label reader
 * with no barcode at all. With chicken and schnitzel labels stacked in one
 * frame the reader returned a schnitzel label 5 times out of 5 while David
 * aimed at chicken: three phantom schnitzel cartons were booked, and the
 * chicken cartons were dropped as "already on the list".
 *
 * The camera had read the chicken serial a moment before each tap. So:
 *  * every short read is noted with its time (noteShortRead);
 *  * a photo tapped within TARGET_HINT_WINDOW_MS of one, unambiguous and not
 *    already a carton anywhere, asks the reader for THAT label only
 *    (manualTargetDigits → `target_digits` → the bot's sticker prompt);
 *  * the reply is judged against it (targetVerdict): the same number
 *    identifies the carton, as labelConfirmsShortCode does; anything else
 *    is held for review — never booked without a barcode, never dropped as
 *    a duplicate of a label the worker was not aiming at.
 *
 * Pure: no React, no I/O. The page owns the ref and the flag check.
 */
import { digitsOf, hasCartonCode, shortSerialExcluded, type ShortCodeLine } from './carton-barcode';

/** How long after the camera's short read a photo tap still means that label. */
export const TARGET_HINT_WINDOW_MS = 2500;

/** A short serial: the same shape labelConfirmsShortCode accepts. */
const SHORT_SERIAL_RE = /^\d{6,11}$/;

export interface ShortReadNote {
  value: string;
  at: number;
  /** The previous DIFFERENT short read and when it was last seen. */
  prev?: { value: string; at: number };
}

/**
 * The note after the camera read `read` at `now`. The same value again only
 * moves its time on; a different value keeps the old one as `prev`, so a
 * frame flicking between two labels is seen as ambiguous.
 */
export function noteShortRead(note: ShortReadNote | null, read: string, now: number): ShortReadNote {
  const value = (read || '').trim();
  if (note && note.value === value) return { ...note, at: now };
  return note ? { value, at: now, prev: { value: note.value, at: note.at } } : { value, at: now };
}

/**
 * The short serial a photo tapped at `now` should be read for, or null:
 *  * a short read within TARGET_HINT_WINDOW_MS before the tap (a read
 *    stamped after the tap — clock skew — counts as within);
 *  * no OTHER short read in the same window (two labels in view: no guess);
 *  * 6 to 11 digits, and none of the things a short code already is
 *    (shortSerialExcluded: an invoice line's code or a piece of one, part of
 *    a long code on the list, the pallet label);
 *  * not a carton already on the list or in this session — then the
 *    capture goes out exactly as without the flag.
 */
export function manualTargetDigits(
  note: ShortReadNote | null | undefined,
  now: number,
  lines: readonly ShortCodeLine[] | null | undefined,
  listedCodes: readonly string[],
  windowMs: number = TARGET_HINT_WINDOW_MS,
): string | null {
  if (!note) return null;
  const within = (at: number) => now - at <= windowMs;
  if (!within(note.at)) return null;
  if (note.prev && note.prev.value !== note.value && within(note.prev.at)) return null;
  const value = note.value;
  if (!SHORT_SERIAL_RE.test(value)) return null;
  if (hasCartonCode(listedCodes, value)) return null;
  if (shortSerialExcluded(value, lines, listedCodes)) return null;
  return value;
}

/**
 * The reader's answer against the label it was asked for:
 *  * 'none'     — no target was sent (flag off, or no hint): today's path;
 *  * 'match'    — the number under the barcode is the target: it identifies
 *                 the carton (booked and deduped under it);
 *  * 'mismatch' — any other number, or none: the reader may have read a
 *                 neighbouring label, so the row is held for review.
 */
export function targetVerdict(target: string | null | undefined, ocrDigits: string | null | undefined): 'none' | 'match' | 'mismatch' {
  if (!target) return 'none';
  return digitsOf(ocrDigits) === target ? 'match' : 'mismatch';
}

/**
 * The value the OCR route forwards to the bot: a short digit string, or
 * undefined (dropped by JSON.stringify, so the bot's body is as before).
 */
export function targetDigitsToForward(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return SHORT_SERIAL_RE.test(v) ? v : undefined;
}
