import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireReceiptsAdmin, RECEIPTS_LINK_INVALID, RECEIPTS_NOT_ADMIN, type ReceiptsUserRow } from './receipts-auth';
import { signReceiptsLink } from './receipts-link';

const SECRET = 'test-secret';
const U = '11111111-2222-4333-8444-555555555555';
const link = (over: Record<string, unknown> = {}) => ({ u: U, sig: signReceiptsLink(U, SECRET), ...over });

function lookupOf(row: ReceiptsUserRow | null) {
  const asked: string[] = [];
  const fn = async (id: string) => {
    asked.push(id);
    return row;
  };
  return { fn, asked };
}

describe('requireReceiptsAdmin', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ADMIN_LINK_SECRET;
    process.env.ADMIN_LINK_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_LINK_SECRET;
    else process.env.ADMIN_LINK_SECRET = saved;
  });

  it('lets an active Admin in, with the chat id for the attention link', async () => {
    const l = lookupOf({ role: 'Admin', active: true, chat_id: 8801858952852 });
    expect(await requireReceiptsAdmin(link({ u: U.toUpperCase() }), l.fn)).toEqual({
      ok: true,
      userId: U,
      chatId: '8801858952852',
    });
    expect(l.asked).toEqual([U]);
  });

  it('401 for a bad signature, without reading users', async () => {
    const l = lookupOf({ role: 'Admin', active: true, chat_id: null });
    expect(await requireReceiptsAdmin(link({ sig: '0'.repeat(64) }), l.fn)).toEqual({
      ok: false,
      status: 401,
      error: RECEIPTS_LINK_INVALID,
    });
    expect(await requireReceiptsAdmin({ u: 5, sig: null }, l.fn)).toMatchObject({ status: 401 });
    expect(l.asked).toEqual([]);
  });

  it('403 once the user is deactivated, not an Admin, or gone (the revoke path)', async () => {
    for (const row of [
      { role: 'Admin', active: false, chat_id: null },
      { role: 'Manager', active: true, chat_id: null },
      { role: 'Admin', active: null, chat_id: null },
      null,
    ] as (ReceiptsUserRow | null)[]) {
      expect(await requireReceiptsAdmin(link(), lookupOf(row).fn)).toEqual({
        ok: false,
        status: 403,
        error: RECEIPTS_NOT_ADMIN,
      });
    }
  });

  it('an Admin without a chat id still gets in (no attention link then)', async () => {
    expect(await requireReceiptsAdmin(link(), lookupOf({ role: 'Admin', active: true, chat_id: null }).fn)).toEqual({
      ok: true,
      userId: U,
      chatId: null,
    });
  });
});
