/**
 * Cartons counted in units, not kg (27/10, note 008955).
 *
 * Ready meals (KK117 / KK100) arrive as 7 cartons of 18 portions each: the
 * note line is 126 UNITS, and no carton carries a weight. New carton only
 * booked by weight (newCartonBatch refuses a label with none), so the line
 * could not be received at all.
 *
 * In the LOOSE pile only, and only while the session's `features.units_mode`
 * is on (lib/scanner-flags.ts — test chats first), New carton offers a
 * kg | units toggle. Units mode asks how many cartons, how many units in
 * each, and the expiry (one or more, split by carton). Save mints one label
 * per carton (`carton_labels.units_per_carton`) and puts one row per carton
 * on the loose list with `weight: 0` and `units`; the bot credits the line
 * with the units. Nothing here is inferred: the count is only ever the
 * worker's explicit choice of units mode and his own numbers.
 *
 * The kg path never comes through this file.
 */

import type { CartonLabel, MultiPalletBoxScan } from '@/types';

export type LineUnit = 'kg' | 'units';

/** Most cartons one save may mint — the same cap as New carton. */
export const UNITS_MAX_CARTONS = 500;
/** Most units one carton may hold. */
export const UNITS_MAX_PER_CARTON = 9999;
/** Most expiry rows one save may carry. */
export const UNITS_MAX_SPLITS = 20;

/** A note line's unit: 'units' only when it says so; anything else is kg. */
export function lineUnit(line: { unit?: unknown } | null | undefined): LineUnit {
  return line?.unit === 'units' ? 'units' : 'kg';
}

/** A carton booked by count: its `units` is a whole number above 0. */
export function isUnitsCarton(b: { units?: unknown } | null | undefined): boolean {
  const n = Number(b?.units);
  return Number.isInteger(n) && n > 0;
}

/** A whole number from a stepper's text, 0 when there is none. */
export function stepperValue(text: string | number | null | undefined, max: number): number {
  const n = Math.floor(Number(String(text ?? '').replace(/\D/g, '')) || 0);
  return Math.min(Math.max(n, 0), max);
}

/**
 * Units per carton to open on: the line's units over its cartons, when the
 * line is in units and divides evenly (126 / 7 = 18). Else none — the worker
 * types it off the carton.
 */
export function unitsPerCartonPrefill(line: { unit?: unknown; quantity_kg?: number | null; box_count?: number | null } | null | undefined): number | null {
  if (!line || lineUnit(line) !== 'units') return null;
  const total = Number(line.quantity_kg) || 0;
  const boxes = Math.floor(Number(line.box_count) || 0);
  if (!(total > 0) || boxes < 1) return null;
  const per = total / boxes;
  return Number.isInteger(per) && per <= UNITS_MAX_PER_CARTON ? per : null;
}

/**
 * Cartons to open on: what the line still lacks. Only when the loose pile is
 * the whole delivery (no pallets) — otherwise the line's cartons may sit on
 * a pallet the list cannot see, and the existing New carton count (`fallback`,
 * lib/count-check.ts newCartonQuantity) stands.
 */
export function unitsCartonsPrefill(opts: {
  lineBoxes: number | null | undefined;
  onList: number;
  looseOnly: boolean;
  fallback: number;
}): number {
  const boxes = Math.floor(Number(opts.lineBoxes) || 0);
  if (opts.looseOnly && boxes > 0) return Math.max(1, boxes - Math.max(0, Math.floor(opts.onList) || 0));
  return Math.max(1, Math.floor(opts.fallback) || 1);
}

/** One expiry row of a units save: how many of the cartons carry it. */
export interface UnitsSplit {
  cartons: number;
  /** ISO `YYYY-MM-DD`, '' while not picked. */
  expiry: string;
}

/**
 * The splits a save books. With one expiry row it covers every carton (its
 * own count is not asked); with more, each row's count is the worker's.
 */
export function effectiveSplits(total: number, rows: ReadonlyArray<UnitsSplit>): UnitsSplit[] {
  if (rows.length <= 1) return [{ cartons: total, expiry: rows[0]?.expiry ?? '' }];
  return rows.map((r) => ({ cartons: r.cartons, expiry: r.expiry }));
}

