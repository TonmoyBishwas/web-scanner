/**
 * Signed "labels waiting to be printed" links (2026-10-15).
 *
 * With the print gate off (LABEL_PRINT_GATE, lib/label-gate.ts) a pallet can
 * be booked while its saved labels are still unprinted, and the scanner
 * session that saved them expires two hours later — so a "print later" link
 * cannot ride on the session token. It is signed per delivery note instead:
 *
 *   sig = hex( HMAC-SHA256( key = LPN_SECRET, message = "labels:" + document_number ) )
 *   url = <scanner origin>/labels/pending/<encodeURIComponent(document_number)>?sig=<sig>
 *
 * The bot builds the same link for its unprinted-labels message (Python):
 *
 *   sig = hmac.new(Config.LPN_SECRET.strip().encode(), f"labels:{doc}".encode(),
 *                  hashlib.sha256).hexdigest()
 *
 * Both sides trim the secret (the LPN sticker signature already does,
 * lib/lpn-signature.ts / pallet_service.compute_lpn_signature). A missing or
 * blank secret signs nothing ('') and verifies nothing (fail closed). The
 * link opens one delivery's labels and lets them be printed and marked
 * printed — nothing else (no delete, no booking).
 *
 * Server only (node:crypto). Never import into a client component.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

function secretOf(raw: string | undefined): string {
  return (raw ?? '').trim();
}

/** Hex HMAC-SHA256 of `labels:<doc>`; '' when there is no secret or no doc. */
export function signLabelsLink(documentNumber: string, secret = process.env.LPN_SECRET): string {
  const key = secretOf(secret);
  const doc = (documentNumber ?? '').trim();
  if (!key || !doc) return '';
  return createHmac('sha256', key).update(`labels:${doc}`, 'utf8').digest('hex');
}

/** Constant-time check of a link's `sig` for this document. Malformed → false. */
export function verifyLabelsLink(
  documentNumber: string,
  sig: string | null | undefined,
  secret = process.env.LPN_SECRET,
): boolean {
  if (!sig || !HEX_SHA256.test(sig)) return false;
  const expectedHex = signLabelsLink(documentNumber, secret);
  if (!expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(sig.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The absolute pending-labels URL for a delivery note, or null when it cannot
 * be signed (no secret / no document). `origin` has no trailing slash needed.
 */
export function pendingLabelsUrl(
  origin: string,
  documentNumber: string | null | undefined,
  secret = process.env.LPN_SECRET,
): string | null {
  const doc = (documentNumber ?? '').trim();
  const sig = signLabelsLink(doc, secret);
  if (!sig) return null;
  return `${origin.replace(/\/+$/, '')}/labels/pending/${encodeURIComponent(doc)}?sig=${sig}`;
}
