/**
 * Scan notices — what a read that was NOT a failure tells the worker.
 *
 * pallet-verify used to have one persistent red `error` slot for everything:
 * a network failure, a session that expired, and a carton the camera simply
 * read a second time. On a pallet scanned in place the last one is the most
 * common event of the day (IN264172698 pallet 3: 22 of 32 reads), and it sat
 * in red for minutes ("Already scanned — this is carton #8 in the list
 * (15:09)"), naming the wrong carton after a later manual capture.
 *
 * So a read now produces one of:
 * - a NOTICE: blue "already counted" (nothing to do) or amber "misread, scan
 *   again" (one small action). It names the carton, highlights its row and
 *   clears itself after SCAN_NOTICE_MS.
 * - an ERROR (the page's `error`): red, persistent — the worker must act.
 *
 * The helpers here are the pure parts of that: which row a re-read refers to
 * (or the identical batch that covers it), whether it is worth a sound,
 * whether it may offer "Different carton?", how long it stays up, and where
 * to scroll its row.
 */

import { isMintedLabelBarcode } from './label-batches';
import { parseCartonBarcode } from './barcode-parser';

/** How long a notice stays in the footer. */
export const SCAN_NOTICE_MS = 4000;

/**
 * How long a notice that offers an action ("Different carton?") stays up. A
 * worker holding a carton has to lower the phone to tap it — and once the
 * camera stops re-reading the sticker nothing refreshes the notice — so it
 * gets twice as long. Touching it holds it up (the page pauses the timer).
 */
export const SCAN_NOTICE_ACTION_MS = 8000;

/**
 * How long this notice stays up; null = until it is answered (19/10).
 *
 * A notice that ASKS something stays: "already on the list — same carton, or
 * another carton with an identical label?" and "only a short barcode — is
 * there a long one?". Both used to vanish after 4–8 s, and the first one told
 * a worker holding a real twin to "scan the next carton". The next good scan,
 * another notice, a phase change or either answer takes it down — the camera
 * never waits on it.
 */
export function scanNoticeMs(notice: { different?: unknown; newCarton?: unknown; short?: unknown }): number | null {
  // "Same carton" already answered for this code: only the twin way in is
  // left on it, and it goes like any action notice once the camera is away.
  if ((notice.different as { sameAnswered?: boolean } | undefined)?.sameAnswered) return SCAN_NOTICE_ACTION_MS;
  if (notice.different || notice.short) return null;
  return notice.newCarton ? SCAN_NOTICE_ACTION_MS : SCAN_NOTICE_MS;
}

/**
 * Does this notice wait for an answer — and so take the device Back button?
 *
 * Wall Dan 25/10 13:32: the "only a short barcode" question was up, David
 * pressed Back to dismiss it, and the page went back to the morning's Baladi
 * session instead. Back on a question now takes it down (like "There is a
 * long barcode"); a notice that clears itself leaves Back alone, and so does
 * the plain scanning screen.
 */
export function noticeAwaitsAnswer(notice: Parameters<typeof scanNoticeMs>[0] | null): boolean {
  return !!notice && scanNoticeMs(notice) === null;
}

/**
 * A short read (lib/carton-barcode.ts too_short, e.g. `406243` on document
 * 48429) is explained once per code per minute. It used to come back amber,
 * with a buzz, every ~3 s for as long as the camera saw the code.
 */
export const SHORT_NOTICE_QUIET_MS = 60000;

/**
 * Explain this short code now? Yes the first time and once `windowMs` has
 * passed since it was last explained (a fixed window, not sliding: a camera
 * parked on it hears again after a minute). Records `now` when it says yes.
 */
export function shouldExplainShortRead(
  last: Map<string, number>,
  code: string,
  now: number,
  windowMs: number = SHORT_NOTICE_QUIET_MS,
): boolean {
  const prev = last.get(code);
  if (prev !== undefined && now - prev < windowMs) return false;
  last.set(code, now);
  return true;
}

/** How long the carton a notice names stays highlighted in the list. */
export const HIGHLIGHT_ROW_MS = 2000;