/**
 * "+ Another expiry": the new row takes one carton off the first row (the
 * one that held them all), so the rows still add up.
 */
export function addSplit(total: number, rows: ReadonlyArray<UnitsSplit>): UnitsSplit[] {
  const base = effectiveSplits(total, rows);
  if (base.length >= UNITS_MAX_SPLITS) return base;
  const first = base[0];
  const take = first.cartons > 1 ? 1 : 0;
  return [{ ...first, cartons: first.cartons - take }, ...base.slice(1), { cartons: Math.max(1, take), expiry: '' }];
}

/** Take expiry row `i` off; its cartons go back to the first row. */
export function removeSplit(rows: ReadonlyArray<UnitsSplit>, i: number): UnitsSplit[] {
  if (i <= 0 || i >= rows.length) return rows.slice();
  const gone = rows[i];
  const rest = rows.filter((_, j) => j !== i);
  return rest.map((r, j) => (j === 0 ? { ...r, cartons: r.cartons + gone.cartons } : r));
}

/** Why a units Save does nothing; null = it goes through. */
export type UnitsSaveBlock = 'item' | 'saving' | 'count' | 'per' | 'expiry' | 'date' | 'split_sum';

/**
 * The first thing holding a units Save back. Every expiry is required (the
 * carton has no sticker to read one off later) and must pass the same rule
 * as any carton's (`dateError` says which, lib/date-validation.ts); with
 * several rows each needs a carton and together they must make the total.
 */
export function unitsSaveBlock(f: {
  selected: boolean;
  saving: boolean;
  cartons: number;
  perCarton: number;
  splits: ReadonlyArray<UnitsSplit>;
  dateError: (iso: string) => string | null | undefined;
}): UnitsSaveBlock | null {
  if (!f.selected) return 'item';
  if (f.saving) return 'saving';
  if (!(f.cartons >= 1 && f.cartons <= UNITS_MAX_CARTONS)) return 'count';
  if (!(f.perCarton >= 1 && f.perCarton <= UNITS_MAX_PER_CARTON)) return 'per';
  if (f.splits.length === 0 || f.splits.some((s) => !s.expiry)) return 'expiry';
  if (f.splits.some((s) => f.dateError(s.expiry))) return 'date';
  if (f.splits.some((s) => !(s.cartons >= 1)) || splitSum(f.splits) !== f.cartons) return 'split_sum';
  return null;
}

export function splitSum(splits: ReadonlyArray<UnitsSplit>): number {
  return splits.reduce((s, x) => s + (Math.floor(Number(x.cartons)) || 0), 0);
}

/**
 * The body fields of POST /api/carton-labels for a units save (besides the
 * token and batch id). Also the key `batchIdForPayload` hashes, so it stays
 * a plain, stable object.
 */
export function unitsLabelPayload(req: {
  palletNumber: number;
  item: { item_code?: string | null; item_name_hebrew?: string | null; item_name_english?: string | null };
  cartons: number;
  perCarton: number;
  splits: ReadonlyArray<UnitsSplit>;
  printBarcode: boolean;
}) {
  return {
    origin: 'new_carton' as const,
    pallet_number: req.palletNumber,
    item_code: req.item.item_code ?? null,
    item_name_hebrew: req.item.item_name_hebrew ?? null,
    item_name_english: req.item.item_name_english ?? null,
    weight_kg: null,
    quantity: req.cartons,
    units_per_carton: req.perCarton,
    splits: req.splits.map((s) => ({ quantity: s.cartons, expiry_date: s.expiry })),
    production_date: null,
    expiry_date: req.splits[0]?.expiry || null,
    notes: null,
    print_barcode: req.printBarcode,
  };
}

/** A units save as the server takes it, checked; or why it is refused. */
export type ParsedUnitsRequest =
  | { ok: true; perCarton: number; splits: Array<{ quantity: number; expiry: string }> }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Server side: read `units_per_carton` and `splits` off a POST body. Absent
 * `units_per_carton` = not a units save (null). The splits must each be at
 * least one carton with an ISO expiry and add up to `quantity`.
 */
