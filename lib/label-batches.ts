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