/**
 * A camera parked on an already-counted sticker re-reads it every ~3.3 s (the
 * scanner's 3 s hold plus two reads). Re-reads of the same code inside this
 * window stay silent: the notice refreshes, the phone does not tick again.
 */
export const DUPLICATE_QUIET_MS = 15000;

/**
 * Should this re-read of an already-counted carton make a sound?
 *
 * Yes the first time, and again once the same code has gone unread for
 * `windowMs`. The window slides — every read restarts it — so a camera left
 * pointing at one sticker stays quiet however long it sits there. Records
 * `now` against the code in `last` as a side effect.
 */
export function shouldSoundDuplicate(
  last: Map<string, number>,
  barcode: string,
  now: number,
  windowMs: number = DUPLICATE_QUIET_MS,
): boolean {
  const prev = last.get(barcode);
  last.set(barcode, now);
  return prev === undefined || now - prev >= windowMs;
}

/**
 * Forget re-read times, so the next re-read sounds again: all of them (a new
 * pallet) or only some codes (a deleted row — re-scanning a carton after
 * deleting it must never be muted).
 */
export function clearDuplicateSounds(last: Map<string, number>, barcodes?: Iterable<string>): void {
  if (!barcodes) {
    last.clear();
    return;
  }
  for (const code of barcodes) last.delete(code);
}

/** The fields the lookups below read off a list row. */
interface CountedRow {
  barcode: string;
  /** The supplier code an "all boxes identical" row stands in for. */
  source_barcode?: string;
  /** Minted by "all boxes identical" / "Different carton?". */
  minted?: boolean;
  /**
   * Minted for ONE more carton with a byte-identical label ("Another carton,
   * same label" / "Different carton?"): a carton of its own, NOT a batch that
   * declares every carton carrying `source_barcode` counted.
   */
  twin?: boolean;
}

const digitsOf = (code: string | undefined | null) => (code || '').replace(/\D/g, '');

/**
 * Is this row a warehouse label an identical batch minted IN PLACE OF `code`
 * (the supplier code just read, or a photo's printed digits)? Then the read
 * is not "carton #n": the worker declared that every carton carrying this
 * code is on the list already, as one row per printed label — and the camera
 * keeps reading the supplier code on each carton while those labels are
 * stuck on, every one a physically different carton.
 */
export function isBatchStandIn(code: string, row: CountedRow): boolean {
  const c = digitsOf(code);
  // A twin row is one more carton, not a declaration that covers the code.
  if (!row.minted || row.twin || !c || !row.source_barcode) return false;
  return digitsOf(row.source_barcode) === c && digitsOf(row.barcode) !== c;
}

/** How many rows on the list stand in for `code` — the batch's label count. */
export function standInCount(rows: ReadonlyArray<CountedRow>, code: string): number {
  return rows.filter((r) => isBatchStandIn(code, r)).length;
}

export interface CountedCarton<T> {
  /** 1-based carton number — the badge the list shows on the row. */
  n: number;
  row: T;
}

/**
 * The carton a re-read barcode refers to: the row that carries the code
 * itself, wherever it sits. Only when none does, a supplier code that an
 * identical batch stands in for points at the batch's first row. (A twin row
 * added before the original was rescanned sits ahead of it on the list; a
 * first-match lookup named the twin, and the notice then said the code was
 * covered by labels and offered nothing.)
 */
export function findCountedCarton<T extends CountedRow>(rows: ReadonlyArray<T>, code: string): CountedCarton<T> | null {
  let i = rows.findIndex((r) => r.barcode === code);
  if (i === -1) i = rows.findIndex((r) => r.source_barcode === code);
  return i === -1 ? null : { n: i + 1, row: rows[i] };
}

/**
 * How many one-more-carton twins of `code` are on the list (rows minted by
 * "Another carton, same label" / "Different carton?" for it).
 */
