/**
 * "All boxes identical → print labels" (2026-09-22).
 *
 * Some products print ONE barcode on every carton, and for those the name,
 * weight and expiry are the same on every carton too. The scanner dedupes on
 * the barcode, so only one such carton could ever be booked — and on the way
 * out N boxes sharing a code cannot be told apart.
 *
 * The worker (never the system — nothing is inferred from a barcode's shape)
 * captures ONE carton, taps the action on its row, confirms weight / dates
 * and types the count. The server mints N unique barcodes in `carton_labels`
 * (28 + YYMMDD + 8 digits, a GS1 internal prefix), the worker prints and
 * sticks them, and THIS helper turns the sample row into N ordinary scan
 * rows. They travel to the completion route like any scanned box, so the bot
 * books one box_inventory row per minted barcode and an outbound photo of a
 * printed sticker finds exactly that row.
 */

import type { CartonLabel, MultiPalletBoxScan } from '@/types';
import { isMintedLabelBarcode } from './label-batches';

/** What the confirmation form settles for the whole batch. */
export interface IdenticalForm {
  weight: number;
  /** ISO `YYYY-MM-DD` like every scan row ('' when unknown) — see lib/expiry.ts. */
  expiry: string;
  production_date: string;
  /**
   * The worker saw this weight on screen and saved it (the identical /
   * "Different carton?" form, New carton): every row of the batch is then
   * confirmed by that one decision and the weight check (lib/weight-sanity.ts)
   * never flags them one by one. Absent on a save that showed no weight —
   * the one-tap twin — where only an already-confirmed sample carries over.
   */
  weight_confirmed?: boolean;
  /**
   * The product the worker picked when the carton's code and its read name
   * pointed at two invoice lines (the form's "which product?"). Absent: the
   * sample's own names.
   */
  item?: { item_code: string; item_name_hebrew: string; item_name_english: string };
}

export interface MintedLabelRef {
  barcode: string;
  batch_id: string;
}

/**
 * The product-level key the bot stores as `box_inventory.box_sku`: the first
 * 13 digits of the supplier barcode (the GS1 item prefix), so the N minted
 * rows still group under the product for per-SKU queries. A provisional
 * `MANUAL-…` id has no digits and yields ''.
 */
export function sourceSku(barcode: string): string {
  // A provisional id (`MANUAL-…`, `NOBC-…`) is not a barcode at all.
  if (!/^\d/.test((barcode || '').trim())) return '';
  const digits = barcode.replace(/\D/g, '');
  return digits.length >= 13 ? digits.slice(0, 13) : digits;
}

type SampleRow = MultiPalletBoxScan & {
  image_data?: string;
  needs_review?: boolean;
  barcode_conflict?: unknown;
  minted?: boolean;
  label_batch_id?: string;
  source_barcode?: string;
  weight_suspect?: unknown;
  weight_checked?: boolean;
};

/**
 * One row per minted label. Every row carries the product identity of the
 * sample and the form's weight/dates; the sticker photo (`image_data`) stays
 * on the first row only (it is the same picture N times over, and it is
 * large), while the uploaded `image_url` is kept on all of them so each
 * box_inventory row still points at the sticker it was booked from.
 *
 * `source_barcode` keeps the full supplier code the batch stands in for (`sku`
 * holds only its first 13 digits). The page keeps that code in its dedup set
 * while any row standing in for it is still on the list (`releasedSources`).
 */
export type MintedRow<T> = T & { minted: true; label_batch_id: string; source_barcode: string };

export function expandIdenticalBoxes<T extends SampleRow>(
  sample: T,
  labels: MintedLabelRef[],
  form: IdenticalForm,
): MintedRow<T>[] {
  const sku = sourceSku(sample.barcode);
  const now = new Date().toISOString();
  return labels.map((label, i) => ({
    ...sample,
    barcode: label.barcode,
    sku,
    weight: form.weight,
    expiry: form.expiry,
    production_date: form.production_date,
    scanned_at: now,
    image_data: i === 0 ? sample.image_data : undefined,
    needs_review: undefined,
    barcode_conflict: undefined,
    // The weight check (lib/weight-sanity.ts) judges each new row afresh,
    // unless the worker settled the weight: in the form that showed it
    // (2026-10-19: 20 kebab labels saved at 8 kg each came out flagged, and
    // were saved one by one with nothing changed), or on the sample already.
    weight_suspect: undefined,
    weight_checked: form.weight_confirmed || (sample.weight_checked && form.weight === sample.weight) ? true : undefined,
    minted: true as const,
    label_batch_id: label.batch_id,
    source_barcode: sample.barcode,
  }));
}

