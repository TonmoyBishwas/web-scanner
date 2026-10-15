import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isUserId, signReceiptsLink, verifyReceiptsLink } from './receipts-link';
import { signAdminLink, verifyAdminLink } from './admin-link';

/**
 * Fixed vector: HMAC-SHA256(key 'test-secret', 'receipts.11111111-2222-4333-8444-555555555555'), hex.
 * scripts/make-receipts-link.mjs must print the same signature.
 */
const U = '11111111-2222-4333-8444-555555555555';
const SECRET = 'test-secret';
const SIG = '99ca283b917f1eae5a1a8065b19cc62af09955b413db00e58aa68e702de4055f';

describe('signReceiptsLink', () => {
  it('matches the fixed vector, whatever the case of the uuid', () => {
    expect(signReceiptsLink(U, SECRET)).toBe(SIG);
    expect(signReceiptsLink(U.toUpperCase(), SECRET)).toBe(SIG);
  });

  it('cannot be replayed as an attention link: that one needs a numeric chat id and exp', () => {
    // signAdminLink('receipts', U) signs the very same bytes, so the separation is the
    // attention verifier's format check (u = 5-20 digits, exp = digits), pinned here.
    const saved = process.env.ADMIN_LINK_SECRET;
    process.env.ADMIN_LINK_SECRET = SECRET;
    try {
      expect(verifyAdminLink('receipts', U, SIG)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ADMIN_LINK_SECRET;
      else process.env.ADMIN_LINK_SECRET = saved;
    }
  });
});

describe('isUserId', () => {
  it('takes a uuid only', () => {
    expect(isUserId(U)).toBe(true);
    expect(isUserId(U.toUpperCase())).toBe(true);
    expect(isUserId('8801858952852')).toBe(false);
    expect(isUserId(`${U}x`)).toBe(false);
    expect(isUserId('')).toBe(false);
  });
});

describe('verifyReceiptsLink', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ADMIN_LINK_SECRET;
    process.env.ADMIN_LINK_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_LINK_SECRET;
    else process.env.ADMIN_LINK_SECRET = saved;
  });

  it('accepts the signed link (any hex case, any uuid case) and never expires', () => {
    expect(verifyReceiptsLink(U, SIG)).toBe(true);
    expect(verifyReceiptsLink(U, SIG.toUpperCase())).toBe(true);
    expect(verifyReceiptsLink(U.toUpperCase(), SIG)).toBe(true);
  });

  it('trims the secret like the bot does', () => {
    process.env.ADMIN_LINK_SECRET = `  ${SECRET}\n`;
    expect(verifyReceiptsLink(U, SIG)).toBe(true);
  });

  it('refuses another user, a tampered or short sig, and a malformed id', () => {
    expect(verifyReceiptsLink('11111111-2222-4333-8444-555555555556', SIG)).toBe(false);
    expect(verifyReceiptsLink(U, `${SIG.slice(0, 63)}0`)).toBe(false);
    expect(verifyReceiptsLink(U, SIG.slice(0, 40))).toBe(false);
    expect(verifyReceiptsLink('8801858952852', SIG)).toBe(false);
    expect(verifyReceiptsLink('', '')).toBe(false);
  });

  it('refuses an attention-link signature', () => {
    expect(verifyReceiptsLink(U, signAdminLink(U, '1791000000', SECRET))).toBe(false);
  });

  it('refuses everything when the secret is missing or blank', () => {
    delete process.env.ADMIN_LINK_SECRET;
    expect(verifyReceiptsLink(U, SIG)).toBe(false);
    process.env.ADMIN_LINK_SECRET = '   ';
    expect(verifyReceiptsLink(U, SIG)).toBe(false);
  });
});

describe('scripts/make-receipts-link.mjs', () => {
  const script = path.resolve(__dirname, '../scripts/make-receipts-link.mjs');
  const run = (args: string[], env: Record<string, string>) =>
    execFileSync(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  it('prints the same link the page verifies', () => {
    expect(run([U.toUpperCase(), 'https://scanner.example/'], { ADMIN_LINK_SECRET: `${SECRET}\n` })).toBe(
      `https://scanner.example/priority/receipts?u=${U}&sig=${SIG}`,
    );
  });

  it('refuses without a secret or with a non-uuid id', () => {
    expect(() => run([U], {})).toThrow();
    expect(() => run(['8801858952852'], { ADMIN_LINK_SECRET: SECRET })).toThrow();
  });
});
