import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyReceiptFormLink } from '@/lib/receipt-form-link';
import { RECEIVE_EVENT_SET } from '@/lib/receive-trace';
import { packEventData } from '@/lib/scanner-trace-sanitize';

/**
 * POST /api/receipt-form/{id}/events
 * Body: {exp, sig, load_id, events: [{ts, seq, kind, event, data}]}
 *
 * The receive form's own trail (2026-10-28, lib/receive-trace.ts): what the
 * worker did between opening the form (`receive_open`) and saving it
 * (`receive_submit`) — line focus and time per line, field changes, search,
 * lines becoming complete, save attempts. Stored in `scanner_events` as
 * page 'receive', token = the form id, chat_id = the form's worker, next to
 * the server rows of the same form.
 *
 * Authenticated by the form's signed link (the page has no scan-session
 * token, so /api/trace cannot resolve it). Recorded for every form — a
 * receive form is a few hundred small rows at most — unless the env var
 * RECEIVE_TRACE_DISABLED is set, which answers {enabled:false} and the page
 * stops sending. Only known `receive_*` event names are kept.
 *
 * Answers: 200 {accepted, enabled}; 400 bad body; 401 link_invalid;
 * 404 not_found; 500 insert_failed.
 */
export const dynamic = 'force-dynamic';

const KINDS = new Set(['ui', 'lifecycle', 'error']);
const MAX_EVENTS = 200;
const NO_STORE = { 'Cache-Control': 'no-store' };

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function receiveTraceDisabled(): boolean {
  const v = (process.env.RECEIVE_TRACE_DISABLED ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off';
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Read as text: a sendBeacon body may arrive without a JSON content type.
    const raw = await request.text().catch(() => '');
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'bad_request' });

    const exp = typeof body.exp === 'string' ? body.exp : String(body.exp ?? '');
    const sig = typeof body.sig === 'string' ? body.sig : '';
    if (!verifyReceiptFormLink(id, exp, sig)) return reply(401, { ok: false, error: 'link_invalid' });
    if (receiveTraceDisabled()) return reply(200, { accepted: 0, enabled: false });

    const loadId = typeof body.load_id === 'string' ? body.load_id.slice(0, 64) : '';
    const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : [];
    if (!loadId || events.length === 0) return reply(400, { ok: false, error: 'missing_fields' });

    const { data: row, error: loadErr } = await supabase
      .from('receipt_forms')
      .select('id, chat_id')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) throw new Error(`load receipt_forms: ${loadErr.message}`);
    if (!row) return reply(404, { ok: false, error: 'not_found' });
    const chat = String((row as { chat_id?: unknown }).chat_id ?? '');

    const rows = events.slice(0, MAX_EVENTS).flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : NaN;
      const seq = typeof e.seq === 'number' && Number.isFinite(e.seq) ? Math.trunc(e.seq) : NaN;
      const kind = typeof e.kind === 'string' && KINDS.has(e.kind) ? e.kind : '';
      const event = typeof e.event === 'string' && RECEIVE_EVENT_SET.has(e.event) ? e.event : '';
      if (!Number.isFinite(ts) || !Number.isFinite(seq) || !kind || !event) return [];
      // A phone with a wrong clock still gets a usable row: keep its ts only if plausible.
      const when = Math.abs(ts - Date.now()) < 7 * 24 * 3600_000 ? new Date(ts) : new Date();
      return [{
        ts: when.toISOString(),
        ...(/^\d{1,18}$/.test(chat) ? { chat_id: chat } : {}),
        page: 'receive',
        token: id,
        load_id: loadId,
        seq,
        kind,
        event,
        data: e.data === undefined ? null : packEventData(e.data),
      }];
    });
    if (rows.length === 0) return reply(200, { accepted: 0, enabled: true });

    const { error } = await supabase.from('scanner_events').insert(rows);
    if (error) {
      console.error('[api/receipt-form/events] insert failed', id, error.message);
      return reply(500, { ok: false, error: 'insert_failed' });
    }
    return reply(200, { accepted: rows.length, enabled: true });
  } catch (error) {
    console.error('[api/receipt-form/events] POST error:', id, error);
    return reply(500, { ok: false, error: 'server_error' });
  }
}
