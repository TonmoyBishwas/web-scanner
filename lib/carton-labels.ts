/**
 * Server-side data layer for warehouse-minted carton labels (New Carton /
 * צור קרטון, "all boxes identical", the edit panel's new barcode) and the
 * Labels screen that prints them.
 *
 * Writes only `carton_labels`: creating a label books no stock and touches no
 * delivery, pallet or box table. A New carton label is scanned in through the
 * normal inbound path; an identical / receiving label stands for a scan row
 * the page already holds, which the completion route books like any other.
 * Labels are SAVED first and printed later — `status` stays 'created' until
 * the print sheet (or the worker's "Mark as printed") flips it.
 *
 * Service-role client (see lib/supabase.ts) — server only.
 */
import { supabase } from './supabase';
import { sessionBookedBarcodes } from './label-batches';
import type { CartonLabel, CartonLabelOrigin, LabelSize } from '@/types';

export type { CartonLabel, LabelSize };

export const LABEL_SIZES: LabelSize[] = ['10x10', '10x15', 'a4'];

/** Every column the UI and the print sheet read. */
const COLUMNS =
  'id, batch_id, barcode, serial, session_token, document_number, item_code, item_name_hebrew, item_name_english, weight_kg, quantity, production_date, expiry_date, notes, print_barcode, label_size, status, print_count, printed_at, created_at, origin, source_barcode, pallet_number';

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
  /** Default `new_carton`. `identical` / `receiving` = booked as stock by pallet-verify. */
  origin?: CartonLabelOrigin;
  sourceBarcode?: string | null;
  palletNumber?: number | null;
  /**
   * The client's id for this save (a UUID, made once per form open). A retry
   * after a lost response sends the same one and gets the SAME batch back
   * instead of a second set of labels.
   */
  batchId?: string | null;
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

  // Idempotent retry: this session already saved this batch → hand it back.
  // A batch id already used by ANOTHER session is never joined (it would mix
  // two jobs' labels in one batch); that save simply gets a fresh id.
  let batchId = input.batchId || crypto.randomUUID();
  if (input.batchId) {
    const existing = await getCartonLabelsByBatches([input.batchId]);
    if (existing.length) {
      if (existing.every(l => l.session_token === input.sessionToken)) return existing;
      batchId = crypto.randomUUID();
    }
  }

  // One retry covers the astronomically unlikely barcode/serial collision;
  // the unique indexes are what actually guarantee it. The batch id is kept
  // across it, so the client's retry key still finds the batch.
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
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
      origin: input.origin ?? 'new_carton',
      source_barcode: input.sourceBarcode ?? null,
      pallet_number: input.palletNumber ?? null,
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
 * Called by the print sheet itself, for exactly the labels it rendered, just
 * before it opens the print dialog — or by the worker's "Mark as printed" in
 * Labels. The browser never reports back whether paper actually came out, so
 * this records "sent to the printer"; a reprint simply increments the count
 * again and never un-prints a label.
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

export interface DeletedBatch {
  deleted: number;
  /** The barcodes that went — the page drops their rows from its lists. */
  barcodes: string[];
  /** The supplier barcode an identical batch stood in for, when there was one. */
  sourceBarcode: string | null;
}

/** Delete a whole batch — the undo for a mis-typed submission. */
export async function deleteCartonBatch(batchId: string): Promise<DeletedBatch> {
  const { data, error } = await supabase
    .from('carton_labels')
    .delete()
    .eq('batch_id', batchId)
    .select('id, barcode, source_barcode');
  if (error) throw new Error(`carton_labels delete failed: ${error.message}`);
  const rows = (data ?? []) as { id: string; barcode: string; source_barcode: string | null }[];
  return {
    deleted: rows.length,
    barcodes: rows.map(r => r.barcode),
    sourceBarcode: rows.find(r => r.source_barcode)?.source_barcode ?? null,
  };
}

/**
 * True when any carton of the batch is already booked on an LPN. Such labels
 * are on a box in the warehouse: they can be reprinted, never deleted —
 * deleting would leave a box whose sticker the ledger forgot.
 *
 * Two places say "booked", and either one is enough:
 *  1. The scanner session the batch was saved in. The completion routes write
 *     every booked carton barcode into it (`completed_pallets[].barcodes`,
 *     `loose_barcodes`) before they answer the page, so it is true the moment
 *     the LPN exists.
 *  2. box_inventory. The bot writes it from a webhook sent AFTER that answer —
 *     seconds later, or never if the call fails — so on its own it would let
 *     a just-booked batch be deleted in that gap.
 * The session row is read whatever its expiry: an old batch falls through to
 * box_inventory, which the bot has long since written by then.
 */
export async function batchHasBookedBoxes(batchId: string): Promise<boolean> {
  const labels = await getCartonLabelsByBatches([batchId]);
  if (!labels.length) return false;
  const barcodes = labels.map(l => l.barcode);

  const tokens = [...new Set(labels.map(l => l.session_token).filter((t): t is string => !!t))];
  if (tokens.length) {
    const { data: sessions, error: sessionError } = await supabase
      .from('scan_sessions')
      .select('data')
      .in('token', tokens);
    if (sessionError) throw new Error(`scan_sessions read failed: ${sessionError.message}`);
    for (const row of sessions ?? []) {
      const booked = sessionBookedBarcodes((row as { data: unknown }).data);
      if (barcodes.some(code => booked.has(code))) return true;
    }
  }

  const { data, error } = await supabase
    .from('box_inventory')
    .select('id')
    .in('barcode', barcodes)
    .limit(1);
  if (error) throw new Error(`box_inventory read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Delete ONE label whose scan row the worker just removed from the list — so
 * an "all boxes identical" or edit-panel label does not linger as an orphan
 * (batch 0877ca78). Only while it is still unprinted (a printed sticker
 * exists on paper, so its ledger row stays), only in this session, and never
 * a New carton label: that one exists for itself, and removing its scan row
 * just un-scans the carton.
 */
export async function deleteUnprintedLabelByBarcode(sessionToken: string, barcode: string): Promise<number> {
  const { data, error } = await supabase
    .from('carton_labels')
    .delete()
    .eq('barcode', barcode)
    .eq('session_token', sessionToken)
    .eq('status', 'created')
    .neq('origin', 'new_carton')
    .select('id');
  if (error) throw new Error(`carton_labels delete failed: ${error.message}`);
  return (data ?? []).length;
}
