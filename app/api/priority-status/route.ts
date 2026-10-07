import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redis';
import { supabase } from '@/lib/supabase';
import {
  derivePriorityStatus,
  summarizeExplain,
  summarizePushConfig,
  type PriorityExplain,
  type PriorityReceiptRow,
} from '@/lib/priority-status';
import type { MultiPalletSession } from '@/types';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/priority-status?token
 *
 * Where this session's delivery stands with the automatic Priority push, for
 * the all-done card's status row (components/terminal/PriorityPushStatus).
 * Read-only: nothing here sends, queues or retries anything — the push is the
 * DB trigger + pg_cron dispatcher's job, and the worker has no step in it.
 *
 * Reads (service role, server only):
 *   - deliveries.status / received_by_chat_id, users.env (Test users are
 *     never sent)                                           — ours
 *   - priority_push_outbox, priority_push_config (`select *`, so the route
 *     works before and after migration 2026-10-01-priority-push-autofire;
 *     the config's webhook URL is reduced to a boolean and never leaves
 *     this function)                                        — ours
 *   - priority_goods_receipts, delivery_po_links            — the client's,
 *     READ only
 *   - for a queued row while the push is on: priority_push_explain
 *     (delivery_id), the database's own answer to "what would plan() do
 *     with it" — hold_same_invoice and every other hold — the same function
 *     the bot reads (migration 2026-10-08-priority-push-02). STABLE, no writes.
 *
 * Answers {success, state, docno?, final?, reason?, codes?, office?} — see
 * lib/priority-status.ts. 401 when the token is not a live multi-pallet
 * session.
 */
export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    const raw = token ? await getRedisClient().get(`pallet:multi:${token}`) : null;
    if (!raw) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired session' },
        { status: 401, headers: NO_STORE },
      );
    }
    const session = (typeof raw === 'string' ? JSON.parse(raw) : raw) as MultiPalletSession;
    const receiptId = session.receipt_id || null;

    const configRead = supabase.from('priority_push_config').select('*').eq('id', 1).maybeSingle();

    if (!receiptId) {
      // The bot creates the delivery before the session; a session without
      // one has nothing that could be sent.
      const { data: config, error } = await configRead;
      if (error) throw new Error(`priority_push_config read failed: ${error.message}`);
      const status = derivePriorityStatus({
        deliveryStatus: null,
        testUser: false,
        config: summarizePushConfig(config as Record<string, unknown> | null),
        outbox: null,
        receipts: [],
        hasPoLink: null,
        now: new Date(),
      });
      return NextResponse.json({ success: true, ...status }, { headers: NO_STORE });
    }

    const [deliveryRes, outboxRes, receiptsRes, configRes, poRes] = await Promise.all([
      supabase.from('deliveries').select('status, received_by_chat_id').eq('id', receiptId).maybeSingle(),
      supabase.from('priority_push_outbox').select('*').eq('delivery_id', receiptId).maybeSingle(),
      supabase
        .from('priority_goods_receipts')
        .select('docno, origin, statdes, synced_at')
        .eq('delivery_id', receiptId)
        .order('synced_at', { ascending: false })
        .limit(5),
      configRead,
      supabase.from('delivery_po_links').select('id').eq('delivery_id', receiptId).limit(1),
    ]);

    if (deliveryRes.error) throw new Error(`deliveries read failed: ${deliveryRes.error.message}`);
    if (outboxRes.error) throw new Error(`priority_push_outbox read failed: ${outboxRes.error.message}`);
    if (receiptsRes.error) throw new Error(`priority_goods_receipts read failed: ${receiptsRes.error.message}`);
    if (configRes.error) throw new Error(`priority_push_config read failed: ${configRes.error.message}`);

    const delivery = deliveryRes.data as {
      status: string;
      received_by_chat_id: number | null;
    } | null;

    // Same gate as the enqueue trigger: the receiver's users.env. A chat id
    // can have more than one users row (Telegram-era duplicates).
    let testUser = false;
    if (delivery?.received_by_chat_id != null) {
      const { data: users, error } = await supabase
        .from('users')
        .select('env')
        .eq('chat_id', delivery.received_by_chat_id);
      if (error) throw new Error(`users read failed: ${error.message}`);
      testUser = (users ?? []).some((u: { env: string | null }) => u.env === 'Test');
    }

    const config = summarizePushConfig(configRes.data as Record<string, unknown> | null);
    const outbox = (outboxRes.data as Record<string, unknown> | null) ?? null;
    // Only a queued row on a live push can be held; skip the call otherwise.
    const explain = config.on && outbox?.status === 'queued' ? await readExplain(receiptId) : null;

    const status = derivePriorityStatus({
      deliveryStatus: delivery?.status ?? null,
      testUser,
      config,
      outbox,
      receipts: (receiptsRes.data ?? []) as PriorityReceiptRow[],
      // Only feeds the purchase-order grace; a failed read just skips that.
      hasPoLink: poRes.error ? null : (poRes.data ?? []).length > 0,
      explain,
      now: new Date(),
    });

    return NextResponse.json({ success: true, ...status }, { headers: NO_STORE });
  } catch (error) {
    console.error('[api/priority-status] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read the Priority status' },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * priority_push_explain(delivery_id) reduced to its decision. A failed call
 * (the function not applied yet, a transient error) answers null — the card
 * then shows only the holds the row's own columns prove, rather than guess.
 */
async function readExplain(receiptId: string): Promise<PriorityExplain | null> {
  const { data, error } = await supabase.rpc('priority_push_explain', { p_delivery_id: receiptId });
  if (error) {
    console.warn('[api/priority-status] priority_push_explain failed:', error.message);
    return null;
  }
  return summarizeExplain(data);
}
