/**
 * The receive form v3's calls to its API (flag receive_form_v3) —
 * client-safe: fetch only, no server imports. Same endpoints as today's
 * form: POST/GET /api/receipt-form/{id}, plus the read-only
 * GET /api/receipt-form/{id}/status.
 *
 * submitV3 reads the POST answer the way app/receive/[id]/ReceiptForm.tsx
 * does, into one result the page switches on (spec 8.1):
 *   200 {ok:true}                          → saved
 *   409 lines_changed {rev, lines}         → lines_changed (the page merges)
 *   a final status (done / closed)         → not_open {status, closed_reason, newer}
 *   status submitted / processing          → in_flight
 *   status failed                          → failed
 *   401 / 404 / 410 (link_invalid, not_found, expired) → link_invalid
 *   422 invalid                            → error 'invalid'
 *   502 bot_unreachable / bot_not_configured → error 'bot'
 *   network error                          → error 'network'
 *   anything else                          → error 'generic' (+ the bot's message)
 * Every result also carries `http` and `error` for the trace.
 */
import { normalizeFormLines, type FormLine } from './receipt-form';
import type { AnswersV3, V3Erp, V3Outcome, V3StatusResponse } from './receive-v3';

export interface V3SubmitMeta {
  /** The HTTP status; null on a network error. */
  http: number | null;
  /** The answer's `error`, if any. */
  error: string | null;
}

export type V3SubmitResult = (
  | { kind: 'saved' }
  | { kind: 'lines_changed'; rev: number | null; lines: FormLine[] }
  | { kind: 'not_open'; status: string | null; closed_reason: string | null; newer: { id: string; href: string } | null }
  | { kind: 'in_flight' }
  | { kind: 'failed' }
  | { kind: 'link_invalid' }
  | { kind: 'error'; reason: 'invalid' | 'bot' | 'network' | 'generic'; message: string | null }
) &
  V3SubmitMeta;

const IN_FLIGHT = new Set(['submitted', 'processing']);
const FINAL = new Set(['done', 'closed']);
const LINK_ERRORS = new Set(['link_invalid', 'expired', 'not_found']);

function newerOf(v: unknown): { id: string; href: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.href === 'string' && o.href.startsWith('/receive/') ? { id: o.id, href: o.href } : null;
}

const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The POST answer → one result (pure, so it is tested without a network). */
export function readSubmitAnswer(http: number, data: unknown): V3SubmitResult {
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const error = strOrNull(o?.error);
  const meta: V3SubmitMeta = { http, error };
  if (http >= 200 && http < 300 && o?.ok === true) return { kind: 'saved', ...meta };
  if (error === 'lines_changed') {
    const rev = Number(o?.rev);
    return { kind: 'lines_changed', rev: Number.isInteger(rev) && rev >= 1 ? rev : null, lines: normalizeFormLines(o?.lines), ...meta };
  }
  const status = strOrNull(o?.status);
  if (status && FINAL.has(status)) {
    return { kind: 'not_open', status, closed_reason: strOrNull(o?.closed_reason), newer: newerOf(o?.newer), ...meta };
  }
  if (status && IN_FLIGHT.has(status)) return { kind: 'in_flight', ...meta };
  if (status === 'failed') return { kind: 'failed', ...meta };
  if ((error && LINK_ERRORS.has(error)) || http === 401 || http === 404 || http === 410) return { kind: 'link_invalid', ...meta };
  if (error === 'not_open') return { kind: 'not_open', status, closed_reason: strOrNull(o?.closed_reason), newer: newerOf(o?.newer), ...meta };
  if (error === 'invalid' || http === 422) return { kind: 'error', reason: 'invalid', message: null, ...meta };
  if (error === 'bot_unreachable' || error === 'bot_not_configured') return { kind: 'error', reason: 'bot', message: null, ...meta };
  const message = typeof o?.message === 'string' && o.message.trim() ? o.message.trim() : null;
  return { kind: 'error', reason: 'generic', message, ...meta };
}

/** POST the answers (the bot is awaited server-side, up to 25 s). */
export async function submitV3(o: { formId: string; exp: string; sig: string; rev: number; answers: AnswersV3 }): Promise<V3SubmitResult> {
  let res: Response;
  try {
    res = await fetch(`/api/receipt-form/${encodeURIComponent(o.formId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exp: o.exp, sig: o.sig, rev: o.rev, answers: o.answers }),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'error', reason: 'network', message: null, http: null, error: 'network' };
  }
  const data = await res.json().catch(() => null);
  return readSubmitAnswer(res.status, data);
}

export interface V3PollResult {
  status: string;
  rev: number;
  lines: FormLine[];
  closed_reason: string | null;
  newer: { id: string; href: string } | null;
}

/** The poll's answer (pure). Null for anything that is not a good answer. */
export function readPollAnswer(http: number, data: unknown): V3PollResult | null {
  if (http < 200 || http >= 300) return null;
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (!o || o.ok !== true || typeof o.status !== 'string') return null;
  const rev = Number(o.rev);
  return {
    status: o.status,
    rev: Number.isInteger(rev) && rev >= 1 ? rev : 1,
    lines: normalizeFormLines(o.lines),
    closed_reason: strOrNull(o.closed_reason),
    newer: newerOf(o.newer),
  };
}

/** GET /api/receipt-form/{id}?exp&sig&rev (the 15 s poll); null on a bad link, a blip or offline. */
export async function pollFormV3(o: { formId: string; exp: string; sig: string; rev: number }): Promise<V3PollResult | null> {
  try {
    const q = new URLSearchParams({ exp: o.exp, sig: o.sig, rev: String(o.rev) });
    const res = await fetch(`/api/receipt-form/${encodeURIComponent(o.formId)}?${q.toString()}`, { cache: 'no-store' });
    return readPollAnswer(res.status, await res.json().catch(() => null));
  } catch {
    return null;
  }
}

const OUTCOMES: readonly V3Outcome[] = ['pending', 'success', 'partial', 'timeout', 'failed'];

/** The status endpoint's answer (pure). Null for anything that is not a good answer. */
export function readStatusAnswer(http: number, data: unknown): V3StatusResponse | null {
  if (http < 200 || http >= 300) return null;
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (!o || o.ok !== true) return null;
  const outcome = OUTCOMES.find((x) => x === o.outcome);
  if (!outcome) return null;
  const erp: V3Erp = o.erp === 'none' ? 'none' : 'priority';
  const lines = Number(o.office_lines);
  return {
    ok: true,
    erp,
    form_status: typeof o.form_status === 'string' ? o.form_status : '',
    outcome,
    docno: strOrNull(o.docno),
    office_lines: o.office_lines !== null && Number.isInteger(lines) && lines > 0 ? lines : null,
    submitted_at: strOrNull(o.submitted_at),
  };
}

/** GET /api/receipt-form/{id}/status?exp&sig; null on any failure (the page polls again). */
export async function fetchV3Status(o: { formId: string; exp: string; sig: string }): Promise<V3StatusResponse | null> {
  try {
    const q = new URLSearchParams({ exp: o.exp, sig: o.sig });
    const res = await fetch(`/api/receipt-form/${encodeURIComponent(o.formId)}/status?${q.toString()}`, { cache: 'no-store' });
    return readStatusAnswer(res.status, await res.json().catch(() => null));
  } catch {
    return null;
  }
}
