/**
 * Server-only session-token guard for warehouse-wide read APIs.
 *
 * The pallets browser exposes stock data beyond the caller's own session, so
 * every request must prove it originates from a live scanner session: the
 * token must match an unexpired `scan_sessions` row (any kind).
 */
import { supabase } from './supabase';

export async function isValidSessionToken(token: string | null): Promise<boolean> {
  if (!token) return false;

  const { data, error } = await supabase
    .from('scan_sessions')
    .select('token')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    throw new Error(`scan_sessions guard read failed: ${error.message}`);
  }
  return data !== null;
}

export interface SessionContext {
  /** The delivery this session is working on, when it has one. */
  documentNumber: string | null;
  /** WhatsApp chat id of the worker the session was minted for. */
  chatId: number | null;
}

/**
 * Guard + context in one read: resolves a live session token to the delivery
 * it belongs to. Returns null when the token is unknown or expired, so callers
 * can treat null as a 401 exactly like `isValidSessionToken` returning false.
 *
 * Works for every session kind — carton, pallet and multi_pallet all store
 * `document_number` on the jsonb payload (an ISSUE session simply has none).
 */
export async function getSessionContext(token: string | null): Promise<SessionContext | null> {
  if (!token) return null;

  const { data, error } = await supabase
    .from('scan_sessions')
    .select('data')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    throw new Error(`scan_sessions guard read failed: ${error.message}`);
  }
  if (!data) return null;

  const payload = (data.data ?? {}) as Record<string, unknown>;
  const doc = payload.document_number;
  const chat = payload.chat_id;
  return {
    documentNumber: typeof doc === 'string' && doc ? doc : null,
    chatId: chat == null ? null : Number(chat) || null,
  };
}
