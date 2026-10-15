import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { pendingLabelsUrl, signLabelsLink, verifyLabelsLink } from './label-link';

const SECRET = 'test-secret';

describe('signLabelsLink', () => {
  it('is hex HMAC-SHA256 of "labels:" + document (the bot computes the same)', () => {
    const expected = createHmac('sha256', SECRET).update('labels:IN26013461').digest('hex');
    expect(signLabelsLink('IN26013461', SECRET)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('trims the secret like the LPN signature does', () => {
    expect(signLabelsLink('IN1', ` ${SECRET}\n`)).toBe(signLabelsLink('IN1', SECRET));
  });

  it('signs nothing without a secret or a document', () => {
    expect(signLabelsLink('IN1', '')).toBe('');
    expect(signLabelsLink('IN1', '   ')).toBe('');
    expect(signLabelsLink('', SECRET)).toBe('');
  });
});

describe('verifyLabelsLink', () => {
  const sig = signLabelsLink('IN26013461', SECRET);

  it('accepts its own signature, in either case', () => {
    expect(verifyLabelsLink('IN26013461', sig, SECRET)).toBe(true);
    expect(verifyLabelsLink('IN26013461', sig.toUpperCase(), SECRET)).toBe(true);
  });

  it('refuses another document', () => {
    expect(verifyLabelsLink('IN26013462', sig, SECRET)).toBe(false);
  });

  it('refuses another secret, and fails closed without one', () => {
    expect(verifyLabelsLink('IN26013461', sig, 'other')).toBe(false);
    expect(verifyLabelsLink('IN26013461', sig, '')).toBe(false);
  });

  it('refuses malformed signatures', () => {
    expect(verifyLabelsLink('IN26013461', null, SECRET)).toBe(false);
    expect(verifyLabelsLink('IN26013461', '', SECRET)).toBe(false);
    expect(verifyLabelsLink('IN26013461', sig.slice(0, 63), SECRET)).toBe(false);
    expect(verifyLabelsLink('IN26013461', `${sig.slice(0, 63)}z`, SECRET)).toBe(false);
  });
});

describe('pendingLabelsUrl', () => {
  it('builds the page URL with an encoded document and the sig', () => {
    const url = pendingLabelsUrl('https://scanner.example/', 'IN 1/2', SECRET);
    expect(url).toBe(`https://scanner.example/labels/pending/IN%201%2F2?sig=${signLabelsLink('IN 1/2', SECRET)}`);
  });

  it('is null when it cannot be signed', () => {
    expect(pendingLabelsUrl('https://x', 'IN1', '')).toBeNull();
    expect(pendingLabelsUrl('https://x', null, SECRET)).toBeNull();
  });
});
