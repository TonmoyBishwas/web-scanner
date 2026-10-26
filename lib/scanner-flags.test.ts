import { describe, expect, it } from 'vitest';
import { cachedFlagRow, flagEnabledFor } from './scanner-flags';

describe('flagEnabledFor', () => {
  it('on for everyone', () => {
    expect(flagEnabledFor({ enabled_all: true, chat_ids: [] }, '972500000000')).toBe(true);
    expect(flagEnabledFor({ enabled_all: true }, null)).toBe(true);
  });

  it('on for a listed chat only', () => {
    const row = { enabled_all: false, chat_ids: ['999000000001', '999000000030'] };
    expect(flagEnabledFor(row, '999000000001')).toBe(true);
    expect(flagEnabledFor(row, 999000000030)).toBe(true);
    expect(flagEnabledFor(row, '972500000000')).toBe(false);
    expect(flagEnabledFor(row, '')).toBe(false);
    expect(flagEnabledFor(row, undefined)).toBe(false);
  });

  it('off for anything unreadable', () => {
    expect(flagEnabledFor(null, '999000000001')).toBe(false);
    expect(flagEnabledFor({ enabled_all: 'true', chat_ids: '999000000001' }, '999000000001')).toBe(false);
    expect(flagEnabledFor({}, '999000000001')).toBe(false);
  });
});

describe('cachedFlagRow', () => {
  it('loads once per ttl', async () => {
    let t = 0;
    let loads = 0;
    const get = cachedFlagRow(async () => { loads++; return { enabled_all: loads > 1 }; }, 1000, () => t);
    expect(await get()).toEqual({ enabled_all: false });
    t = 999;
    expect(await get()).toEqual({ enabled_all: false });
    expect(loads).toBe(1);
    t = 1000;
    expect(await get()).toEqual({ enabled_all: true });
    expect(loads).toBe(2);
  });

  it('a failed load is no row (off)', async () => {
    const get = cachedFlagRow(async () => { throw new Error('relation "scanner_flags" does not exist'); });
    expect(await get()).toBeNull();
  });
});
