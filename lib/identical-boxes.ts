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

import type { MultiPalletBoxScan } from '@/types';

/** What the confirmation form settles for the whole batch. */
export interface IdenticalForm {
  weight: number;
  /** As the OCR/edit panel stores it (`YYYY-MM-DD`, or '' when unknown). */
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
};

/**
 * One row per minted label. Every row carries the product identity of the
 * sample and the form's weight/dates; the sticker photo (`image_data`) stays
 * on the first row only (it is the same picture N times over, and it is
 * large), while the uploaded `image_url` is kept on all of them so each
 * box_inventory row still points at the sticker it was booked from.
 */
export type MintedRow<T> = T & { minted: true; label_batch_id: string };

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
  }));
}
