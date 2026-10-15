#!/usr/bin/env node
/**
 * Print the owner's fixed receipts link for one users.id:
 *
 *   ADMIN_LINK_SECRET=… node scripts/make-receipts-link.mjs <users.id> [base-url]
 *   # e.g. with the production secret, without it touching the shell history:
 *   vercel env pull .env.receipts --environment=production && \
 *     node --env-file=.env.receipts scripts/make-receipts-link.mjs <users.id>; rm .env.receipts
 *
 * Same algorithm as lib/receipts-link.ts (keep them in step — the
 * receipts-link test runs this script against the TS signer):
 *
 *   sig = hex( HMAC-SHA256( key = trim(ADMIN_LINK_SECRET), message = "receipts." + lower(u) ) )
 *   link = <base>/priority/receipts?u=<u>&sig=<sig>
 *
 * The link never expires. It works only while <users.id> is an ACTIVE
 * Admin; deactivate the user (or rotate ADMIN_LINK_SECRET) to revoke it.
 * The secret is read from the environment only — never pass it as an
 * argument and never commit the printed link.
 */
import { createHmac } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BASE = 'https://web-scanner-psi.vercel.app';

const u = (process.argv[2] ?? '').trim().toLowerCase();
const base = (process.argv[3] ?? process.env.SCANNER_BASE_URL ?? DEFAULT_BASE).trim().replace(/\/+$/, '');
const secret = (process.env.ADMIN_LINK_SECRET ?? '').trim();

if (!UUID.test(u)) {
  console.error('usage: node scripts/make-receipts-link.mjs <users.id (uuid)> [base-url]');
  process.exit(2);
}
if (!secret) {
  console.error('ADMIN_LINK_SECRET is not set in the environment.');
  process.exit(2);
}

const sig = createHmac('sha256', secret).update(`receipts.${u}`, 'utf8').digest('hex');
const q = new URLSearchParams({ u, sig });
console.log(`${base}/priority/receipts?${q.toString()}`);
