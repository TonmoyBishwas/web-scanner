/**
 * Signed links to the non-meat "fill in what's missing" form —
 * `/receive/{form_id}?exp=<unix s>&sig=<hex>`.
 *
 * The bot signs (3-day links); this file verifies, on the page AND again on
 * the API route. Both sides MUST compute the same string:
 *
 *   sig = hex( HMAC-SHA256( key = ADMIN_LINK_SECRET (trimmed),
 *                           message = "receipt-form." + form_id + "." + exp ) )
 *
 * The "receipt-form." prefix keeps this signature from ever being valid as
 * an admin link (lib/admin-link.ts signs `u.exp` with the same secret).
 * Missing or blank secret → every link is refused.
 *
 * Server only (node:crypto). Never import into a client component.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** The bot signs for 3 days; anything claiming to live longer than 7 is refused. */
export const MAX_RECEIPT_FORM_LINK_TTL_S = 7 * 24 * 60 * 60;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UNIX_SECONDS = /^\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/** Hex HMAC-SHA256 of `receipt-form.${formId}.${exp}`. */
export function signReceiptFormLink(formId: string, exp: string, secret: string): string {
  return createHmac('sha256', secret).update(`receipt-form.${formId}.${exp}`, 'utf8').digest('hex');
}

/**
 * True only when `sig` is this server's signature of `formId` + `exp`, the
 * form id is a uuid, and `exp` (unix seconds) has not passed and is not more
 * than 7 days away. Constant-time compare; malformed input is simply false.
 */
export function verifyReceiptFormLink(formId: string, exp: string, sig: string, nowSec?: number): boolean {
  const secret = (process.env.ADMIN_LINK_SECRET ?? '').trim();
  if (!secret) return false;
  if (typeof formId !== 'string' || typeof exp !== 'string' || typeof sig !== 'string') return false;
  if (!UUID.test(formId) || !UNIX_SECONDS.test(exp) || !HEX_SHA256.test(sig)) return false;

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const expires = Number(exp);
  if (expires < now || expires > now + MAX_RECEIPT_FORM_LINK_TTL_S) return false;

  const expected = Buffer.from(signReceiptFormLink(formId, exp, secret), 'hex');
  const given = Buffer.from(sig.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
