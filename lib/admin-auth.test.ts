import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireAdmin, LINK_INVALID, NOT_ADMIN, type AdminUserRow } from './admin-auth';
import { signAdminLink } from './admin-link';

const SECRET = 'test-secret';
const NOW = 1790990000;
const U = '8801858952852';
const EXP = String(NOW + 3600);
const link = (over: Record<string, unknown> = {}) => ({ u: U, exp: EXP, sig: signAdminLink(U, EXP, SECRET), ...over });

/** A users lookup that records which chat ids it was asked about. */
function lookupOf(rows: AdminUserRow[]) {
  const asked: string[] = [];
  const fn = async (chatId: string) => {
    asked.push(chatId);
    return rows;
  };
  return { fn, asked };
}

describe('requireAdmin', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ADMIN_LINK_SECRET;
    process.env.ADMIN_LINK_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_LINK_SECRET;
    else process.env.ADMIN_LINK_SECRET = saved;
  });

  it('an active Admin with a valid link → ok with the chat id', async () => {
    const users = lookupOf([{ role: 'Admin', active: true }]);
    expect(await requireAdmin(link(), users.fn, NOW)).toEqual({ ok: true, chatId: U });
    expect(users.asked).toEqual([U]);
  });

  it('a bad or expired link → 401, and users is never read', async () => {
    const users = lookupOf([{ role: 'Admin', active: true }]);
    expect(await requireAdmin(link({ sig: '0'.repeat(64) }), users.fn, NOW))
      .toEqual({ ok: false, status: 401, error: LINK_INVALID });
    expect(await requireAdmin(link(), users.fn, Number(EXP) + 1))
      .toEqual({ ok: false, status: 401, error: LINK_INVALID });
    expect(await requireAdmin({}, users.fn, NOW)).toEqual({ ok: false, status: 401, error: LINK_INVALID });
    expect(users.asked).toEqual([]);
  });

  it('a valid link for someone who is not an active Admin → 403', async () => {
    for (const rows of [
      [],
      [{ role: 'Manager', active: true }],
      [{ role: 'Admin', active: false }],
    ] as AdminUserRow[][]) {
      expect(await requireAdmin(link(), lookupOf(rows).fn, NOW)).toEqual({ ok: false, status: 403, error: NOT_ADMIN });
    }
  });

  it('one active Admin row among Telegram-era duplicates is enough', async () => {
    const rows: AdminUserRow[] = [{ role: 'Worker', active: true }, { role: 'Admin', active: true }];
    expect((await requireAdmin(link(), lookupOf(rows).fn, NOW)).ok).toBe(true);
  });

  it('non-string params are treated as missing', async () => {
    const users = lookupOf([{ role: 'Admin', active: true }]);
    expect((await requireAdmin({ u: Number(U), exp: Number(EXP), sig: 42 }, users.fn, NOW)).ok).toBe(false);
  });
});
