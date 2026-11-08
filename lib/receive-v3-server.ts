/**
 * The receive form v3's extra server data (flag receive_form_v3) — server
 * only (the service-role client). Called ONLY when the flag is on for the
 * form, so a flag-off page does no extra query. Every read is a SELECT;
 * nothing here writes. The client's tables (priority_goods_receipts,
 * delivery_po_links) are read only.
 *
 *   loadV3Boot(row)   → the note photos, the tenant's ERP, the bot's WhatsApp
 *                       number (env BOT_WA_NUMBER) and today in Israel.
 *   readV3Status(row) → the status screen's outcome (lib/receive-v3-status.ts)
 *                       for GET /api/receipt-form/{id}/status.
 */
import { supabase } from '@/lib/supabase';
import { todayInJerusalem } from '@/lib/receipt-form';
import {
  derivePriorityStatus,
  summarizeExplain,
  summarizePushConfig,
  type PriorityExplain,
  type PriorityReceiptRow,
  type PriorityStatus,
} from '@/lib/priority-status';
import { erpOf, v3Outcome } from '@/lib/receive-v3-status';
import type { ReceiveV3Boot, V3Erp, V3StatusResponse } from '@/lib/receive-v3';
import type { FormRow } from '@/lib/receipt-form-server';

/** BOT_WA_NUMBER → digits only (no '+', spaces or dashes); empty → null. Never logged. */
export function botWaNumberOf(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d ? d : null;
}

/**
 * The note photo URLs, de-duplicated, in order (the delivery's own photo
 * first, then the OCR pages), keeping only https URLs on the project's own
 * Supabase origin — a public storage bucket, never a foreign host.
 */