export function twinCount(rows: ReadonlyArray<CountedRow>, code: string): number {
  const c = digitsOf(code);
  if (!c) return 0;
  return rows.filter((r) => r.twin && digitsOf(r.source_barcode) === c).length;
}

/**
 * How many cartons on the list carry this exact label: the row with the code
 * itself plus every twin saved for it ("Another carton, same label" /
 * "Different carton?"). What the twin form counts as "already on the list"
 * when it asks for the total with this label.
 */
export function sameLabelOnList(rows: ReadonlyArray<CountedRow>, code: string): number {
  const c = digitsOf(code);
  if (!c) return 0;
  return rows.filter((r) => digitsOf(r.barcode) === c || (r.twin && digitsOf(r.source_barcode) === c)).length;
}

/**
 * The carton a manual capture's printed digits refer to: the FULL printed
 * number against every other row's barcode digits — never the 13-digit SKU,
 * which repeats on every carton of one product. `exceptBarcode` is the
 * capture's own provisional row.
 *
 * Like findCountedCarton, a supplier code an identical batch stands in for
 * points at the batch's first row — otherwise a photo of a label the batch
 * already covers would be booked as one more carton, silently, while a
 * bar-scan of the very same label says it is counted.
 */
export function findCountedCartonByDigits<T extends CountedRow>(
  rows: ReadonlyArray<T>,
  digits: string,
  exceptBarcode?: string,
): CountedCarton<T> | null {
  if (!digits) return null;
  const same = (code: string | undefined) => !!code && code.replace(/\D/g, '') === digits;
  // The row that carries the digits itself first (see findCountedCarton).
  let i = rows.findIndex((r) => r.barcode !== exceptBarcode && same(r.barcode));
  if (i === -1) i = rows.findIndex((r) => r.barcode !== exceptBarcode && same(r.source_barcode));
  return i === -1 ? null : { n: i + 1, row: rows[i] };
}

/**
 * May an "already counted" notice offer "Different carton?"?
 *
 * The scanner dedupes on the full printed barcode, and some suppliers' labels
 * carry no serial: a 31-digit catch-weight label is GTIN + net weight in 10 g
 * steps + gross + expiry, so two physically different cartons of one pallet
 * can print byte-identical codes (about a coin flip on a 15-carton pallet).
 * Without a way in, the second one could not be booked at all. The offer is
 * an explicit tap that saves it a warehouse label of its own (see
 * IdenticalBoxesForm) — never an automatic second row.
 *
 * Not offered for a warehouse-minted `28…` label (unique per carton by
 * construction, so a re-read IS the same carton), for anything that is not a
 * real barcode (`MANUAL-…` / `NOBC-…`), while the counted row is still in
 * OCR — the form would open with no name or weight to copy — or when the hit
 * is an identical batch standing in for the code (`isBatchStandIn`): the
 * worker already declared every carton that carries it, so "one more" would
 * count a labelled carton twice.
 */
export function canOfferDifferentCarton(
  code: string,
  row: { ocr_status?: string } & Partial<CountedRow>,
): boolean {
  const c = (code || '').trim();
  if (!/^\d/.test(c) || isMintedLabelBarcode(c)) return false;
  if (typeof row.barcode === 'string' && isBatchStandIn(c, row as CountedRow)) return false;
  return row.ocr_status !== 'processing';
}

/**
 * What an already-counted notice offers for a carton with a byte-identical
 * label (S1, David 2026-10-11).
 *
 * - `{ quick: true, weight }` — the code is a 31-digit catch-weight label
 *   with a parseable net weight (`parseCartonBarcode`, chars 14–19 ÷ 1000).
 *   Two cartons print the same code exactly when they weigh the same to the
 *   10 g, so the twin's weight is the one its own barcode prints: the notice
 *   shows a full-width "Another carton, same label · {kg} kg" button and ONE
 *   tap saves it (no form). On IN264185523 pallet 2 there were ~20 such
 *   collisions in 73 cartons; the link-plus-form took two taps each and was
 *   never found, so the cartons were covered by a batch at a made-up weight.
 * - `{ quick: false }` — no weight in the code: today's "Different carton?"
 *   link and form, where the worker types the weight.
 * - `null` — nothing is offered (see canOfferDifferentCarton).
 */
