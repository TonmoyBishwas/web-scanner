/**
 * Who may open the receipts page (/priority/receipts) and its API: the
 * holder of a fixed receipts link (lib/receipts-link.ts) whose users.id is
 * an ACTIVE Admin right now. Checked on every request, so deactivating the
 * user or taking the Admin role away revokes a link already handed out.
 *
 * Server only (reads `users` with the service-role client).
 */
import { supabase } from './supabase';
import { verifyReceiptsLink } from './receipts-link';

/** The `users` row as the check needs it. */
export interface ReceiptsUserRow {
  role: string | null;
  active: boolean | null;
  chat_id: number | string | null;
}

export type LookupUserById = (userId: string) => Promise<ReceiptsUserRow | null>;

export type ReceiptsCheck =
  | { ok: true; userId: string; chatId: string | null }
  | { ok: false; status: 401 | 403; error: string };

export const RECEIPTS_LINK_INVALID = 'link_invalid';
export const RECEIPTS_NOT_ADMIN = 'not_admin';

async function userById(userId: string): Promise<ReceiptsUserRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select('role, active, chat_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`users read failed: ${error.message}`);
  return (data as ReceiptsUserRow | null) ?? null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 401 (`link_invalid`) for a link that is not ours, 403 (`not_admin`) for a
 * valid link whose user is gone, inactive or not an Admin; otherwise the
 * user id and chat id (the chat id is only used server side, to sign the
 * per-row "needs attention" links — it is never sent to the page as is).
 */
export async function requireReceiptsAdmin(
  params: { u?: unknown; sig?: unknown },
  lookup: LookupUserById = userById,
): Promise<ReceiptsCheck> {
  const u = text(params.u).toLowerCase();
  if (!verifyReceiptsLink(u, text(params.sig))) {
    return { ok: false, status: 401, error: RECEIPTS_LINK_INVALID };
  }
  const row = await lookup(u);
  if (!row || row.active !== true || row.role !== 'Admin') {
    return { ok: false, status: 403, error: RECEIPTS_NOT_ADMIN };
  }
  const chat = row.chat_id == null ? '' : String(row.chat_id);
  return { ok: true, userId: u, chatId: chat || null };
}