export function notePhotoUrls(urls: unknown[], supabaseUrl: string | null | undefined): string[] {
  let origin: string | null = null;
  try {
    origin = supabaseUrl ? new URL(supabaseUrl).origin : null;
  } catch {
    origin = null;
  }
  if (!origin) return [];
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== 'string' || !u.trim()) continue;
    let url: URL;
    try {
      url = new URL(u.trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.origin !== origin) continue;
    const href = url.href;
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

interface DeliveryBits {
  invoice_image_url?: unknown;
  tenant_id?: unknown;
  status?: unknown;
  received_by_chat_id?: unknown;
}

/** tenants.erp of the delivery's tenant; 'priority' on a missing delivery / tenant or any error. */
async function erpForTenant(tenantId: unknown): Promise<V3Erp> {
  if (tenantId === null || tenantId === undefined || String(tenantId).trim() === '') return 'priority';
  try {
    const { data, error } = await supabase.from('tenants').select('erp').eq('id', String(tenantId)).maybeSingle();
    if (error || !data) return 'priority';
    return erpOf((data as { erp?: unknown }).erp);
  } catch {
    return 'priority';
  }
}

async function readDelivery(deliveryId: string | null, columns: string): Promise<DeliveryBits | null> {
  if (!deliveryId) return null;
  try {
    const { data, error } = await supabase.from('deliveries').select(columns).eq('id', deliveryId).maybeSingle();
    if (error || !data) return null;
    return data as DeliveryBits;
  } catch {
    return null;
  }
}

async function readNotePhotos(deliveryId: string | null, main: unknown): Promise<string[]> {
  const urls: unknown[] = [main];
  if (deliveryId) {
    try {
      const { data, error } = await supabase
        .from('invoice_ocr_results')
        .select('invoice_image_url, created_at')
        .eq('delivery_id', deliveryId)
        .order('created_at', { ascending: true });
      if (!error && Array.isArray(data)) for (const r of data) urls.push((r as { invoice_image_url?: unknown }).invoice_image_url);
    } catch {
      // the delivery's own photo alone
    }
  }
  return notePhotoUrls(urls, process.env.SUPABASE_URL);
}

/** Everything the v3 page needs besides the form row. Never throws. */
export async function loadV3Boot(row: Pick<FormRow, 'delivery_id'>): Promise<ReceiveV3Boot> {
  const delivery = await readDelivery(row.delivery_id, 'invoice_image_url, tenant_id');
  const [notePhotos, erp] = await Promise.all([
    readNotePhotos(row.delivery_id, delivery?.invoice_image_url).catch(() => [] as string[]),
    delivery ? erpForTenant(delivery.tenant_id) : Promise.resolve<V3Erp>('priority'),
  ]);
  return {
    notePhotos,
    erp,
    botWaNumber: botWaNumberOf(process.env.BOT_WA_NUMBER),
    today: todayInJerusalem(),
  };
}

/** priority_push_explain(delivery_id) reduced to its decision; null on any failure (as /api/priority-status). */
async function readExplain(deliveryId: string): Promise<PriorityExplain | null> {
  try {
    const { data, error } = await supabase.rpc('priority_push_explain', { p_delivery_id: deliveryId });
    if (error) return null;
    return summarizeExplain(data);
  } catch {
    return null;
  }
}

/**
 * Where the delivery stands with Priority — the reads and the logic of GET
 * /api/priority-status (that route is not touched), keyed by the form's
 * delivery instead of a scanner session. Throws on a failed read.
 */
async function readPriority(deliveryId: string, delivery: DeliveryBits | null): Promise<{ status: PriorityStatus; outbox: Record<string, unknown> | null }> {
  const [outboxRes, receiptsRes, configRes, poRes] = await Promise.all([
    supabase.from('priority_push_outbox').select('*').eq('delivery_id', deliveryId).maybeSingle(),
    supabase
      .from('priority_goods_receipts')
      .select('docno, origin, statdes, synced_at')
      .eq('delivery_id', deliveryId)
      .order('synced_at', { ascending: false })
      .limit(5),
    supabase.from('priority_push_config').select('*').eq('id', 1).maybeSingle(),
    supabase.from('delivery_po_links').select('id').eq('delivery_id', deliveryId).limit(1),
  ]);
  if (outboxRes.error) throw new Error(`priority_push_outbox read failed: ${outboxRes.error.message}`);
  if (receiptsRes.error) throw new Error(`priority_goods_receipts read failed: ${receiptsRes.error.message}`);
  if (configRes.error) throw new Error(`priority_push_config read failed: ${configRes.error.message}`);

  // Same gate as the enqueue trigger: the receiver's users.env (Test users are never sent).
  let testUser = false;
  const chat = delivery?.received_by_chat_id;
  if (chat !== null && chat !== undefined) {
    const { data: users, error } = await supabase.from('users').select('env').eq('chat_id', chat);
    if (error) throw new Error(`users read failed: ${error.message}`);
    testUser = ((users ?? []) as { env: string | null }[]).some((u) => u.env === 'Test');
  }

  const config = summarizePushConfig(configRes.data as Record<string, unknown> | null);
  const outbox = (outboxRes.data as Record<string, unknown> | null) ?? null;
  const explain = config.on && outbox?.status === 'queued' ? await readExplain(deliveryId) : null;
  const status = derivePriorityStatus({
    deliveryStatus: typeof delivery?.status === 'string' ? delivery.status : null,
    testUser,
    config,
    outbox,
    receipts: (receiptsRes.data ?? []) as PriorityReceiptRow[],
    hasPoLink: poRes.error ? null : (poRes.data ?? []).length > 0,
    explain,
    now: new Date(),
  });
  return { status, outbox };
}

/** The status screen's answer for this form (GET /api/receipt-form/{id}/status). Throws on a failed read. */
export async function readV3Status(row: Pick<FormRow, 'id' | 'status' | 'delivery_id'>): Promise<V3StatusResponse> {
  const { data: times, error: timesErr } = await supabase
    .from('receipt_forms')
    .select('submitted_at, done_at')
    .eq('id', row.id)
    .maybeSingle();
  if (timesErr) throw new Error(`receipt_forms read failed: ${timesErr.message}`);
  const submittedAt = typeof times?.submitted_at === 'string' ? times.submitted_at : null;

  const delivery = await readDelivery(row.delivery_id, 'status, received_by_chat_id, tenant_id');
  const erp: V3Erp = delivery ? await erpForTenant(delivery.tenant_id) : 'priority';

  let priority: PriorityStatus | null = null;
  let outbox: Record<string, unknown> | null = null;
  if (erp === 'priority' && row.status === 'done' && row.delivery_id) {
    const p = await readPriority(row.delivery_id, delivery);
    priority = p.status;
    outbox = p.outbox;
  }
  const res = v3Outcome({ erp, formStatus: row.status, priority, outbox, submittedAt, now: new Date() });
  return { ok: true, erp, form_status: row.status, ...res, submitted_at: submittedAt };
}
