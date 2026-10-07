import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin } from '@/lib/admin-auth';
import { markFoundRefusalText, parseDocno, parseOutboxId } from '@/lib/priority-attention';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/priority/mark-found
 * Body: {u, exp, sig, outbox_id, docno}
 *
 * "Mark as found" on the needs-attention page: the office found the draft
 * in Priority by hand. Calls our priority_push_mark_found(), which sets the
 * outbox row to delivered with "confirmed by hand: Priority draft <docno>
 * (admin:<chat id>)". It never calls the client's wb_mark_gr_synced and
 * writes nothing to his tables.
 *
 * Answers 200 {success, outbox_id, docno}, 409 {success:false, refused,
 * error} when the function declines, 401 / 403 for the link, 400 for a bad
 * body.
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
    const docno = parseDocno(body.docno);
    if (outboxId === null || docno === null) {
      return NextResponse.json(
        { success: false, error: 'Type the Priority document number, for example GR26000049.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const { data, error } = await supabase.rpc('priority_push_mark_found', {
      p_outbox_id: outboxId,
      p_docno: docno,
      p_by: `admin:${auth.chatId}`,
    });
    if (error) throw new Error(`priority_push_mark_found failed: ${error.message}`);

    const result = (data ?? {}) as { ok?: boolean; refused?: string | null };
    if (result.ok === true) {
      return NextResponse.json({ success: true, outbox_id: outboxId, docno }, { headers: NO_STORE });
    }
    // docno_invalid | not_markable_status | request_in_flight (M4)
    const refused = result.refused ?? null;
    return NextResponse.json(
      { success: false, refused, error: markFoundRefusalText(refused) },
      { status: 409, headers: NO_STORE },
    );
  } catch (error) {
    console.error('[api/priority/mark-found] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Mark as found failed — nothing was changed. Refresh and look again.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
