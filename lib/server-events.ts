/**
 * Server-side rows in the scanner trace (2026-10-15, logging gap G7).
 *
 * API-route failures and the outcome of every bot callback lived only in
 * Vercel's runtime logs, which expire and cannot be joined to a worker's
 * trail. They now go to `scanner_events` too, as `kind = 'server'` rows on
 * the session token (page 'api', load_id 'server'), so one query over a
 * token shows the worker's taps and what the server did with them.
 *
 * Recorded for every session, traced user or not: these are rare (errors,
 * one row per bot call) and they are the ones a client-side trace can never
 * capture. Never throws — logging must not turn a handled error into a
 * second one. Server-only (service-role client).
 */
import { supabase } from '@/lib/supabase';
import { packEventData } from '@/lib/scanner-trace-sanitize';

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 500);
  return String(e).slice(0, 500);
}

/**
 * `opts.page` / `opts.chatId`: the receive form (20/10) has no session token —
 * its rows go under page 'receive', token = the form id, and the worker's chat.
 */
export async function logServerEvent(
  token: string | null | undefined,
  event: string,
  data?: unknown,
  opts?: { page?: string; chatId?: string | number | null },
): Promise<void> {
  try {
    const t = typeof token === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(token) ? token : '';
    const payload = data instanceof Error ? { error: describeError(data) } : data;
    const chat = opts?.chatId === null || opts?.chatId === undefined ? '' : String(opts.chatId);
    const { error } = await supabase.from('scanner_events').insert({
      ts: new Date().toISOString(),
      ...(/^\d{1,18}$/.test(chat) ? { chat_id: chat } : {}),
      page: opts?.page ?? 'api',
      token: t || 'unknown',
      load_id: 'server',
      seq: 0,
      kind: 'server',
      event: event.slice(0, 80),
      data: payload === undefined ? null : packEventData(payload),
    });
    if (error) console.warn('[server-events] insert failed:', error.message);
  } catch (e) {
    console.warn('[server-events] failed:', describeError(e));
  }
}

/** `{ error: "Name: message" }` for a catch block's payload. */
export function errorData(e: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
  return { error: describeError(e), ...extra };
}

/**
 * POST a JSON body to the bot and record status + latency as `event`
 * (`bot_callback`). Returns the Response, or null on a network error /
 * timeout (also recorded). The caller keeps its own console logging.
 */
export async function postToBot(
  token: string,
  url: string,
  body: string,
  meta?: Record<string, unknown>,
): Promise<Response | null> {
  const started = Date.now();
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep as is */ }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    let snippet: string | undefined;
    if (!res.ok) {
      try { snippet = (await res.clone().text()).slice(0, 500); } catch { snippet = undefined; }
    }
    await logServerEvent(token, 'bot_callback', {
      path, status: res.status, ok: res.ok, ms: Date.now() - started, bytes: body.length, body: snippet, ...meta,
    });
    return res;
  } catch (e) {
    await logServerEvent(token, 'bot_callback', {
      path, ok: false, ms: Date.now() - started, bytes: body.length, ...errorData(e), ...meta,
    });
    throw e;
  }
}
