import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redis';
import { supabase } from '@/lib/supabase';
import {
  derivePriorityStatus,
  heldBySameNote,
  summarizePushConfig,
  SAME_NOTE_WINDOW_MS,
  type PriorityReceiptRow,
  type SameNoteOutboxRow,
  type SameNoteReceipt,
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
 *   - for a queued row while the push is on: the other deliveries with the
 *     same document_number, their outbox rows, and Priority receipts with
 *     that BOOKNUM — plan()'s hold_same_invoice (sameNoteHeld below)
 *
 * Answers {success, state, docno?, final?, reason?, codes?} — see
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
      supabase.from('deliveries').select('status, received_by_chat_id, document_number, created_at').eq('id', receiptId).maybeSingle(),
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
      document_number: string | null;
      created_at: string | null;
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
    // Only a queued row on a live push can be held by it; skip the reads otherwise.
    const sameNote = config.on && outbox?.status === 'queued' && delivery
      ? await sameNoteHeld(receiptId, outbox, delivery)
      : null;

    const status = derivePriorityStatus({
      deliveryStatus: delivery?.status ?? null,
      testUser,
      config,
      outbox,
      receipts: (receiptsRes.data ?? []) as PriorityReceiptRow[],
      // Only feeds the purchase-order grace; a failed read just skips that.
      hasPoLink: poRes.error ? null : (poRes.data ?? []).length > 0,
      sameNote,
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
 * plan()'s hold_same_invoice for this delivery (lib/priority-status.ts
 * heldBySameNote): another deliveries row of the same supplier note already
 * in Priority or on its way. Read-only; a failed read answers null (unknown)
 * rather than guessing a hold.
 */
async function sameNoteHeld(
  receiptId: string,
  outbox: Record<string, unknown>,
  delivery: { document_number: string | null; created_at: string | null },
): Promise<boolean | null> {
  const doc = (delivery.document_number ?? '').trim();
  const created = delivery.created_at ? Date.parse(delivery.created_at) : NaN;
  if (!doc || !Number.isFinite(created)) return false;
  const from = new Date(created - SAME_NOTE_WINDOW_MS).toISOString();
  const to = new Date(created + SAME_NOTE_WINDOW_MS).toISOString();

  const [forksRes, grRes] = await Promise.all([
    supabase
      .from('deliveries')
      .select('id, created_at')
      .eq('document_number', doc)
      .neq('id', receiptId)
      .gte('created_at', from)
      .lte('created_at', to)
      .limit(20),
    supabase
      .from('priority_goods_receipts')
      .select('origin, delivery_id, curdate, synced_at')
      .eq('booknum', doc)
      .neq('origin', 'warehouse_bot')
      .limit(20),
  ]);
  if (forksRes.error || grRes.error) return null;

  const forks = (forksRes.data ?? []) as { id: string; created_at: string | null }[];
  let siblings: SameNoteOutboxRow[] = [];
  if (forks.length) {
    const { data, error } = await supabase
      .from('priority_push_outbox')
      .select('id, delivery_id, status, queued_at')
      .in('delivery_id', forks.map((f) => f.id));
    if (error) return null;
    const createdOf = new Map(forks.map((f) => [f.id, f.created_at]));
    siblings = ((data ?? []) as { id: number; delivery_id: string; status: string | null; queued_at: string | null }[])
      .map((o) => ({ id: o.id, status: o.status, queued_at: o.queued_at, delivery_created_at: createdOf.get(o.delivery_id) ?? null }));
  }

  return heldBySameNote({
    outboxId: outbox.id as number | string,
    queuedAt: typeof outbox.queued_at === 'string' ? outbox.queued_at : null,
    deliveryId: receiptId,
    deliveryCreatedAt: delivery.created_at,
    siblings,
    receipts: (grRes.data ?? []) as SameNoteReceipt[],
  });
}