export function parseUnitsRequest(body: { units_per_carton?: unknown; splits?: unknown; quantity?: unknown }): ParsedUnitsRequest | null {
  if (body.units_per_carton === undefined || body.units_per_carton === null) return null;
  const per = Number(body.units_per_carton);
  if (!Number.isInteger(per) || per < 1 || per > UNITS_MAX_PER_CARTON) return { ok: false, error: 'invalid units_per_carton' };
  const quantity = Number(body.quantity);
  if (!Array.isArray(body.splits) || body.splits.length < 1 || body.splits.length > UNITS_MAX_SPLITS) {
    return { ok: false, error: 'invalid splits' };
  }
  const splits: Array<{ quantity: number; expiry: string }> = [];
  for (const raw of body.splits) {
    const s = raw as { quantity?: unknown; expiry_date?: unknown } | null;
    const q = Number(s?.quantity);
    const e = typeof s?.expiry_date === 'string' ? s.expiry_date : '';
    if (!Number.isInteger(q) || q < 1 || !ISO_DATE.test(e)) return { ok: false, error: 'invalid splits' };
    splits.push({ quantity: q, expiry: e });
  }
  if (splits.reduce((n, s) => n + s.quantity, 0) !== quantity) return { ok: false, error: 'splits must add up to quantity' };
  return { ok: true, perCarton: per, splits };
}

/** The expiry of each label a units batch mints, in order (split by split). */
export function splitExpiries(splits: ReadonlyArray<{ quantity: number; expiry: string }>): string[] {
  return splits.flatMap((s) => Array.from({ length: s.quantity }, () => s.expiry));
}

/**
 * Idempotent retry of a units save: does the stored batch hold what this
 * request asks for — the item, the units per carton, and the same number of
 * cartons on each expiry?
 */
export function unitsBatchMatches(
  stored: ReadonlyArray<{ item_code?: string | null; item_name_hebrew?: string | null; item_name_english?: string | null; units_per_carton?: number | null; expiry_date?: string | null; pallet_number?: number | null }>,
  req: { itemCode?: string | null; itemNameHebrew?: string | null; itemNameEnglish?: string | null; perCarton: number; expiries: ReadonlyArray<string>; palletNumber?: number | null },
): boolean {
  if (stored.length === 0 || stored.length !== req.expiries.length) return false;
  const t = (v: string | null | undefined) => (v ?? '').trim();
  const first = stored[0];
  if (t(first.item_code) !== t(req.itemCode) || t(first.item_name_hebrew) !== t(req.itemNameHebrew)
    || t(first.item_name_english) !== t(req.itemNameEnglish)) return false;
  if ((first.pallet_number ?? null) !== (req.palletNumber ?? null)) return false;
  if (stored.some((l) => Number(l.units_per_carton) !== req.perCarton)) return false;
  const a = stored.map((l) => (l.expiry_date ?? '').slice(0, 10)).sort();
  const b = [...req.expiries].sort();
  return a.every((x, i) => x === b[i]);
}

/** A loose-list row of a units save. */
export type UnitsRow = MultiPalletBoxScan & {
  minted: true;
  label_batch_id: string;
  new_carton: true;
  weight_checked: true;
};

/**
 * One loose-list row per saved label: no weight (0), the units in it, the
 * save's shared `units_batch`, its own split's expiry. Booked as a New carton
 * (the label's own 13-digit prefix as SKU, "label not printed" while it is
 * not). `weight_checked` keeps the weight check off it.
 */
export function unitsCartonRows(
  labels: ReadonlyArray<Pick<CartonLabel, 'barcode' | 'batch_id' | 'expiry_date' | 'item_name_hebrew' | 'item_name_english'> & { units_per_carton?: number | null }>,
  opts: { perCarton: number; unitsBatch: string; now?: string },
): UnitsRow[] {
  const now = opts.now ?? new Date().toISOString();
  return labels.map((l) => {
    const own = Number(l.units_per_carton);
    return {
      barcode: l.barcode,
      sku: l.barcode.slice(0, 13),
      item_name: l.item_name_english || '',
      item_name_hebrew: l.item_name_hebrew || '',
      weight: 0,
      units: Number.isInteger(own) && own > 0 ? own : opts.perCarton,
      units_batch: opts.unitsBatch,
      expiry: (l.expiry_date || '').slice(0, 10),
      production_date: '',
      scanned_at: now,
      minted: true as const,
      label_batch_id: l.batch_id,
      new_carton: true as const,
      weight_checked: true as const,
    };
  });
}

