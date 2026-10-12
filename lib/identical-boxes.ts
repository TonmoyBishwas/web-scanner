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

/** What the confirmation form settles for the whole batch. */
export interface IdenticalForm {
  weight: number;
  /** ISO `YYYY-MM-DD` like every scan row ('' when unknown) — see lib/expiry.ts. */
  expiry: string;
  production_date: string;
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
    minted: true as const,
    label_batch_id: label.batch_id,
    source_barcode: sample.barcode,
  }));
}

/** The fields the dedup bookkeeping below reads off a list row. */
type ListedRow = { barcode: string; source_barcode?: string };

/**
 * Every code a list's rows hold in the page's dedup set: each row's own
 * barcode, plus the supplier code a minted row stands in for. Used to refill
 * the set from the browser cache after a reload, so a re-read of the sample
 * carton is still caught exactly as it was before the reload.
 */
export function dedupCodes(rows: ReadonlyArray<ListedRow>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.barcode) out.add(r.barcode);
    if (r.source_barcode) out.add(r.source_barcode);
  }
  return [...out];
}

/** True while some row on the list is, or stands in for, this supplier code. */
export function sourceStillListed(rows: ReadonlyArray<ListedRow>, source: string): boolean {
  return rows.some((r) => r.barcode === source || r.source_barcode === source);
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
}

/**
 * The body fields of POST /api/carton-labels for an `identical` batch — the
 * exact shape IdenticalBoxesForm has always sent. Also the key
 * `batchIdForPayload` hashes, so it must stay a plain, stable object.
 */
export function identicalLabelPayload(req: IdenticalLabelRequest) {
  return {
    origin: 'identical' as const,
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
