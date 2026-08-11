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
