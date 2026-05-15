/**
 * Compute the LPN sticker signature shared with the bot.
 *
 * The bot's equivalent lives in
 * `telegram-warehouse-bot/bot/services/pallet_service.py:compute_lpn_signature`.
 * Both sides MUST produce the same string for the same LPN, or signature
 * verification on the bot's outbound photo gateway will reject our own
 * stickers.
 *
 *   sig = sha256(LPN_SECRET + lpn).hexdigest()[:8].upper()
 *   payload field = `WHPL-${sig}`
 *
 * If `LPN_SECRET` is empty / missing, returns '' — the bot accepts
 * unsigned URLs during rollout, so this fail-soft path is intentional.
 */
import { createHash } from 'crypto';
import { LPN_SIGNATURE_PREFIX } from './lpn-constants';

export function computeLpnSignature(lpn: string): string {
  const secret = (process.env.LPN_SECRET ?? '').trim();
  if (!secret) {
    return '';
  }
  const digest = createHash('sha256')
    .update(`${secret}${lpn}`, 'utf8')
    .digest('hex');
  return `${LPN_SIGNATURE_PREFIX}${digest.slice(0, 8).toUpperCase()}`;
}
