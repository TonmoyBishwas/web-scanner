/**
 * The owner's fixed "receipts in Priority" link — /priority/receipts?u=<users.id>&sig=<hex>.
 *
 * Unlike the 24-hour "needs attention" links (lib/admin-link.ts), this one
 * never expires: Mevaser opens it any time instead of getting a WhatsApp
 * text per receipt. The signed message is prefixed so a receipts signature
 * can never pass as an attention signature (or the other way round):
 *
 *   sig = hex( HMAC-SHA256( key = ADMIN_LINK_SECRET, message = "receipts." + u ) )
 *
 * `u` is users.id (a uuid), not the chat id, so the link carries no phone
 * number. Revoking: the page re-checks on every load that `u` is an ACTIVE
 * Admin (lib/receipts-auth.ts) — deactivate the user or take the Admin role
 * away and the link stops working. Rotating ADMIN_LINK_SECRET kills every
 * link (receipts and attention) at once.
 *
 * scripts/make-receipts-link.mjs prints a link with the same algorithm.
 *
 * Server only (node:crypto). Never import into a client component.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/** True for a users.id-shaped value (uuid, any case). */
export function isUserId(u: string): boolean {
  return USER_ID.test(u);
}

/** Hex HMAC-SHA256 of `receipts.${u}` (u lower-cased, as Postgres prints a uuid). */
export function signReceiptsLink(u: string, secret: string): string {
  return createHmac('sha256', secret).update(`receipts.${u.toLowerCase()}`, 'utf8').digest('hex');
}

/**
 * True only when `sig` is this server's receipts signature of `u`.
 * Constant-time compare; a blank secret or malformed input is simply false.
 */
export function verifyReceiptsLink(u: string, sig: string): boolean {
  // Trimmed like the bot's Config.ADMIN_LINK_SECRET (.strip()).
  const secret = (process.env.ADMIN_LINK_SECRET ?? '').trim();
  if (!secret) return false;
  if (!isUserId(u) || !HEX_SHA256.test(sig)) return false;
  const expected = Buffer.from(signReceiptsLink(u, secret), 'hex');
  const given = Buffer.from(sig.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
