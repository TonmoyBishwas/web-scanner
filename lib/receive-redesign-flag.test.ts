import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * receiveRedesignOn (28/10): the receive form's redesign is per chat in
 * public.scanner_flags, and anything unreadable is OFF — the live form must
 * never switch to the redesign because the flag could not be read.
 */
type Reply = { data: unknown; error: unknown } | 'throw';
let reply: Reply = { data: null, error: null };

vi.mock('./supabase', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => (reply === 'throw' ? Promise.reject(new Error('down')) : Promise.resolve(reply));
      return chain;
    },
  },
}));

async function on(chat: string): Promise<boolean> {
  vi.resetModules(); // a fresh 30 s cache per case
  const { receiveRedesignOn } = await import('./scanner-flags');
  return receiveRedesignOn(chat);
}

afterEach(() => {
  reply = { data: null, error: null };
});

describe('receiveRedesignOn', () => {
  it('no row → off', async () => {
    expect(await on('999000000001')).toBe(false);
  });
  it('listed chat → on; another chat → off', async () => {
    reply = { data: { enabled_all: false, chat_ids: ['999000000001'] }, error: null };
    expect(await on('999000000001')).toBe(true);
    expect(await on('972500000000')).toBe(false);
  });
  it('enabled_all → on for everyone', async () => {
    reply = { data: { enabled_all: true, chat_ids: [] }, error: null };
    expect(await on('972500000000')).toBe(true);
  });
  it('a DB error or a throw → off', async () => {
    reply = { data: { enabled_all: true }, error: { message: 'relation "scanner_flags" does not exist' } };
    expect(await on('999000000001')).toBe(false);
    reply = 'throw';
    expect(await on('999000000001')).toBe(false);
  });
});
