/**
 * Signed admin links — the "Details and Send again" link in the bot's
 * Priority alerts opens /priority/attention?u=<chat_id>&exp=<unix s>&sig=<hex>.
 *
 * The bot signs (telegram-warehouse-bot/bot/services/admin_link.py,
 * make_admin_link); this file verifies. Both sides MUST compute the same
 * string for the same link, or every link in an office alert is refused:
 *
 *   sig = hex( HMAC-SHA256( key = ADMIN_LINK_SECRET, message = u + "." + exp ) )
 *
 * The secret is the same value on Railway and Vercel. Both sides trim
 * surrounding whitespace (the bot's Config.ADMIN_LINK_SECRET is
 * os.getenv(...).strip()), so a stray newline from `vercel env add` cannot
 * split them. Missing or blank → every link is refused. The link only
 * proves who it was sent to; the API routes also re-check that `u` is an
 * active Admin in `users` (lib/admin-auth.ts).
 *
 * Server only (node:crypto). Never import into a client component.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** The bot signs links for 24 h; anything claiming to live longer than this is refused. */
export const MAX_LINK_TTL_S = 7 * 24 * 60 * 60;

const CHAT_ID = /^\d{5,20}$/;
const UNIX_SECONDS = /^\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/** Hex HMAC-SHA256 of `${u}.${exp}` — the bot's make_admin_link signature. */
export function signAdminLink(u: string, exp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${u}.${exp}`, 'utf8').digest('hex');
}

/**
 * True only when `sig` is this server's signature of `u` + `exp`, and `exp`
 * (unix seconds) has not passed and is not more than MAX_LINK_TTL_S away.
 * Constant-time compare; malformed input is simply false.
 */
export function verifyAdminLink(u: string, exp: string, sig: string, nowSec?: number): boolean {
  // Trimmed like the bot's Config.ADMIN_LINK_SECRET (.strip()).
  const secret = (process.env.ADMIN_LINK_SECRET ?? '').trim();
  if (!secret) return false;
  if (!CHAT_ID.test(u) || !UNIX_SECONDS.test(exp) || !HEX_SHA256.test(sig)) return false;

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const expires = Number(exp);
  if (expires < now || expires > now + MAX_LINK_TTL_S) return false;

  const expected = Buffer.from(signAdminLink(u, exp, secret), 'hex');
  const given = Buffer.from(sig.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
