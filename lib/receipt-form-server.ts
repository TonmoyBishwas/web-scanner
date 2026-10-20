/**
 * The receive form's row as the page and its API see it — server only
 * (service-role client + node:crypto via the link signer).
 *
 * Two-page notes (client 20/10): the bot appends a page's lines to the OPEN
 * form in place (`header.rev` +1, `header.line_count`), so the open page
 * polls `GET /api/receipt-form/{id}` and merges them. When a form is closed
 * the bot says why in `result.closed_reason` (replaced / cancelled / reset /
 * finished_in_chat / ops_duplicate); a `replaced` form points to the newer one
 * (`result.by`), and the holder of a valid link to the old form gets a signed
 * link to the new one — only when it is the SAME delivery and chat, still
 * open and not expired.
 */
import { supabase } from '@/lib/supabase';
import { isUuid, signReceiptFormLink, MAX_RECEIPT_FORM_LINK_TTL_S } from '@/lib/receipt-form-link';
import {
  closedReasonOf,
  formRev,
  normalizeFormHeader,
  normalizeFormLines,
  type ClosedReason,
  type FormHeader,
  type FormLine,
} from '@/lib/receipt-form';
import { logServerEvent } from '@/lib/server-events';

export const RECEIPT_FORM_COLUMNS = 'id, delivery_id, chat_id, status, language, header, lines, result, expires_at, created_at';

export interface FormRow {
  id: string;
  delivery_id: string | null;
  chat_id: string | null;
  status: string;
  language: string | null;
  header: unknown;
  lines: unknown;
  result: unknown;
  expires_at: string | null;
  created_at: string | null;
}

export async function loadFormRow(id: string): Promise<FormRow | null> {
  const { data, error } = await supabase.from('receipt_forms').select(RECEIPT_FORM_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`load receipt_forms: ${error.message}`);
  return (data as FormRow | null) ?? null;
}

/** The id a replaced form names as its successor (`result.by`). */
function successorId(result: unknown): string | null {
  const o = (result && typeof result === 'object' && !Array.isArray(result) ? result : {}) as Record<string, unknown>;
  for (const k of ['by', 'replaced_by']) if (isUuid(o[k])) return String(o[k]).toLowerCase();
  return null;
}

/**
 * A signed `/receive/…` link to the form that replaced `row`, or null. The
 * successor must be the same delivery and chat and still open. Without a
 * `result.by` (a bot that does not write it), the newest open form of the
 * same delivery + chat created after this one stands in.
 */
export async function newerFormLink(row: FormRow): Promise<{ id: string; href: string } | null> {
  const secret = (process.env.ADMIN_LINK_SECRET ?? '').trim();
  if (!secret || !row.delivery_id) return null;
  const by = successorId(row.result);
  let q = supabase
    .from('receipt_forms')
    .select('id, delivery_id, chat_id, status, expires_at, created_at')
    .eq('delivery_id', row.delivery_id)
    .eq('status', 'open')
    .neq('id', row.id);
  if (by) q = q.eq('id', by);
  else if (row.created_at) q = q.gt('created_at', row.created_at);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
  if (error) {
    console.error('[receipt-form] newer form lookup failed:', row.id, error.message);
    return null;
  }
  const next = (data as { id: string; chat_id: string | null; expires_at: string | null }[] | null)?.[0];
  if (!next || String(next.chat_id ?? '') !== String(row.chat_id ?? '')) return null;
  const nowS = Math.floor(Date.now() / 1000);
  const expiresS = Math.floor(new Date(String(next.expires_at ?? '')).getTime() / 1000);
  if (!Number.isFinite(expiresS) || expiresS <= nowS + 60) return null;
  // The link lives as long as the row, but never past what the verifier accepts.
  const exp = String(Math.min(expiresS, nowS + MAX_RECEIPT_FORM_LINK_TTL_S - 60));
  const id = String(next.id).toLowerCase();
  const sig = signReceiptFormLink(id, exp, secret);
  return { id, href: `/receive/${id}?${new URLSearchParams({ exp, sig }).toString()}` };
}

export interface FormState {
  status: string;
  rev: number;
  line_count: number;
  lines: FormLine[];
  header: FormHeader;
  closed_reason: ClosedReason | null;
  /** Set only for a replaced form whose successor is open (see newerFormLink). */
  newer: { id: string; href: string } | null;
  expired: boolean;
}

export async function formState(row: FormRow): Promise<FormState> {
  const lines = normalizeFormLines(row.lines);
  const header = normalizeFormHeader(row.header, lines.length);
  const closed_reason = row.status === 'closed' ? closedReasonOf(row.result) : null;
  const expiresAt = new Date(String(row.expires_at ?? '')).getTime();
  return {
    status: row.status,
    rev: formRev(row.header),
    line_count: lines.length,
    lines,
    header,
    closed_reason,
    newer: closed_reason === 'replaced' ? await newerFormLink(row) : null,
    expired: !Number.isFinite(expiresAt) || expiresAt <= Date.now(),
  };
}

/** One `scanner_events` row for the receive form: page 'receive', token = form id, the worker's chat. */
export function logFormEvent(row: Pick<FormRow, 'id' | 'chat_id'>, event: string, data?: Record<string, unknown>): Promise<void> {
  return logServerEvent(row.id, event, data, { page: 'receive', chatId: row.chat_id });
}