/** What one grouped units row says: cartons, units, expiries (first + more). */
export interface UnitsBatchSummary {
  cartons: number;
  units: number;
  firstExpiry: string;
  moreExpiries: number;
}

export function unitsBatchSummary(rows: ReadonlyArray<{ units?: number; expiry?: string }>): UnitsBatchSummary {
  const expiries = [...new Set(rows.map((r) => r.expiry || '').filter(Boolean))].sort();
  return {
    cartons: rows.length,
    units: rows.reduce((s, r) => s + (isUnitsCarton(r) ? Number(r.units) : 0), 0),
    firstExpiry: expiries[0] ?? '',
    moreExpiries: Math.max(0, expiries.length - 1),
  };
}

/** One entry of the loose list as drawn: a carton, or one units save. */
export type ListEntry<T> =
  | { kind: 'box'; box: T; index: number }
  | { kind: 'units'; batch: string; rows: Array<{ box: T; index: number }> };

/**
 * The list as drawn, in the order given (newest first on the page): every
 * carton of one units save becomes ONE entry, where its first carton stands;
 * every other carton stays its own. `index` is the carton's 1-based place in
 * the list (`indexOf`). A list with no units carton comes back one entry per
 * row, unchanged.
 */
export function groupUnitsRows<T extends { units?: number; units_batch?: string }>(
  rows: ReadonlyArray<T>,
  indexOf: (row: T, i: number) => number,
): Array<ListEntry<T>> {
  const out: Array<ListEntry<T>> = [];
  const groups = new Map<string, { kind: 'units'; batch: string; rows: Array<{ box: T; index: number }> }>();
  rows.forEach((box, i) => {
    const index = indexOf(box, i);
    const batch = isUnitsCarton(box) ? box.units_batch : undefined;
    if (!batch) {
      out.push({ kind: 'box', box, index });
      return;
    }
    const g = groups.get(batch);
    if (g) {
      g.rows.push({ box, index });
      return;
    }
    const entry = { kind: 'units' as const, batch, rows: [{ box, index }] };
    groups.set(batch, entry);
    out.push(entry);
  });
  return out;
}

/**
 * What goes to the bot for each loose carton (POST /api/multi-pallet-loose-
 * complete): a units carton carries `units` (a whole number above 0) and
 * `weight: 0`; any other `units` value is dropped, so a carton is either
 * counted by weight or by units, never both.
 */
export function sanitizeUnitsBoxes<T extends { weight?: number; units?: unknown }>(boxes: T[]): T[] {
  return boxes.map((b) => {
    if (!b || typeof b !== 'object' || !('units' in b) || b.units === undefined) return b;
    if (isUnitsCarton(b)) return { ...b, units: Number(b.units), weight: 0 };
    const { units: _drop, ...rest } = b;
    return rest as T;
  });
}

/** `YYYY-MM-DD` → `dd/mm/yy` for the grouped row; '' when not a date. */
export function shortExpiry(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : '';
}

/** The toast after a units save: "1 carton" reads as one, not "1 cartons". */
export function unitsAddedKey(cartons: number): 'carton.unitsAdded' | 'carton.unitsAddedOne' {
  return cartons === 1 ? 'carton.unitsAddedOne' : 'carton.unitsAdded';
}

/** The grouped row's summary, singular for a one-carton save. */
export function unitsRowKey(cartons: number): 'carton.unitsRow' | 'carton.unitsRowOne' {
  return cartons === 1 ? 'carton.unitsRowOne' : 'carton.unitsRow';
}

/**
 * The note's kilograms: the kg lines only. A units line's `quantity_kg`
 * holds its units (126 portions), which are not kilograms.
 */
export function invoiceKgTotal(lines: ReadonlyArray<{ unit?: unknown; quantity_kg?: number | null }>): number {
  return lines.reduce((s, l) => s + (lineUnit(l) === 'kg' ? Number(l.quantity_kg) || 0 : 0), 0);
}
