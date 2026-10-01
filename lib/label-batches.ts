/**
 * Save now, print later — the pure rules behind the carton-label ledger
 * (2026-10-01).
 *
 * "All boxes identical" and "New carton" only SAVE their labels; the worker
 * prints them from the Labels screen whenever it suits, and the print sheet
 * itself marks what it rendered as printed. Everything here is shared by the
 * Labels screen, the scanner page and the API routes, and is kept free of
 * React and Supabase so vitest can run it in node.
 */

import type { CartonLabel, CartonLabelOrigin, Language, LabelSize } from '@/types';
import { toIsoDate } from './expiry';

/**
 * A warehouse-minted carton label: `28` + YYMMDD + 8 digits (see
 * `mintCartonBarcode` in lib/carton-labels.ts). A supplier GTIN never starts
 * with 28, so a row carrying one of these was minted HERE.
 */
export const MINTED_LABEL_RE = /^28\d{14}$/;

export function isMintedLabelBarcode(code: string | null | undefined): boolean {
  return MINTED_LABEL_RE.test((code || '').trim());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client's batch id for an idempotent save, or null when it is missing or
 * not a UUID (the server then mints its own). Lower-cased so a retry matches
 * the row the first attempt wrote whatever the client's casing.
 */
export function parseBatchId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return UUID_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * A fresh client batch id. `crypto.randomUUID` exists only in a secure
 * context, and a phone testing against a LAN dev server is not one — so fall
 * back to getRandomValues (available everywhere), formatted as a v4 UUID so
 * the server's `parseBatchId` still accepts it.
 */
export function newBatchId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  const b = new Uint8Array(16);
  try {
    crypto.getRandomValues(b);
  } catch {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The batch id for THIS save's content. One id per distinct payload, kept for
 * the life of the form: a retry of the same save (lost response) sends the
 * same id and gets the same batch back, while a save whose content changed
 * meanwhile (the count, the weight, a date, another item) gets an id of its
 * own — it must never be answered with the first attempt's labels. `ids` is
 * the form's own map (a ref); `payload` is everything the save sends except
 * the id itself.
 */
export function batchIdForPayload(ids: Map<string, string>, payload: unknown): string {
  const key = JSON.stringify(payload);
  let id = ids.get(key);
  if (!id) {
    id = newBatchId();
    ids.set(key, id);
  }
  return id;
}

/** What a save asks for: everything its labels print or the ledger keeps. */
export interface BatchRequestContent {
  itemCode?: string | null;
  itemNameHebrew?: string | null;
  itemNameEnglish?: string | null;
  weightKg?: number | null;
  /** Already clamped to what the server will write (1–500). */
  quantity: number;
  productionDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  printBarcode: boolean;
  origin?: CartonLabelOrigin;
  sourceBarcode?: string | null;
  palletNumber?: number | null;
}

type StoredBatchRow = Pick<
  CartonLabel,
  | 'item_code' | 'item_name_hebrew' | 'item_name_english' | 'weight_kg' | 'production_date'
  | 'expiry_date' | 'notes' | 'print_barcode' | 'origin' | 'source_barcode' | 'pallet_number'
>;

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim() === (b ?? '').trim();

const sameDate = (a: string | null | undefined, b: string | null | undefined) => {
  const norm = (v: string | null | undefined) => {
    const t = (v ?? '').trim();
    return toIsoDate(t) || t;
  };
  return norm(a) === norm(b);
};

const sameNumber = (a: number | string | null | undefined, b: number | string | null | undefined) => {
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  return Math.abs(Number(a) - Number(b)) < 1e-6;
};

/**
 * Is the batch already stored under a save's id the batch this request asks
 * for? Only then may a retry be answered with it. Every row of a batch is
 * written from one request, so the first row speaks for all of them; the
 * count must match too. `label_size` is left out — printing rewrites it.
 */
export function batchMatchesRequest(stored: ReadonlyArray<StoredBatchRow>, req: BatchRequestContent): boolean {
  const first = stored[0];
  if (!first || stored.length !== req.quantity) return false;
  return sameText(first.item_code, req.itemCode)
    && sameText(first.item_name_hebrew, req.itemNameHebrew)
    && sameText(first.item_name_english, req.itemNameEnglish)
    && sameNumber(first.weight_kg, req.weightKg)
    && sameDate(first.production_date, req.productionDate)
    && sameDate(first.expiry_date, req.expiryDate)
    && sameText(first.notes, req.notes)
    && first.print_barcode === req.printBarcode
    && (first.origin ?? 'new_carton') === (req.origin ?? 'new_carton')
    && sameText(first.source_barcode, req.sourceBarcode)
    && (first.pallet_number ?? null) === (req.palletNumber ?? null);
}

// ── Marking printed ─────────────────────────────────────────────────────────

/** `items` in consecutive slices of at most `size`. */
export function chunked<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * The print counts to bump, one UPDATE each (`… set print_count = c + 1
 * where print_count = c`), highest first: bumping c to c + 1 first and then
 * c - 1 to c never re-matches a row the previous step just moved. Normally a
 * batch has one count (0 on its first print), so one statement marks it all.
 */
export function printCountSteps(counts: ReadonlyArray<number>): number[] {
  return [...new Set(counts.filter((c) => Number.isInteger(c) && c >= 0))].sort((a, b) => b - a);
}

/** Accepted `origin` values; anything else is the New carton default. */
export function parseLabelOrigin(v: unknown): CartonLabelOrigin {
  return v === 'identical' || v === 'receiving' ? v : 'new_carton';
}

/** One unprinted label as the scanner page tracks it (badge, row markers). */
export interface UnprintedLabel {
  barcode: string;
  batch_id: string;
  origin: CartonLabelOrigin;
  /** Pallet it was saved on; 0 = the loose pile; null = unknown. */
  pallet_number: number | null;
}

export function toUnprintedLabels(rows: unknown): UnprintedLabel[] {
  if (!Array.isArray(rows)) return [];
  const out: UnprintedLabel[] = [];
  for (const r of rows as Partial<CartonLabel>[]) {
    if (!r || typeof r.barcode !== 'string' || typeof r.batch_id !== 'string') continue;
    if (r.status && r.status !== 'created') continue;
    out.push({
      barcode: r.barcode,
      batch_id: r.batch_id,
      origin: parseLabelOrigin(r.origin),
      pallet_number: typeof r.pallet_number === 'number' ? r.pallet_number : null,
    });
  }
  return out;
}

/** The small tags on a Labels card: where the batch belongs. */
export type LabelTag =
  | { kind: 'new_carton' }
  | { kind: 'loose' }
  | { kind: 'pallet'; n: number };

export function labelTags(label: Pick<CartonLabel, 'origin' | 'pallet_number'>): LabelTag[] {
  const tags: LabelTag[] = [];
  if (label.origin === 'new_carton') tags.push({ kind: 'new_carton' });
  if (label.pallet_number === 0) tags.push({ kind: 'loose' });
  else if (typeof label.pallet_number === 'number' && label.pallet_number > 0) {
    tags.push({ kind: 'pallet', n: label.pallet_number });
  }
  return tags;
}

/**
 * Unprinted batches first (they are what the worker came for), the rest in
 * the order the server sent them (newest first). Stable, never mutates.
 */
export function sortUnprintedFirst<T extends { count: number; printedCount: number }>(batches: T[]): T[] {
  const unprinted = batches.filter((b) => b.printedCount < b.count);
  const printed = batches.filter((b) => b.printedCount >= b.count);
  return [...unprinted, ...printed];
}

/** Where a barcode sits on the scanner's live lists: a pallet number, or the loose pile. */
export type LiveRowPlace = number | 'loose';

/**
 * How many of a batch's cartons are still rows on the scanner's lists, and
 * where — what deleting the batch would also take off the list. `place` is
 * the place most of them sit (they are minted together, so normally all).
 */
export function rowsOnList(
  barcodes: Iterable<string>,
  liveRows: ReadonlyMap<string, LiveRowPlace> | undefined,
): { count: number; place: LiveRowPlace | null } {
  if (!liveRows || liveRows.size === 0) return { count: 0, place: null };
  const tally = new Map<LiveRowPlace, number>();
  let count = 0;
  for (const code of barcodes) {
    const place = liveRows.get(code);
    if (place === undefined) continue;
    count += 1;
    tally.set(place, (tally.get(place) ?? 0) + 1);
  }
  let place: LiveRowPlace | null = null;
  let best = 0;
  for (const [p, n] of tally) {
    if (n > best) { best = n; place = p; }
  }
  return { count, place };
}

/**
 * Which of the scanner page's lists are still open — scanned but not yet
 * booked — in this phase. The page keeps a list's rows after it books them
 * (pallet_done shows their weight; the last pallet's rows and the loose rows
 * linger into the loose phase and all_done), so the rows alone do not say
 * whether they are still on a list or already on an LPN.
 */
export function openListsForPhase(phase: string): { pallet: boolean; loose: boolean } {
  return {
    pallet: phase === 'scanning' || phase === 'confirming',
    loose: phase === 'loose_scanning' || phase === 'loose_confirming',
  };
}

/**
 * Where each row of the OPEN lists sits, for the Labels screen's "this also
 * removes N boxes from pallet P" warning. Rows of a list already booked are
 * left out: deleting a batch can no longer take them off anything.
 */
export function liveRowPlaces(opts: {
  phase: string;
  currentPallet: number;
  pallet: Iterable<{ barcode: string }>;
  loose: Iterable<{ barcode: string }>;
}): Map<string, LiveRowPlace> {
  const open = openListsForPhase(opts.phase);
  const rows = new Map<string, LiveRowPlace>();
  if (open.pallet) for (const b of opts.pallet) rows.set(b.barcode, opts.currentPallet);
  if (open.loose) for (const b of opts.loose) rows.set(b.barcode, 'loose');
  return rows;
}

/**
 * Every carton barcode a scanner session itself recorded as booked: each
 * completed pallet's `barcodes` and the loose pile's `loose_barcodes`. The
 * completion routes write these into the session BEFORE they answer, while
 * box_inventory is written later by the bot (its webhook goes out after the
 * response, and may fail) — so this is what says "booked" in the meantime.
 * `data` is the raw scan_sessions jsonb; anything malformed counts as none.
 */
export function sessionBookedBarcodes(data: unknown): Set<string> {
  const out = new Set<string>();
  if (!data || typeof data !== 'object') return out;
  const d = data as { completed_pallets?: unknown; loose_barcodes?: unknown };
  const add = (codes: unknown) => {
    if (!Array.isArray(codes)) return;
    for (const c of codes) if (typeof c === 'string' && c) out.add(c);
  };
  if (Array.isArray(d.completed_pallets)) {
    for (const p of d.completed_pallets) {
      if (p && typeof p === 'object') add((p as { barcodes?: unknown }).barcodes);
    }
  }
  add(d.loose_barcodes);
  return out;
}

// ── Print sheet ─────────────────────────────────────────────────────────────

export const DEFAULT_LABEL_SIZE: LabelSize = '10x15';
const SIZE_KEY = 'labels.size';

export function isLabelSize(v: unknown): v is LabelSize {
  return v === '10x10' || v === '10x15' || v === 'a4';
}

/** The label size this device printed with last (per device, never shared). */
export function loadLabelSize(): LabelSize {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(SIZE_KEY) : null;
    return isLabelSize(v) ? v : DEFAULT_LABEL_SIZE;
  } catch {
    return DEFAULT_LABEL_SIZE;
  }
}

export function saveLabelSize(size: LabelSize): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(SIZE_KEY, size);
  } catch { /* private window / blocked storage: the default is fine */ }
}

/** URL of the print sheet for these batches (it opens the dialog by itself). */
export function labelSheetUrl(opts: {
  token: string;
  batchIds: string[];
  size: LabelSize;
  language: Language;
}): string {
  return (
    `/labels/print?token=${encodeURIComponent(opts.token)}` +
    `&batches=${encodeURIComponent(opts.batchIds.join(','))}` +
    `&size=${opts.size}&lang=${encodeURIComponent(opts.language)}`
  );
}
