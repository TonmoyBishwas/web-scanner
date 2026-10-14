import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyReceiptFormLink } from '@/lib/receipt-form-link';
import { normalizeFormLines, parseAnswers, todayInJerusalem, validateAnswers } from '@/lib/receipt-form';
import { readBotReply } from '@/lib/receipt-form-submit';

/**
 * POST /api/receipt-form/{id}
 * Body: {exp, sig, answers}
 *
 * The Approve button of the non-meat fill-in form (/receive/{id}).
 *
 *  1. the signed link is checked again (same as the page);
 *  2. the answers are checked with lib/receipt-form.ts — the same rules the
 *     page shows live (422 {error:'invalid', errors} otherwise);
 *  3. the row moves open → submitted in ONE conditional update (status still
 *     'open' and not expired). 0 rows → 409 with the current status: a second
 *     tap, a second phone, or the chat path that already finished the note;
 *  4. the bot is called and AWAITED (`/webhook/receipt-form` {form_id}, 25 s):
 *     it claims the row, books the delivery and answers 200 {ok:true,…};
 *  5. if the bot cannot be reached, times out, or answers anything but
 *     success, the row goes back to 'open' — only WHERE it is still
 *     'submitted', so a row the bot claimed (processing / done / failed / its
 *     own put-back) is never touched. The worker can tap again.
 *
 * Answers: 200 {ok:true, status:'done', saved_lines, gr_note}; 400 bad body;
 * 401 link_invalid; 404 not_found; 409 not_open {status}; 410 expired;
 * 422 invalid {errors}; 502 bot_unreachable / bot_not_configured; or the
 * bot's own refusal status with {error, message, status}.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const BOT_TIMEOUT_MS = 25_000;

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function currentStatus(id: string): Promise<string | null> {
  const { data } = await supabase.from('receipt_forms').select('status').eq('id', id).maybeSingle();
  return (data?.status as string | undefined) ?? null;
}

/** Put a row the bot never claimed back to 'open' so the worker can retry. */
async function reopenIfUnclaimed(id: string, why: string): Promise<void> {
  const { error } = await supabase
    .from('receipt_forms')
    .update({ status: 'open', submitted_at: null, error: `scanner: ${why}`.slice(0, 500) })
    .eq('id', id)
    .eq('status', 'submitted');
  if (error) console.error('[api/receipt-form] reopen failed:', id, error.message);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply(400, { ok: false, error: 'bad_request' });
    }
    const exp = typeof body.exp === 'string' ? body.exp : String(body.exp ?? '');
    const sig = typeof body.sig === 'string' ? body.sig : '';
    if (!verifyReceiptFormLink(id, exp, sig)) {
      return reply(401, { ok: false, error: 'link_invalid' });
    }

    const { data: row, error: loadErr } = await supabase
      .from('receipt_forms')
      .select('id, status, lines, expires_at')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) throw new Error(`load receipt_forms: ${loadErr.message}`);
    if (!row) return reply(404, { ok: false, error: 'not_found' });
    if (row.status !== 'open') return reply(409, { ok: false, error: 'not_open', status: row.status });
    if (!row.expires_at || new Date(row.expires_at as string).getTime() <= Date.now()) {
      return reply(410, { ok: false, error: 'expired' });
    }

    const answers = parseAnswers(body.answers);
    if (!answers) return reply(400, { ok: false, error: 'bad_answers' });
    const lines = normalizeFormLines(row.lines);
    const check = validateAnswers(lines, answers, todayInJerusalem());
    if (!check.ok) return reply(422, { ok: false, error: 'invalid', errors: check });

    // open → submitted, atomically. Only one tap / phone ever gets here.
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('receipt_forms')
      .update({ status: 'submitted', answers, submitted_at: nowIso, error: null })
      .eq('id', id)
      .eq('status', 'open')
      .gt('expires_at', nowIso)
      .select('id');
    if (claimErr) throw new Error(`claim receipt_forms: ${claimErr.message}`);
    if (!claimed || claimed.length === 0) {
      const status = await currentStatus(id);
      if (status === 'open') return reply(410, { ok: false, error: 'expired' });
      return reply(409, { ok: false, error: 'not_open', status });
    }

    const botUrl = (process.env.TELEGRAM_BOT_WEBHOOK_URL ?? '').trim().replace(/\/+$/, '');
    if (!botUrl) {
      console.error('[api/receipt-form] TELEGRAM_BOT_WEBHOOK_URL is not set');
      await reopenIfUnclaimed(id, 'bot url not configured');
      return reply(502, { ok: false, error: 'bot_not_configured' });
    }

    let res: Response;
    try {
      res = await fetch(`${botUrl}/webhook/receipt-form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form_id: id }),
        signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      // Network error or timeout: the bot never answered. If it never claimed
      // the row either, give it back to the worker.
      const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[api/receipt-form] bot unreachable:', id, why);
      await reopenIfUnclaimed(id, `bot unreachable (${why})`);
      return reply(502, { ok: false, error: 'bot_unreachable', status: await currentStatus(id) });
    }

    const data = await res.json().catch(() => null);
    const outcome = readBotReply(res.status, data);
    if (outcome.kind === 'done') {
      return reply(200, { ok: true, status: 'done', saved_lines: outcome.saved_lines, gr_note: outcome.gr_note });
    }

    console.error('[api/receipt-form] bot refused:', id, res.status, outcome.error, outcome.message ?? '');
    // The bot puts a row it claimed back itself; this only catches the case
    // where it never got that far (a proxy error, a bot without the route).
    await reopenIfUnclaimed(id, `bot answered ${res.status} ${outcome.error}`);
    return reply(outcome.httpStatus, {
      ok: false,
      error: outcome.error,
      message: outcome.message,
      status: await currentStatus(id),
    });
  } catch (error) {
    console.error('[api/receipt-form] POST error:', id, error);
    return reply(500, { ok: false, error: 'server_error' });
  }
}
