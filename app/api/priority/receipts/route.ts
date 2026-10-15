import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireReceiptsAdmin } from '@/lib/receipts-auth';
import { signAdminLink } from '@/lib/admin-link';
import {
  WINDOW_DAYS,
  deriveReceiptState,
  needsAttention,
  normalizeCategory,
  type GrInput,
  type OutboxInput,
  type ReceiptRow,
} from '@/lib/priority-receipts';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** More deliveries than this in 14 days means something else is wrong; the page says so. */
const MAX_DELIVERIES = 400;

/** The per-row "needs attention" link lives this long (the attention page accepts ≤ 7 days). */
const ATTENTION_TTL_S = 24 * 3600;

interface DeliveryDb {
  id: string;
  document_number: string | null;
  supplier_hebrew: string | null;
  supplier_english: string | null;
  received_by: string | null;
  received_by_chat_id: number | string | null;
  status: string | null;
  created_at: string | null;
  purchase_order_number: string | null;
}

/** supabase-js `.in()` on a long id list: split so the URL stays short. */
async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await read(ids.slice(i, i + 100))));
  return out;
}

/**
 * GET /api/priority/receipts?u=<users.id>&sig=<hex>
 *
 * Every delivery of the last 14 days, newest first, with where it stands in
 * Priority: deliveries ⨝ priority_push_outbox ⨝ priority_goods_receipts,
 * plus the line count (delivery_items), the receiver's nickname (users) and
 * the category (outbox, else pallets, else the invoice OCR — the same order
 * as our priority_push_delivery_category). Read-only. Reads
 * priority_push_outbox with `*` so priority_push_outbox.partial_docno is
 * picked up once it exists and simply absent before.
 *
 * Access: the fixed receipts link (lib/receipts-link.ts) AND users.id is an
 * active Admin (lib/receipts-auth.ts). 401 = not our link, 403 = not an
 * active admin. Rows that need a person carry a fresh 24 h link to
 * /priority/attention, signed here for that admin's chat id.
 *
 * Answers {success, rows, truncated, attention_link}.
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const auth = await requireReceiptsAdmin({ u: p.get('u'), sig: p.get('sig') });
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers: NO_STORE });
    }

    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const dRes = await supabase
      .from('deliveries')
      .select(
        'id, document_number, supplier_hebrew, supplier_english, received_by, received_by_chat_id, status, created_at, purchase_order_number',
      )
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_DELIVERIES + 1);
    if (dRes.error) throw new Error(`deliveries read failed: ${dRes.error.message}`);
    const all = (dRes.data ?? []) as DeliveryDb[];
    const deliveries = all.slice(0, MAX_DELIVERIES);
    const ids = deliveries.map((d) => d.id);

    const [outboxRows, grRows, itemRows, palletRows, ocrRows] = await Promise.all([
      inChunks(ids, async (c) => {
        const r = await supabase.from('priority_push_outbox').select('*').in('delivery_id', c);
        if (r.error) throw new Error(`priority_push_outbox read failed: ${r.error.message}`);
        return (r.data ?? []) as (OutboxInput & { delivery_id: string })[];
      }),
      inChunks(ids, async (c) => {
        const r = await supabase
          .from('priority_goods_receipts')
          .select('delivery_id, docno, statdes, synced_at')
          .in('delivery_id', c)
          .order('synced_at', { ascending: false });
        if (r.error) throw new Error(`priority_goods_receipts read failed: ${r.error.message}`);
        return (r.data ?? []) as (GrInput & { delivery_id: string })[];
      }),
      inChunks(ids, async (c) => {
        const r = await supabase.from('delivery_items').select('receipt_id').in('receipt_id', c).limit(10000);
        if (r.error) throw new Error(`delivery_items read failed: ${r.error.message}`);
        return (r.data ?? []) as { receipt_id: string }[];
      }),
      inChunks(ids, async (c) => {
        const r = await supabase.from('pallets').select('receipt_id, category').in('receipt_id', c).limit(10000);
        // the category is a nicety: a read error only leaves it blank
        if (r.error) console.warn('[api/priority/receipts] pallets not readable:', r.error.message);
        return (r.data ?? []) as { receipt_id: string; category: string | null }[];
      }),
      inChunks(ids, async (c) => {
        const r = await supabase
          .from('invoice_ocr_results')
          .select('delivery_id, category, created_at')
          .in('delivery_id', c)
          .order('created_at', { ascending: false });
        if (r.error) console.warn('[api/priority/receipts] invoice_ocr_results not readable:', r.error.message);
        return (r.data ?? []) as { delivery_id: string; category: string | null }[];
      }),
    ]);

    // one outbox row per delivery today; keep the newest if that ever changes
    const outboxBy = new Map<string, OutboxInput>();
    for (const o of outboxRows) {
      const prev = outboxBy.get(o.delivery_id);
      if (!prev || o.id > prev.id) outboxBy.set(o.delivery_id, o);
    }
    const grBy = new Map<string, GrInput>();
    for (const g of grRows) if (!grBy.has(g.delivery_id)) grBy.set(g.delivery_id, g);
    const linesBy = new Map<string, number>();
    for (const it of itemRows) linesBy.set(it.receipt_id, (linesBy.get(it.receipt_id) ?? 0) + 1);
    // pallets: meat wins (priority_push_delivery_category orders meat first)
    const palletCat = new Map<string, string>();
    for (const pl of palletRows) {
      const cat = normalizeCategory(pl.category);
      if (cat && (cat === 'meat' || !palletCat.has(pl.receipt_id))) palletCat.set(pl.receipt_id, cat);
    }
    const ocrCat = new Map<string, string>();
    for (const o of ocrRows) {
      const cat = normalizeCategory(o.category);
      if (cat && !ocrCat.has(o.delivery_id)) ocrCat.set(o.delivery_id, cat);
    }

    // receivers' nicknames, by users.id and (Telegram-era rows) by chat id
    const userIds = [...new Set(deliveries.map((d) => d.received_by).filter((v): v is string => Boolean(v)))];
    const chatIds = [
      ...new Set(
        deliveries.filter((d) => !d.received_by && d.received_by_chat_id != null).map((d) => String(d.received_by_chat_id)),
      ),
    ];
    const names = new Map<string, string>();
    const tests = new Set<string>();
    if (userIds.length || chatIds.length) {
      const [byId, byChat] = await Promise.all([
        userIds.length
          ? supabase.from('users').select('id, nickname, env').in('id', userIds)
          : Promise.resolve({ data: [], error: null }),
        chatIds.length
          ? supabase.from('users').select('chat_id, nickname, env').in('chat_id', chatIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      for (const u of (byId.data ?? []) as { id: string; nickname: string | null; env: string | null }[]) {
        if (u.nickname) names.set(`id:${u.id}`, u.nickname);
        if (u.env === 'Test') tests.add(`id:${u.id}`);
      }
      for (const u of (byChat.data ?? []) as { chat_id: number | string; nickname: string | null; env: string | null }[]) {
        if (u.nickname && !names.has(`chat:${u.chat_id}`)) names.set(`chat:${u.chat_id}`, u.nickname);
        if (u.env === 'Test') tests.add(`chat:${u.chat_id}`);
      }
    }

    const rows: ReceiptRow[] = deliveries.map((d) => {
      const outbox = outboxBy.get(d.id) ?? null;
      const derived = deriveReceiptState({ delivery_status: d.status, outbox, gr: grBy.get(d.id) ?? null });
      const userKey = d.received_by ? `id:${d.received_by}` : d.received_by_chat_id != null ? `chat:${d.received_by_chat_id}` : '';
      const isTest = derived.is_test || tests.has(userKey);
      return {
        delivery_id: d.id,
        created_at: d.created_at,
        supplier: d.supplier_hebrew || d.supplier_english || null,
        document_number: d.document_number,
        category:
          normalizeCategory(outbox?.category) ??
          normalizeCategory(palletCat.get(d.id)) ??
          normalizeCategory(ocrCat.get(d.id)),
        worker: names.get(userKey) ?? null,
        state: derived.state,
        reason: derived.reason,
        priority_error: derived.priority_error,
        gr_docno: derived.gr_docno,
        gr_status: derived.gr_status,
        partial_docno: derived.partial_docno,
        line_count: linesBy.get(d.id) ?? 0,
        po_number: d.purchase_order_number || null,
        outbox_id: outbox?.id ?? null,
        is_test: isTest,
        attention: needsAttention(derived.state, isTest),
      };
    });

    // One fresh 24 h needs-attention link for this admin, when the admin has a chat id
    // (the attention page is keyed by chat id). Never a raw chat id in the JSON otherwise.
    let attention_link: string | null = null;
    const secret = (process.env.ADMIN_LINK_SECRET ?? '').trim();
    if (auth.chatId && /^\d{5,20}$/.test(auth.chatId) && secret) {
      const exp = String(Math.floor(Date.now() / 1000) + ATTENTION_TTL_S);
      const q = new URLSearchParams({ u: auth.chatId, exp, sig: signAdminLink(auth.chatId, exp, secret) });
      attention_link = `/priority/attention?${q.toString()}`;
    }

    return NextResponse.json(
      { success: true, rows, truncated: all.length > MAX_DELIVERIES, attention_link },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[api/priority/receipts] GET error:', error);
    return NextResponse.json({ success: false, error: 'read_failed' }, { status: 500, headers: NO_STORE });
  }
}
