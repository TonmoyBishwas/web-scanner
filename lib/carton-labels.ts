/**
 * Server-side data layer for warehouse-minted carton stickers (New Carton /
 * צור קרטון) and the Labels screen that prints them.
 *
 * Deliberately isolated from the receiving flow: creating a label books NO
 * stock and touches no delivery, pallet or box table. The worker prints the
 * sticker, puts it on the unlabelled carton, and scans it through the normal
 * inbound path — which is why every label carries a real, scannable barcode.
 *
 * Service-role client (see lib/supabase.ts) — server only.
 */
import { supabase } from './supabase';
import type { CartonLabel, LabelSize } from '@/types';

export type { CartonLabel, LabelSize };

export const LABEL_SIZES: LabelSize[] = ['10x10', '10x15', 'a4'];

/** Every column the UI and the print sheet read. */
const COLUMNS =
  'id, batch_id, barcode, serial, session_token, document_number, item_code, item_name_hebrew, item_name_english, weight_kg, quantity, production_date, expiry_date, notes, print_barcode, label_size, status, print_count, printed_at, created_at';

function yymmdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Mint a scannable 16-digit barcode: `28` + YYMMDD + 8 random digits.
 *
 * GS1 reserves prefixes 20–29 for internal / restricted distribution, so a
 * minted code can never collide with a supplier GTIN — and it is still plain
 * digits, which is what the outbound box-sticker gateway looks for when it
 * decides a photo is a box rather than a pallet LPN.
 */
export function mintCartonBarcode(now = new Date()): string {
  let tail = '';
  for (let i = 0; i < 8; i++) tail += Math.floor(Math.random() * 10);
  return `28${yymmdd(now)}${tail}`;
}

/** Human-readable serial printed under the item name, e.g. C-260903-4F2A. */
export function mintCartonSerial(now = new Date()): string {
  let tail = '';
  for (let i = 0; i < 4; i++) tail += '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 34)];
  return `C-${yymmdd(now)}-${tail}`;
}

export interface CreateCartonBatchInput {
  sessionToken: string;
  documentNumber?: string | null;
  itemCode?: string | null;
  itemNameHebrew?: string | null;
  itemNameEnglish?: string | null;
  weightKg?: number | null;
  quantity: number;
  productionDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  printBarcode: boolean;
  labelSize: LabelSize;
  createdByChatId?: number | null;
}

/**
 * Create one row per physical carton.
 *
 * One row per box, not one row with a count, because the inbound scan path
 * dedupes on the barcode — five cartons sharing a code would be read as one
 * box scanned five times. `batch_id` keeps them together for the Labels list.
 */
export async function createCartonBatch(input: CreateCartonBatchInput): Promise<CartonLabel[]> {
  const quantity = Math.min(Math.max(Math.round(input.quantity), 1), 500);

  // One retry covers the astronomically unlikely barcode/serial collision;
  // the unique indexes are what actually guarantee it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    const batchId = crypto.randomUUID();
    const rows = Array.from({ length: quantity }, () => ({
      batch_id: batchId,
      barcode: mintCartonBarcode(now),
      serial: mintCartonSerial(now),
      session_token: input.sessionToken,
      document_number: input.documentNumber ?? null,
      item_code: input.itemCode ?? null,
      item_name_hebrew: input.itemNameHebrew ?? null,
      item_name_english: input.itemNameEnglish ?? null,
      weight_kg: input.weightKg ?? null,
      quantity,
      production_date: input.productionDate || null,
      expiry_date: input.expiryDate || null,
      notes: input.notes || null,
      print_barcode: input.printBarcode,
      label_size: input.labelSize,
      created_by_chat_id: input.createdByChatId ?? null,
    }));

    const { data, error } = await supabase.from('carton_labels').insert(rows).select(COLUMNS);
    if (!error) return (data ?? []) as unknown as CartonLabel[];
    if (error.code !== '23505' || attempt === 1) {
      throw new Error(`carton_labels insert failed: ${error.message}`);
    }
  }
  return [];
}

export interface ListCartonLabelsOptions {
  /**
   * Restrict to the stickers minted by ONE scanner session. This is the
   * default view: a worker opening the Labels screen must see the job in front
   * of them, not yesterday's. Re-scanning the same invoice creates a new
   * session, so scoping by delivery is not enough — it would resurrect the
   * previous run's stickers under the same document number.
   */
  sessionToken?: string | null;
  /** Restrict to one delivery, across sessions. */
  documentNumber?: string | null;
  status?: 'created' | 'printed' | 'all';
  limit?: number;
}

export async function listCartonLabels(opts: ListCartonLabelsOptions = {}): Promise<CartonLabel[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);

  let query = supabase
    .from('carton_labels')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (opts.sessionToken) query = query.eq('session_token', opts.sessionToken);
  if (opts.documentNumber) query = query.eq('document_number', opts.documentNumber);
  if (opts.status && opts.status !== 'all') query = query.eq('status', opts.status);

  const { data, error } = await query;
  if (error) throw new Error(`carton_labels read failed: ${error.message}`);
  return (data ?? []) as unknown as CartonLabel[];
}

export async function getCartonLabelsByIds(ids: string[]): Promise<CartonLabel[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('carton_labels')
    .select(COLUMNS)
    .in('id', ids.slice(0, 1000))
    .order('created_at', { ascending: true });
  if (error) throw new Error(`carton_labels read failed: ${error.message}`);
  return (data ?? []) as unknown as CartonLabel[];
}

export async function getCartonLabelsByBatches(batchIds: string[]): Promise<CartonLabel[]> {
  if (!batchIds.length) return [];
  const { data, error } = await supabase
    .from('carton_labels')
    .select(COLUMNS)
    .in('batch_id', batchIds.slice(0, 200))
    .order('created_at', { ascending: true })
    .order('serial', { ascending: true });
  if (error) throw new Error(`carton_labels read failed: ${error.message}`);
  return (data ?? []) as unknown as CartonLabel[];
}

/**
 * Flag labels as printed and bump their print count.
 *
 * Called when the worker hands the sheet to the browser's print dialog. The
 * browser never reports back whether paper actually came out, so this records
 * "sent to the printer" — a reprint simply increments the count again.
 */
export async function markCartonLabelsPrinted(ids: string[], labelSize?: LabelSize): Promise<number> {
  if (!ids.length) return 0;

  const existing = await getCartonLabelsByIds(ids);
  if (!existing.length) return 0;

  const printedAt = new Date().toISOString();
  let updated = 0;
  // print_count is per-row, so each row needs its own increment.
  for (const label of existing) {
    const { error } = await supabase
      .from('carton_labels')
      .update({
        status: 'printed',
        printed_at: printedAt,
        print_count: label.print_count + 1,
        ...(labelSize ? { label_size: labelSize } : null),
      })
      .eq('id', label.id);
    if (error) throw new Error(`carton_labels update failed: ${error.message}`);
    updated++;
  }
  return updated;
}

/** Delete a whole batch — the undo for a mis-typed New Carton submission. */
export async function deleteCartonBatch(batchId: string): Promise<number> {
  const { data, error } = await supabase
    .from('carton_labels')
    .delete()
    .eq('batch_id', batchId)
    .select('id');
  if (error) throw new Error(`carton_labels delete failed: ${error.message}`);
  return (data ?? []).length;
}
