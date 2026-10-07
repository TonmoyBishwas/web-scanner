import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signAdminLink, verifyAdminLink, MAX_LINK_TTL_S } from './admin-link';

/**
 * The SAME fixed vector as the bot's admin-link test
 * (telegram-warehouse-bot bot/services/admin_link.py). If either side
 * changes how it signs, one of the two tests breaks.
 *   HMAC-SHA256(key 'test-secret', '8801858952852.1791000000'), hex
 */
const U = '8801858952852';
const EXP = '1791000000'; // 2026-10-03T04:00:00Z
const SECRET = 'test-secret';
const SIG = '27a2115c38ba0d39270f5889dc43d5c0f82bd3686cb6408b7ee3dff9815534fb';
/** A moment before EXP, so the vector is still valid. */
const BEFORE = 1790990000;

describe('signAdminLink', () => {
  it('matches the shared vector', () => {
    expect(signAdminLink(U, EXP, SECRET)).toBe(SIG);
  });
});

describe('verifyAdminLink', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ADMIN_LINK_SECRET;
    process.env.ADMIN_LINK_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_LINK_SECRET;
    else process.env.ADMIN_LINK_SECRET = saved;
  });

  it('accepts the bot-signed link before it expires (any hex case)', () => {
    expect(verifyAdminLink(U, EXP, SIG, BEFORE)).toBe(true);
    expect(verifyAdminLink(U, EXP, SIG.toUpperCase(), BEFORE)).toBe(true);
    expect(verifyAdminLink(U, EXP, SIG, Number(EXP))).toBe(true); // the last valid second
  });

  it('refuses it once exp has passed', () => {
    expect(verifyAdminLink(U, EXP, SIG, Number(EXP) + 1)).toBe(false);
  });

  it('refuses a link whose exp is further away than any link the bot makes', () => {
    const far = String(BEFORE + MAX_LINK_TTL_S + 60);
    expect(verifyAdminLink(U, far, signAdminLink(U, far, SECRET), BEFORE)).toBe(false);
  });

  it('refuses any change to u, exp or sig', () => {
    expect(verifyAdminLink('8801858952853', EXP, SIG, BEFORE)).toBe(false);
    expect(verifyAdminLink(U, '1791000001', SIG, BEFORE)).toBe(false);
    expect(verifyAdminLink(U, EXP, SIG.slice(0, 63) + '0', BEFORE)).toBe(false);
  });

  it('refuses a link signed with another secret', () => {
    expect(verifyAdminLink(U, EXP, signAdminLink(U, EXP, 'other-secret'), BEFORE)).toBe(false);
  });

  it('refuses everything when ADMIN_LINK_SECRET is not set', () => {
    delete process.env.ADMIN_LINK_SECRET;
    expect(verifyAdminLink(U, EXP, SIG, BEFORE)).toBe(false);
    process.env.ADMIN_LINK_SECRET = '';
    expect(verifyAdminLink(U, EXP, SIG, BEFORE)).toBe(false);
    process.env.ADMIN_LINK_SECRET = '  \n';
    expect(verifyAdminLink(U, EXP, SIG, BEFORE)).toBe(false);
  });

  it('trims the secret like the bot does (Config.ADMIN_LINK_SECRET is .strip()ped)', () => {
    process.env.ADMIN_LINK_SECRET = ` ${SECRET}\n`;
    expect(verifyAdminLink(U, EXP, SIG, BEFORE)).toBe(true);
  });

  it('refuses malformed input without throwing', () => {
    expect(verifyAdminLink('', EXP, SIG, BEFORE)).toBe(false);
    expect(verifyAdminLink(`${U}.${EXP}`, '', SIG, BEFORE)).toBe(false);
    expect(verifyAdminLink(U, 'soon', SIG, BEFORE)).toBe(false);
    expect(verifyAdminLink(U, EXP, 'not-hex', BEFORE)).toBe(false);
    expect(verifyAdminLink(U, EXP, SIG + '00', BEFORE)).toBe(false);
  });
});