/** The fields the dedup bookkeeping below reads off a list row. */
type ListedRow = { barcode: string; source_barcode?: string; twin?: boolean };

/**
 * Every code a list's rows hold in the page's dedup set: each row's own
 * barcode, plus the supplier code a minted row stands in for. Used to refill
 * the set from the browser cache after a reload, so a re-read of the sample
 * carton is still caught exactly as it was before the reload.
 *
 * A one-tap twin ("Another carton, same label") is a carton of its own, not a
 * stand-in: it never holds the supplier code. Only the original row does, so
 * a list restored after the original was deleted lets that carton be scanned
 * again, exactly as the live page did before the reload.
 */
export function dedupCodes(rows: ReadonlyArray<ListedRow>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.barcode) out.add(r.barcode);
    if (r.source_barcode && !r.twin) out.add(r.source_barcode);
  }
  return [...out];
}

/** True while some row on the list is, or stands in for, this supplier code
 *  (a twin row does not stand in for it — see dedupCodes). */
export function sourceStillListed(rows: ReadonlyArray<ListedRow>, source: string): boolean {
  return rows.some((r) => r.barcode === source || (!r.twin && r.source_barcode === source));
}

/**
 * The supplier codes to take out of the dedup set when the rows in `gone`
 * leave this list: those of a deleted minted row that no row left behind is,
 * or stands in for. Deleting every row of an identical batch one by one then
 * frees the sample carton for a fresh scan, exactly like deleting the batch
 * in Labels does; deleting only some of them keeps it blocked.
 */
export function releasedSources(rows: ReadonlyArray<ListedRow>, gone: ReadonlySet<string>): string[] {
  const remaining = rows.filter((r) => !gone.has(r.barcode));
  const out = new Set<string>();
  for (const r of rows) {
    if (!gone.has(r.barcode) || !r.source_barcode) continue;
    if (!sourceStillListed(remaining, r.source_barcode)) out.add(r.source_barcode);
  }
  return [...out];
}

// ─── Saving the labels: one path for the form and the one-tap twin ───

/** What one "identical" label save asks for. */
export interface IdenticalLabelRequest {
  /** The supplier code the labels stand in for. */
  sourceBarcode: string;
  /** Pallet the batch is minted on; 0 = the loose pile. */
  palletNumber: number;
  itemCode?: string | null;
  itemNameHebrew?: string | null;
  itemNameEnglish?: string | null;
  weightKg: number;
  quantity: number;
  /** ISO `YYYY-MM-DD`, '' when unknown. */
  productionDate?: string | null;
  expiryDate?: string | null;
  /**
   * Default `identical`. "Change count" growing a New carton group saves
   * more New carton labels (no supplier code) the same way.
   */
  origin?: 'identical' | 'new_carton';
}

/**
 * The body fields of POST /api/carton-labels for an `identical` batch — the
 * exact shape IdenticalBoxesForm has always sent. Also the key
 * `batchIdForPayload` hashes, so it must stay a plain, stable object.
 */
export function identicalLabelPayload(req: IdenticalLabelRequest) {
  return {
    origin: req.origin ?? ('identical' as const),
    source_barcode: req.sourceBarcode,
    pallet_number: req.palletNumber,
    item_code: req.itemCode || null,
    item_name_hebrew: req.itemNameHebrew || null,
    item_name_english: req.itemNameEnglish || null,
    weight_kg: req.weightKg,
    quantity: req.quantity,
    production_date: req.productionDate || null,
    expiry_date: req.expiryDate || null,
    print_barcode: true,
  };
}

export type IdenticalLabelPayload = ReturnType<typeof identicalLabelPayload>;

export type SaveLabelsResult =
  | { ok: true; labels: CartonLabel[] }
  | { ok: false; reason: 'session' | 'failed' };

/**
 * Save an identical batch: mints `quantity` unique `28…` labels in
 * carton_labels (unprinted). Never throws — a network error is `failed`.
 * `batchId` makes a retry of the same save idempotent server-side.
 */
