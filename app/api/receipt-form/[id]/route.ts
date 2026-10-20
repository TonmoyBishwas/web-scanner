import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyReceiptFormLink } from '@/lib/receipt-form-link';
import { formRev, normalizeFormLines, parseAnswers, todayInJerusalem, validateAnswers } from '@/lib/receipt-form';
import { readBotReply } from '@/lib/receipt-form-submit';
import { formState, loadFormRow, logFormEvent, type FormRow } from '@/lib/receipt-form-server';

/**
 * GET /api/receipt-form/{id}?exp&sig[&rev]
 *
 * The open page's poll (every 15 s while visible, and on focus — two-page
 * notes, 20/10): {ok, status, rev, line_count, lines, header, closed_reason,
 * newer, expired}. `newer` = {id, href}, a signed link to the form that
 * replaced this one (lib/receipt-form-server.ts). `rev` = what the page has;
 * a poll that finds the row moved on (new lines, closed, saved elsewhere) is
 * recorded in scanner_events — an unchanged poll is not. 401 link_invalid;
 * 404 not_found.
 *
 * POST /api/receipt-form/{id}
 * Body: {exp, sig, rev, answers}
 *
 * The Approve button of the non-meat fill-in form (/receive/{id}).
 *
 *  1. the signed link is checked again (same as the page);
 *  2. the page's `rev` must be the row's (a page appended since the page
 *     loaded) — else 409 {error:'lines_changed', rev, line_count, lines},
 *     BEFORE validation, so the page merges the new lines instead of showing a
 *     generic "invalid". A page without `rev` (loaded before 20/10) skips this;
 *  3. the answers are checked with lib/receipt-form.ts — the same rules the
 *     page shows live (422 {error:'invalid', errors} otherwise);
 *  4. the row moves open → submitted in ONE conditional update (status still
 *     'open', not expired, and `header.rev` unchanged). 0 rows → 409 with the
 *     current status (+ closed_reason / newer for a closed form): a second
 *     tap, a second phone, or the chat path that already finished the note;
 *  5. the bot is called and AWAITED (`/webhook/receipt-form` {form_id}, 25 s):
 *     it claims the row, books the delivery and answers 200 {ok:true,…};
 *  6. if the bot cannot be reached, times out, or answers anything but
 *     success, the row goes back to 'open' — only WHERE it is still
 *     'submitted', so a row the bot claimed (processing / done / failed / its
 *     own put-back) is never touched. The worker can tap again.
 *
 * Answers: 200 {ok:true, status:'done', saved_lines, gr_note}; 400 bad body;
 * 401 link_invalid; 404 not_found; 409 not_open {status, closed_reason, newer};
 * 409 lines_changed {rev, line_count, lines}; 410 expired;
 * 422 invalid {errors}; 502 bot_unreachable / bot_not_configured; or the
 * bot's own refusal status with {error, message, status}. Every outcome is
 * one scanner_events row (page 'receive', token = form id).
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

/** 409 for a form that is no longer open: its status, and why / where to go for a closed one. */
async function notOpen(row: FormRow) {
  const st = await formState(row);
  return reply(409, { ok: false, error: 'not_open', status: st.status, closed_reason: st.closed_reason, newer: st.newer });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const sp = request.nextUrl.searchParams;
    if (!verifyReceiptFormLink(id, sp.get('exp') ?? '', sp.get('sig') ?? '')) {
      return reply(401, { ok: false, error: 'link_invalid' });
    }
    const row = await loadFormRow(id);
    if (!row) return reply(404, { ok: false, error: 'not_found' });
    const st = await formState(row);
    const pageRev = Number(sp.get('rev'));
    if (Number.isInteger(pageRev) && pageRev >= 1 && (pageRev !== st.rev || st.status !== 'open')) {
      await logFormEvent(row, 'receive_poll_changed', {
        page_rev: pageRev, rev: st.rev, line_count: st.line_count, status: st.status,
        closed_reason: st.closed_reason, newer: st.newer?.id ?? null,
      });
    }
    return reply(200, { ok: true, ...st });
  } catch (error) {
    console.error('[api/receipt-form] GET error:', id, error);
    return reply(500, { ok: false, error: 'server_error' });
  }
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

    const row = await loadFormRow(id);
    if (!row) return reply(404, { ok: false, error: 'not_found' });
    const log = (event: string, data?: Record<string, unknown>) => logFormEvent(row, event, data);
    if (row.status !== 'open') {
      await log('receive_submit', { outcome: 'not_open', status: row.status });
      return notOpen(row);
    }
    if (!row.expires_at || new Date(row.expires_at as string).getTime() <= Date.now()) {
      await log('receive_submit', { outcome: 'expired' });
      return reply(410, { ok: false, error: 'expired' });
    }

    // A page added since the page loaded: hand it the new lines, before any
    // validation (which would only say "lines_mismatch").
    const rowRev = formRev(row.header);
    const lines = normalizeFormLines(row.lines);
    const pageRev = body.rev === undefined || body.rev === null ? null : Number(body.rev);
    if (pageRev !== null && pageRev !== rowRev) {
      await log('receive_submit', { outcome: 'lines_changed', page_rev: pageRev, rev: rowRev, line_count: lines.length });
      return reply(409, { ok: false, error: 'lines_changed', rev: rowRev, line_count: lines.length, lines });
    }

    const answers = parseAnswers(body.answers);
    if (!answers) {
      await log('receive_submit', { outcome: 'bad_answers' });
      return reply(400, { ok: false, error: 'bad_answers' });
    }
    const check = validateAnswers(lines, answers, todayInJerusalem());
    if (!check.ok) {
      await log('receive_submit', { outcome: 'invalid', rev: rowRev, form: check.form, lines: Object.keys(check.lines).length });
      return reply(422, { ok: false, error: 'invalid', errors: check });
    }

    // open → submitted, atomically. Only one tap / phone ever gets here, and
    // only on the lines it was checked against: a page appended between the
    // check and here moves header.rev and the update matches nothing.
    const nowIso = new Date().toISOString();
    // header->>rev is SQL NULL both for a missing key and a JSON null.
    const storedRev = row.header && typeof row.header === 'object' ? (row.header as Record<string, unknown>).rev : undefined;
    const hasRev = storedRev !== undefined && storedRev !== null;
    let claim = supabase
      .from('receipt_forms')
      .update({ status: 'submitted', answers, submitted_at: nowIso, error: null })
      .eq('id', id)
      .eq('status', 'open')
      .gt('expires_at', nowIso);
    claim = hasRev ? claim.eq('header->>rev', String(storedRev)) : claim.is('header->>rev', null);
    const { data: claimed, error: claimErr } = await claim.select('id');
    if (claimErr) throw new Error(`claim receipt_forms: ${claimErr.message}`);
    if (!claimed || claimed.length === 0) {
      const now = await loadFormRow(id);
      if (now && now.status === 'open') {
        if (formRev(now.header) !== rowRev) {
          const fresh = normalizeFormLines(now.lines);
          await log('receive_submit', { outcome: 'lines_changed', page_rev: pageRev, rev: formRev(now.header), at: 'claim' });
          return reply(409, { ok: false, error: 'lines_changed', rev: formRev(now.header), line_count: fresh.length, lines: fresh });
        }
        await log('receive_submit', { outcome: 'expired', at: 'claim' });
        return reply(410, { ok: false, error: 'expired' });
      }
      await log('receive_submit', { outcome: 'not_open', status: now?.status ?? null, at: 'claim' });
      if (!now) return reply(409, { ok: false, error: 'not_open', status: null });
      return notOpen(now);
    }
    await log('receive_submit', { outcome: 'claimed', rev: rowRev, line_count: lines.length, extras: answers.extras.length });

    const botUrl = (process.env.TELEGRAM_BOT_WEBHOOK_URL ?? '').trim().replace(/\/+$/, '');
    if (!botUrl) {
      console.error('[api/receipt-form] TELEGRAM_BOT_WEBHOOK_URL is not set');
      await reopenIfUnclaimed(id, 'bot url not configured');
      await log('receive_submit', { outcome: 'bot_not_configured' });
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
      await log('receive_submit', { outcome: 'bot_unreachable', error: why });
      return reply(502, { ok: false, error: 'bot_unreachable', status: await currentStatus(id) });
    }

    const data = await res.json().catch(() => null);
    const outcome = readBotReply(res.status, data);
    if (outcome.kind === 'done') {
      await log('receive_submit', { outcome: 'done', saved_lines: outcome.saved_lines, gr_note: outcome.gr_note });
      return reply(200, { ok: true, status: 'done', saved_lines: outcome.saved_lines, gr_note: outcome.gr_note });
    }

    console.error('[api/receipt-form] bot refused:', id, res.status, outcome.error, outcome.message ?? '');
    // The bot puts a row it claimed back itself; this only catches the case
    // where it never got that far (a proxy error, a bot without the route).
    await reopenIfUnclaimed(id, `bot answered ${res.status} ${outcome.error}`);
    await log('receive_submit', { outcome: 'bot_refused', http: res.status, error: outcome.error, message: outcome.message });
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
