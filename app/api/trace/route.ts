import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { packEventData } from '@/lib/scanner-trace-sanitize';

/**
 * Scanner trace endpoint — see lib/scanner-trace.ts.
 *
 *   GET  /api/trace?token=…&w=…   → { enabled, chat_id, nickname }
 *   POST /api/trace { token, page, load_id, w?, events[] } → { accepted }
 *
 * The user is ALWAYS resolved server-side from the session token (the
 * session's chat_id, or `w` — the split-job worker id the bot stamps on a
 * worker's own link). Tracing is on when `users.trace_enabled` is true or
 * `users.trace_until` is still in the future. A POST for an untraced user
 * stores nothing (the client only asks once, but nothing relies on that).
 */

const PAGES = new Set(['pallet-verify', 'scan', 'issue']);
const KINDS = new Set(['lifecycle', 'ui', 'phase', 'fetch', 'console', 'error']);
const MAX_EVENTS = 200;

interface TraceUser {
  enabled: boolean;
  chat_id: number | null;
  nickname: string | null;
}

async function resolveUser(token: string, w: string | null): Promise<TraceUser> {
  const none: TraceUser = { enabled: false, chat_id: null, nickname: null };
  if (!token || !/^[A-Za-z0-9_-]{4,128}$/.test(token)) return none;

  // Any kind, expired or not — a worker may still be on a finished page.
  const { data: sess, error } = await supabase
    .from('scan_sessions')
    .select('data')
    .eq('token', token)
    .maybeSingle();
  if (error || !sess) return none;

  const sessionChat = (sess.data as { chat_id?: unknown } | null)?.chat_id;
  const chatStr = String(w && /^\d{5,20}$/.test(w) ? w : sessionChat ?? '').trim();
  if (!/^\d{5,20}$/.test(chatStr)) return none;
  const chatId = Number(chatStr);

  const { data: user } = await supabase
    .from('users')
    .select('nickname, trace_enabled, trace_until')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (!user) return { ...none, chat_id: chatId };

  const until = user.trace_until ? Date.parse(user.trace_until as string) : NaN;
  const enabled = Boolean(user.trace_enabled) || (Number.isFinite(until) && until > Date.now());
  return { enabled, chat_id: chatId, nickname: (user.nickname as string) ?? null };
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token') ?? '';
    const w = request.nextUrl.searchParams.get('w');
    const u = await resolveUser(token, w);
    return NextResponse.json(u, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[trace] GET failed', e);
    return NextResponse.json({ enabled: false }, { status: 200 });
  }
}

interface IncomingEvent {
  ts?: unknown; seq?: unknown; kind?: unknown; event?: unknown; data?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      token?: unknown; page?: unknown; load_id?: unknown; w?: unknown; events?: unknown;
    };
    const token = typeof body.token === 'string' ? body.token : '';
    const page = typeof body.page === 'string' && PAGES.has(body.page) ? body.page : '';
    const loadId = typeof body.load_id === 'string' ? body.load_id.slice(0, 64) : '';
    const w = typeof body.w === 'string' ? body.w : null;
    const events = Array.isArray(body.events) ? (body.events as IncomingEvent[]) : [];
    if (!token || !page || !loadId || events.length === 0) {
      return NextResponse.json({ success: false, error: 'missing_fields' }, { status: 400 });
    }

    const u = await resolveUser(token, w);
    if (!u.enabled) return NextResponse.json({ accepted: 0, enabled: false });

    const rows = events.slice(0, MAX_EVENTS).flatMap((e) => {
      const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : NaN;
      const seq = typeof e.seq === 'number' && Number.isFinite(e.seq) ? Math.trunc(e.seq) : NaN;
      const kind = typeof e.kind === 'string' && KINDS.has(e.kind) ? e.kind : '';
      const event = typeof e.event === 'string' ? e.event.slice(0, 80) : '';
      if (!Number.isFinite(ts) || !Number.isFinite(seq) || !kind || !event) return [];
      return [{
        ts: new Date(ts).toISOString(),
        chat_id: u.chat_id,
        nickname: u.nickname,
        page,
        token,
        load_id: loadId,
        seq,
        kind,
        event,
        data: e.data === undefined ? null : packEventData(e.data),
      }];
    });
    if (rows.length === 0) return NextResponse.json({ accepted: 0 });

    const { error } = await supabase.from('scanner_events').insert(rows);
    if (error) {
      console.error('[trace] insert failed', error.message);
      return NextResponse.json({ success: false, error: 'insert_failed' }, { status: 500 });
    }
    return NextResponse.json({ accepted: rows.length });
  } catch (e) {
    console.error('[trace] POST failed', e);
    return NextResponse.json({ success: false, error: 'bad_request' }, { status: 400 });
  }
}