export type DifferentCartonOffer = { quick: true; weight: number } | { quick: false };

export function differentCartonOffer(
  code: string,
  row: { ocr_status?: string } & Partial<CountedRow>,
): DifferentCartonOffer | null {
  if (!canOfferDifferentCarton(code, row)) return null;
  const weight = parseCartonBarcode(code)?.weight ?? null;
  return weight !== null ? { quick: true, weight } : { quick: false };
}

/**
 * Which words an already-on-the-list notice uses (19/10). It ASKS — "same
 * carton, or another carton with an identical label?" — whenever it can
 * offer "Another carton — add it"; otherwise it only says where the carton
 * is: our own printed label (`28…`, one per carton by construction), or a
 * carton whose sticker is still being read ("scan it again in a moment").
 * Never "already counted — scan the next carton", which told a worker
 * holding a real twin to skip it.
 */
export type ListedNoticeKey =
  | 'terminal.alreadyCounted'
  | 'terminal.photoAlreadyCounted'
  | 'terminal.alreadyCountedPlusTwins'
  | 'terminal.ownLabelListed'
  | 'terminal.alreadyListedReading'
  | 'terminal.alreadyListed';

export function listedNoticeKey(
  code: string,
  row: ({ ocr_status?: string } & Partial<CountedRow>) | null,
  opts: { photo: boolean; twins: number },
): ListedNoticeKey {
  if (!row || !differentCartonOffer(code, row)) {
    if (isMintedLabelBarcode(code)) return 'terminal.ownLabelListed';
    return row?.ocr_status === 'processing' ? 'terminal.alreadyListedReading' : 'terminal.alreadyListed';
  }
  if (opts.twins > 0) return 'terminal.alreadyCountedPlusTwins';
  return opts.photo ? 'terminal.photoAlreadyCounted' : 'terminal.alreadyCounted';
}

/**
 * After "Another carton, same label" for a code, the camera is usually still
 * on that sticker and re-reads it every ~3.3 s (the 3 s cooldown plus two
 * reads). Offering the one-tap button again on those re-reads invites a
 * second tap for a carton that does not exist. So the button for that code
 * is held back until the code has gone unread for TWIN_REARM_GAP_MS (longer
 * than the parked re-read cadence, so a parked camera never re-arms it) or
 * a different code has been read. While it is held the notice still offers
 * the "Different carton?" form — a deliberate two-step way in — so a third
 * carton printing the same code can always be added.
 */
export const TWIN_REARM_GAP_MS = 5000;

export interface TwinHold {
  code: string;
  lastRead: number;
}

/**
 * Note one camera read for the twin hold and say whether the one-tap button
 * is held back for it. A different code, or the same code after a gap of
 * `gapMs`, releases the hold; a re-read inside the gap slides it.
 */
export function noteTwinHoldRead(
  hold: { current: TwinHold | null },
  code: string,
  now: number,
  gapMs: number = TWIN_REARM_GAP_MS,
): boolean {
  const h = hold.current;
  if (!h) return false;
  if (h.code !== code || now - h.lastRead >= gapMs) {
    hold.current = null;
    return false;
  }
  h.lastRead = now;
  return true;
}

/**
 * Where to scroll a list so a row is fully in view with the least movement
 * (`block: 'nearest'`), or null when it already is — or when the list is too
 * short to show it at all (a collapsed sheet: scrolling it would only hide
 * what little the worker can see). Plain numbers in the list's own
 * coordinates: `itemTop` is the row's offset from the top of the content.
 */
export function nearestScrollTop(
  itemTop: number,
  itemHeight: number,
  viewTop: number,
  viewHeight: number,
): number | null {
  if (viewHeight < itemHeight * 2) return null;
  if (itemTop < viewTop) return itemTop;
  if (itemTop + itemHeight > viewTop + viewHeight) return itemTop + itemHeight - viewHeight;
  return null;
}
