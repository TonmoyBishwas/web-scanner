import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RECEIPT_FORM_LINK_TTL_S,
  isUuid,
  signReceiptFormLink,
  verifyReceiptFormLink,
} from './receipt-form-link';

/**
 * The SAME fixed vector as the bot's receipt-form link test. If either side
 * changes how it signs, one of the two tests breaks.
 *   HMAC-SHA256(key 'test-secret', 'receipt-form.<ID>.1791000000'), hex
 */
const ID = '11111111-2222-3333-4444-555555555555';
const EXP = '1791000000';
const SECRET = 'test-secret';
const SIG = 'd9ccbb8ca569dfb3c6b368b8476452eb2916d1c6d88d3c798f63096eb8419e1e';
const BEFORE = 1790990000;

describe('signReceiptFormLink', () => {
  it('matches the shared vector', () => {
    expect(signReceiptFormLink(ID, EXP, SECRET)).toBe(SIG);
  });
});

describe('isUuid', () => {
  it('accepts uuids only', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid(ID.toUpperCase())).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(ID + '0')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('verifyReceiptFormLink', () => {
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
    expect(verifyReceiptFormLink(ID, EXP, SIG, BEFORE)).toBe(true);
    expect(verifyReceiptFormLink(ID, EXP, SIG.toUpperCase(), BEFORE)).toBe(true);
    expect(verifyReceiptFormLink(ID, EXP, SIG, Number(EXP))).toBe(true);
  });

  it('refuses it once exp has passed', () => {
    expect(verifyReceiptFormLink(ID, EXP, SIG, Number(EXP) + 1)).toBe(false);
  });

  it('refuses an exp more than 7 days away', () => {
    const far = String(BEFORE + MAX_RECEIPT_FORM_LINK_TTL_S + 60);
    expect(verifyReceiptFormLink(ID, far, signReceiptFormLink(ID, far, SECRET), BEFORE)).toBe(false);
    const ok = String(BEFORE + MAX_RECEIPT_FORM_LINK_TTL_S);
    expect(verifyReceiptFormLink(ID, ok, signReceiptFormLink(ID, ok, SECRET), BEFORE)).toBe(true);
  });

  it('refuses any change to id, exp or sig', () => {
    expect(verifyReceiptFormLink('11111111-2222-3333-4444-555555555556', EXP, SIG, BEFORE)).toBe(false);
    expect(verifyReceiptFormLink(ID, '1791000001', SIG, BEFORE)).toBe(false);
    expect(verifyReceiptFormLink(ID, EXP, SIG.slice(0, 63) + '0', BEFORE)).toBe(false);
  });

  it('is not interchangeable with an admin-link signature', () => {
    // admin-link signs `${u}.${exp}` — no prefix.
    const adminStyle = createHmac('sha256', SECRET).update(`${ID}.${EXP}`).digest('hex');
    expect(verifyReceiptFormLink(ID, EXP, adminStyle, BEFORE)).toBe(false);
  });

  it('refuses a link signed with another secret', () => {
    expect(verifyReceiptFormLink(ID, EXP, signReceiptFormLink(ID, EXP, 'other'), BEFORE)).toBe(false);
  });

  it('refuses everything when ADMIN_LINK_SECRET is unset or blank; trims it otherwise', () => {
    delete process.env.ADMIN_LINK_SECRET;
    expect(verifyReceiptFormLink(ID, EXP, SIG, BEFORE)).toBe(false);
    process.env.ADMIN_LINK_SECRET = '  \n';
    expect(verifyReceiptFormLink(ID, EXP, SIG, BEFORE)).toBe(false);
    process.env.ADMIN_LINK_SECRET = ` ${SECRET}\n`;
    expect(verifyReceiptFormLink(ID, EXP, SIG, BEFORE)).toBe(true);
  });

  it('refuses malformed input without throwing', () => {
    expect(verifyReceiptFormLink('', EXP, SIG, BEFORE)).toBe(false);
    expect(verifyReceiptFormLink('not-a-uuid', EXP, SIG, BEFORE)).toBe(false);
    expect(verifyReceiptFormLink(ID, '', SIG, BEFORE)).toBe(false);
    expect(verifyReceiptFormLink(ID, 'soon', SIG, BEFORE)).toBe(false);
    expect(verifyReceiptFormLink(ID, EXP, 'not-hex', BEFORE)).toBe(false);
    expect(verifyReceiptFormLink(ID, EXP, SIG + '00', BEFORE)).toBe(false);
    // @ts-expect-error — runtime guard for non-string input
    expect(verifyReceiptFormLink(undefined, EXP, SIG, BEFORE)).toBe(false);
  });
});
