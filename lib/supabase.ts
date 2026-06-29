/**
 * Server-only Supabase client + data-access helpers for issue / pallet flows.
 *
 * Replaces the former Airtable REST client. Every exported function keeps the SAME
 * name and SAME return shape the API routes destructure, so only the import
 * path changes at the call sites. The legacy Airtable display-name keys (e.g.
 * `'Box SKU'`, `'Quantity KG'`) are reconstructed from Postgres columns so the
 * routes that read `fields['...']` keep working unchanged.
 *
 * Uses the SERVICE-ROLE key, which bypasses RLS. This module must NEVER be
 * imported into client/browser code.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

/**
 * Lazily construct the service-role client. Deferring construction keeps
 * `next build` from throwing when the env vars are absent at build time —
 * the client is only ever instantiated on the first request that touches it.
 */
function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/**
 * Lazy proxy so `supabase.from(...)` / `supabase.rpc(...)` work exactly like a
 * normal client while the underlying `createClient` call is deferred until the
 * first property access (i.e. at request time, never at build time).
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client as object, prop);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

function todayISODate(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

/** Convert a chat id (stored as a string by the bot/session) to bigint or null. */
function toChatIdBigint(chatId: unknown): number | null {
  if (chatId === null || chatId === undefined || chatId === '') return null;
  const s = String(chatId).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find a box in box_inventory by barcode. Returns the legacy Airtable-shaped
 * record or null. `fields['Inventory Batch']` is a 1-element array of the
 * batch uuid (or empty array) so existing `inventoryBatchIds[0]` logic works.
 */
export async function findBoxByBarcode(barcode: string) {
  const { data, error } = await supabase
    .from('box_inventory')
    .select(
      'id, barcode, box_sku, box_weight, box_expiry, box_expiry_raw, status, invoice_number, inventory_batch_id, received_date, production_date, created_at'
    )
    .eq('barcode', barcode)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase findBoxByBarcode error: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return {
    record_id: data.id,
    fields: {
      Barcode: data.barcode,
      'Box SKU': data.box_sku,
      'Box Weight': data.box_weight,
      'Box Expiry': data.box_expiry ?? data.box_expiry_raw,
      Status: data.status,
      'Invoice Number': data.invoice_number,
      // CRITICAL: array of one id so `inventoryBatchIds[0]` keeps working.
      'Inventory Batch': data.inventory_batch_id ? [data.inventory_batch_id] : [],
      'Received Date': data.received_date,
      'Production Date': data.production_date,
    } as Record<string, any>,
    createdTime: data.created_at,
  };
}

/**
 * Get a stock_batches (inventory) record by id, mapped to legacy field keys.
 */
export async function getInventoryRecord(recordId: string) {
  const { data, error } = await supabase
    .from('stock_batches')
    .select(
      'id, item_code, item_name_english, item_name_hebrew, supplier_english, supplier_hebrew, quantity_kg'
    )
    .eq('id', recordId)
    .single();

  if (error) {
    throw new Error(`Supabase getInventoryRecord error: ${error.message}`);
  }

  return {
    record_id: data.id,
    fields: {
      'Item Code': data.item_code,
      'Item Name English': data.item_name_english,
      'Item Name Hebrew': data.item_name_hebrew,
      'Supplier English': data.supplier_english,
      'Supplier Hebrew': data.supplier_hebrew,
      'Quantity KG': data.quantity_kg,
    } as Record<string, any>,
  };
}

/**
 * Mark a box as issued: status -> 'Issued', issued_date -> today,
 * transaction_id -> the OUT transaction uuid.
 */
export async function issueBox(boxRecordId: string, transactionId: string) {
  const { data, error } = await supabase
    .from('box_inventory')
    .update({
      status: 'Issued',
      issued_date: todayISODate(),
      transaction_id: transactionId,
    })
    .eq('id', boxRecordId)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase issueBox error: ${error.message}`);
  }
  return data;
}

/**
 * Revert a box issue: status -> 'Available', clear issued_date + transaction_id.
 */
export async function revertBoxIssue(boxRecordId: string) {
  const { data, error } = await supabase
    .from('box_inventory')
    .update({
      status: 'Available',
      issued_date: null,
      transaction_id: null,
    })
    .eq('id', boxRecordId)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase revertBoxIssue error: ${error.message}`);
  }
  return data;
}

/**
 * Create an OUT transaction. Returns `{ transaction_id, fields }` where
 * `transaction_id` is the Postgres uuid.
 */
export async function createIssueTransaction(params: {
  itemCode: string;
  itemNameEnglish: string;
  itemNameHebrew: string;
  supplierEnglish: string;
  supplierHebrew: string;
  quantity: number;
  batchId: string;
  boxBarcode: string;
  chatId: string;
}) {
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      type: 'OUT',
      item_code: params.itemCode,
      item_name_english: params.itemNameEnglish,
      item_name_hebrew: params.itemNameHebrew,
      supplier_english: params.supplierEnglish,
      supplier_hebrew: params.supplierHebrew,
      quantity_kg: params.quantity,
      document_number: `ISSUE-${params.boxBarcode.slice(0, 8)}`,
      chat_id: toChatIdBigint(params.chatId),
      // batch_id is a real FK; '' (no batch) must become NULL, not an empty uuid.
      batch_id: params.batchId || null,
      is_undone: false,
      box_barcode: params.boxBarcode,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase createIssueTransaction error: ${error.message}`);
  }

  return {
    transaction_id: data.id as string,
    fields: data,
  };
}

/**
 * Decrement a stock batch's quantity_kg by `quantityToSubtract`.
 * Read-modify-write (callers run this under a session lock).
 */
export async function updateInventoryQuantity(
  batchId: string,
  quantityToSubtract: number
) {
  const { data: current, error: readError } = await supabase
    .from('stock_batches')
    .select('quantity_kg')
    .eq('id', batchId)
    .single();

  if (readError) {
    throw new Error(`Supabase updateInventoryQuantity read error: ${readError.message}`);
  }

  const currentQty = Number(current.quantity_kg) || 0;
  const newQty = currentQty - quantityToSubtract;

  const { data, error } = await supabase
    .from('stock_batches')
    .update({ quantity_kg: newQty })
    .eq('id', batchId)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase updateInventoryQuantity error: ${error.message}`);
  }

  return {
    previous_quantity: currentQty,
    new_quantity: newQty,
    fields: data,
  };
}