export async function postIdenticalLabels(
  token: string,
  batchId: string,
  payload: IdenticalLabelPayload,
  fetchFn: typeof fetch = fetch,
): Promise<SaveLabelsResult> {
  try {
    const res = await fetchFn('/api/carton-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, batch_id: batchId, ...payload }),
    });
    if (res.status === 401) return { ok: false, reason: 'session' };
    const data = await res.json();
    const labels: CartonLabel[] = Array.isArray(data?.labels) ? data.labels : [];
    if (!data?.success || labels.length === 0) return { ok: false, reason: 'failed' };
    return { ok: true, labels };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

// ─── Q5: a New carton counted at its saved weight ───

/**
 * Q5 (client, 2026-10-13): a New carton saved on pallet-verify is counted at
 * once — through the same expansion as an identical batch — at the weight
 * the worker typed, before its label is printed. This is the sample row and
 * form `expandIdenticalBoxes` turns into one row per saved label. Null when
 * there is nothing to count: no label, or a label with no positive weight
 * (the bot books no box without a weight, so such a carton must not look
 * counted). One save = one form, so every label of the batch shares it.
 */
export function newCartonBatch(
  labels: ReadonlyArray<Pick<CartonLabel, 'barcode' | 'batch_id' | 'weight_kg' | 'expiry_date' | 'production_date' | 'item_name_hebrew' | 'item_name_english'>>,
): { sample: MultiPalletBoxScan; refs: MintedLabelRef[]; form: IdenticalForm } | null {
  if (labels.length === 0) return null;
  if (labels.some((l) => !(Number(l.weight_kg) > 0))) return null;
  const first = labels[0];
  return {
    sample: {
      // No supplier code: the carton has only the warehouse label.
      barcode: '',
      sku: '',
      item_name: first.item_name_english || '',
      item_name_hebrew: first.item_name_hebrew || '',
      weight: Number(first.weight_kg),
      expiry: first.expiry_date || '',
      production_date: first.production_date || '',
      scanned_at: new Date().toISOString(),
    },
    refs: labels.map((l) => ({ barcode: l.barcode, batch_id: l.batch_id })),
    form: {
      weight: Number(first.weight_kg),
      expiry: first.expiry_date || '',
      production_date: first.production_date || '',
      // The worker typed this weight in New carton.
      weight_confirmed: true,
    },
  };
}

/**
 * The rows `expandIdenticalBoxes` made for a New carton batch, as such: the
 * SKU is the label's own 13-digit prefix (what scanning the printed label
 * has always booked), no supplier code is stood in for, and `new_carton`
 * marks the row for the "label not printed" badge.
 */
export function asNewCartonRows<T extends { barcode: string; source_barcode?: string }>(
  rows: T[],
): Array<T & { new_carton: true }> {
  return rows.map((r) => ({
    ...r,
    sku: r.barcode.slice(0, 13),
    source_barcode: undefined,
    new_carton: true as const,
  }));
}

/**
 * The identical / "Different carton?" form asks for the TOTAL (19/10).
 *
 * It used to ask "how many MORE cartons carry this label". On IN264191356
 * David typed the invoice's 20 kebab cartons into it: 20 labels were saved
 * on top of the counted carton, 21 in all. Now he types how many there are
 * in total and the form shows what will happen ("19 will be added · 1
 * already on the list"); `listed` = the cartons of this kind already on the
 * list that stay on it. What is saved is the difference — never below 0,
 * and Save waits for at least 1.
 */
export function labelsToSave(total: number, listed: number): number {
  const t = Math.floor(Number(total) || 0);
  const l = Math.max(0, Math.floor(Number(listed) || 0));
  return Math.max(0, t - l);
}

/** A row's product code: the supplier code's first 13 digits — a minted row
 *  carries the code it stands in for; our own `28…` labels carry none. */
function supplierSku(row: { barcode: string; source_barcode?: string; minted?: boolean }): string {
  const code = row.minted ? row.source_barcode || '' : row.barcode;
  const sku = sourceSku(code);
  return sku.length === 13 && !isMintedLabelBarcode(code) ? sku : '';
}

/**
 * Soft check before "All boxes identical" / "Different carton?" copies a
 * carton: do the other cartons with this NAME on the list carry one product
 * code, and is this carton's own code a different one? Then the name may
 * belong to a neighbouring sticker (IN264191356: a meatball carton read as
 * 'קבב' (kebab) beside 7290004456856 kebab cartons, its own code
 * 2000097200258) — the form says so and lets him go on. Returns the others'
 * code, or null.
 */
export function groupSkuMismatch<T extends { barcode: string; source_barcode?: string; minted?: boolean }>(
  sample: T,
  rows: ReadonlyArray<T>,
  keyOf: (r: T) => string,
): string | null {
  const own = supplierSku(sample);
  if (!own) return null;
  const key = keyOf(sample);
  const others = new Set<string>();
  for (const r of rows) {
    if (r.barcode === sample.barcode || keyOf(r) !== key) continue;
    const sku = supplierSku(r);
    if (sku) others.add(sku);
  }
  if (others.size !== 1) return null;
  const [other] = [...others];
  return other === own ? null : other;
}
