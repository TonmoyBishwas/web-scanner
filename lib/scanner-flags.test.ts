import { describe, expect, it, vi } from 'vitest';

// No real database in a unit test: every flag read fails, and a failed read is off.
vi.mock('./supabase', () => ({
  supabase: { from: () => { throw new Error('no database in tests'); } },
}));
import { cachedFlagRow, flagEnabledFor, identicalNoSerialOn, manualCaptureReviewOn, manualTargetHintOn, ocrNetworkNoticeOn, shortSerialGate } from './scanner-flags';

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

describe('shortSerialGate (camera_short_serial, item 1 04/11)', () => {
  const WALL_DAN = '515215705';
  const DAVID = '972500000001';
  function gate(opts: { row?: unknown; vat?: () => Promise<string | null> } = {}) {
    let t = 0;
    const calls: string[] = [];
    const row = 'row' in opts ? opts.row : { enabled_all: false, chat_ids: [DAVID] };
    const g = shortSerialGate(
      async () => row as never,
      async (id) => { calls.push(id); return opts.vat ? opts.vat() : WALL_DAN; },
      [WALL_DAN],
      1000,
      () => t,
    );
    return { g, calls, tick: (ms: number) => { t += ms; } };
  }

  it('on only with the row on for the chat AND the receipt a Wall Dan one', async () => {
    expect(await gate().g(DAVID, 'r1')).toBe(true);
  });

  it('off with no row, or a row for another chat — the VAT is not even looked up', async () => {
    const none = gate({ row: null });
    expect(await none.g(DAVID, 'r1')).toBe(false);
    expect(none.calls).toEqual([]);
    const other = gate();
    expect(await other.g('972500000099', 'r1')).toBe(false);
    expect(other.calls).toEqual([]);
  });

  it('off with no receipt id', async () => {
    expect(await gate().g(DAVID, undefined)).toBe(false);
    expect(await gate().g(DAVID, '')).toBe(false);
  });

  it('off with a null VAT, another VAT, or a lookup that throws', async () => {
    expect(await gate({ vat: async () => null }).g(DAVID, 'r1')).toBe(false);
    expect(await gate({ vat: async () => '514000000' }).g(DAVID, 'r1')).toBe(false);
    expect(await gate({ vat: async () => { throw new Error('boom'); } }).g(DAVID, 'r1')).toBe(false);
  });

  it('a found VAT is not asked again within the TTL', async () => {
    const x = gate();
    await x.g(DAVID, 'r1');
    x.tick(999);
    await x.g(DAVID, 'r1');
    expect(x.calls).toEqual(['r1']);
    x.tick(1);
    await x.g(DAVID, 'r1');
    expect(x.calls).toEqual(['r1', 'r1']);
  });

  it('a null VAT is asked again on the next call (never cached)', async () => {
    let vat: string | null = null;
    const x = gate({ vat: async () => vat });
    expect(await x.g(DAVID, 'r1')).toBe(false);
    vat = WALL_DAN;
    expect(await x.g(DAVID, 'r1')).toBe(true);
    expect(x.calls).toEqual(['r1', 'r1']);
  });
});

describe('manualCaptureReviewOn', () => {
  it('is off, never a throw, when the flag cannot be read', async () => {
    await expect(manualCaptureReviewOn('972544965384')).resolves.toBe(false);
  });
});

describe('manualTargetHintOn', () => {
  it('is off, never a throw, when the flag cannot be read', async () => {
    await expect(manualTargetHintOn('972544965384')).resolves.toBe(false);
  });
});

describe('identicalNoSerialOn', () => {
  it('is off, never a throw, when the flag cannot be read', async () => {
    await expect(identicalNoSerialOn('972544965384')).resolves.toBe(false);
  });
});

describe('ocrNetworkNoticeOn', () => {
  it('is off, never a throw, when the flag cannot be read', async () => {
    await expect(ocrNetworkNoticeOn('972544965384')).resolves.toBe(false);
  });
});
