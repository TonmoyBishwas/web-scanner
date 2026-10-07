import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin } from '@/lib/admin-auth';
import { parseOutboxId, refusalText } from '@/lib/priority-attention';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/priority/resend
 * Body: {u, exp, sig, outbox_id, priority_checked, make_checked}
 *
 * "Send again" on the needs-attention page: calls our guarded
 * priority_push_resend(), which refuses unless the row is failed /
 * unconfirmed, Priority has no receipt for it, no request is in flight, no
 * other delivery of the same note is on its way, the stored reject would
 * not simply repeat — and BOTH checks were declared. Only a literal `true`
 * counts as ticked. The two overrides (release_guard, override_known_reject)
 * are never sent from here; they stay a decision taken at the database.
 *
 * Answers 200 {success, outbox_id, attempt} when re-queued (the dispatcher
 * sends it within ~15 s), 409 {success:false, refused, error} when refused,
 * 401 / 403 for the link, 400 for a bad body.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Bad request' }, { status: 400, headers: NO_STORE });
    }

    const auth = await requireAdmin(body);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers: NO_STORE });
    }

    const outboxId = parseOutboxId(body.outbox_id);
    if (outboxId === null) {
      return NextResponse.json({ success: false, error: 'outbox_id is required' }, { status: 400, headers: NO_STORE });
    }

    const { data, error } = await supabase.rpc('priority_push_resend', {
      p_outbox_id: outboxId,
      p_by: `admin:${auth.chatId}`,
      p_priority_checked: body.priority_checked === true,
      p_make_checked: body.make_checked === true,
    });
    if (error) throw new Error(`priority_push_resend failed: ${error.message}`);

    const result = (data ?? {}) as { ok?: boolean; refused?: string | null; attempt?: number | null };
    if (result.ok === true) {
      return NextResponse.json(
        { success: true, outbox_id: outboxId, attempt: result.attempt ?? null },
        { headers: NO_STORE },
      );
    }
    const refused = result.refused ?? null;
    return NextResponse.json(
      { success: false, refused, error: refusalText(refused) },
      { status: 409, headers: NO_STORE },
    );
  } catch (error) {
    console.error('[api/priority/resend] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Send again failed — nothing was changed. Refresh and look again.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
