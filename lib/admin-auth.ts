/**
 * Who may use the Priority "needs attention" page and its API: the holder of
 * a link the bot signed (lib/admin-link.ts) whose chat id is an ACTIVE Admin
 * in `users` right now. Checked again on every request, so taking a user's
 * Admin role away also cuts off a link already sent to them.
 *
 * Server only (reads `users` with the service-role client).
 */
import { supabase } from './supabase';
import { verifyAdminLink } from './admin-link';

/** u / exp / sig as they arrive (query string or JSON body). */
export interface AdminLinkParams {
  u?: unknown;
  exp?: unknown;
  sig?: unknown;
}

/** One `users` row as the check needs it. */
export interface AdminUserRow {
  role: string | null;
  active: boolean | null;
}

/** Every `users` row for a chat id (Telegram-era duplicates exist). */
export type LookupUsers = (chatId: string) => Promise<AdminUserRow[]>;

export type AdminCheck =
  | { ok: true; chatId: string }
  | { ok: false; status: 401 | 403; error: string };

export const LINK_INVALID =
  'This link is not valid or has expired. Open the newest link from the WhatsApp alert.';
export const NOT_ADMIN = 'This link is for an active admin only.';

async function usersByChatId(chatId: string): Promise<AdminUserRow[]> {
  const { data, error } = await supabase.from('users').select('role, active').eq('chat_id', chatId);
  if (error) throw new Error(`users read failed: ${error.message}`);
  return (data ?? []) as AdminUserRow[];
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 401 for a link that is not ours or has expired, 403 for a valid link
 * whose chat id is not an active Admin; otherwise the chat id, which the
 * routes record as `admin:<chat id>` on anything they change.
 */
export async function requireAdmin(
  params: AdminLinkParams,
  lookup: LookupUsers = usersByChatId,
  nowSec?: number,
): Promise<AdminCheck> {
  const u = text(params.u);
  if (!verifyAdminLink(u, text(params.exp), text(params.sig), nowSec)) {
    return { ok: false, status: 401, error: LINK_INVALID };
  }
  const rows = await lookup(u);
  if (!rows.some((r) => r.active === true && r.role === 'Admin')) {
    return { ok: false, status: 403, error: NOT_ADMIN };
  }
  return { ok: true, chatId: u };
}
