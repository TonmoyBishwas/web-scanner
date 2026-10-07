import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signAdminLink } from './admin-link';

/**
 * The three needs-attention API routes against a fake Supabase client:
 * the link + admin gate, exactly what each sends to the database, and how
 * a refusal comes back. Nothing here reaches a database.
 */
const rpc = vi.fn();
const tables: Record<string, unknown[]> = {};
/** A table whose read fails (e.g. delivery_gaps_v before M5 is applied). */
const errors: Record<string, { message: string; code?: string }> = {};
const fromCalls: string[] = [];
/** Every .eq(column, value) a route's query made, with the table it was made on. */
const eqCalls: { table: string; args: unknown[] }[] = [];

/** supabase.from(table)…: every builder method returns the chain; awaiting it gives the table's rows. */
function fakeFrom(table: string) {
  fromCalls.push(table);
  const result = errors[table] ? { data: null, error: errors[table] } : { data: tables[table] ?? [], error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'order', 'limit']) chain[m] = () => chain;
  chain.eq = (...args: unknown[]) => {
    eqCalls.push({ table, args });
    return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => fakeFrom(table),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const { GET: attentionGET } = await import('@/app/api/priority/attention/route');
const { POST: resendPOST } = await import('@/app/api/priority/resend/route');
const { POST: markFoundPOST } = await import('@/app/api/priority/mark-found/route');

const SECRET = 'test-secret';
const U = '8801858952852';
const EXP = String(Math.floor(Date.now() / 1000) + 3600);
const SIG = signAdminLink(U, EXP, SECRET);

const post = (path: string, body: unknown) =>
  new NextRequest(`http://scanner.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ADMIN_LINK_SECRET;
  process.env.ADMIN_LINK_SECRET = SECRET;
  rpc.mockReset();
  fromCalls.length = 0;
  eqCalls.length = 0;
  tables.users = [{ role: 'Admin', active: true }];
  tables.priority_push_attention_v = [{ outbox_id: 45, problem: 'failed' }];
  delete tables.delivery_gaps_v;
  for (const k of Object.keys(errors)) delete errors[k];
});
afterEach(() => {
  if (saved === undefined) delete process.env.ADMIN_LINK_SECRET;
  else process.env.ADMIN_LINK_SECRET = saved;
});

describe('GET /api/priority/attention', () => {
  const get = (q: string) => attentionGET(new NextRequest(`http://scanner.test/api/priority/attention?${q}`));

  it('an active Admin with a valid link gets the rows', async () => {
    const res = await get(`u=${U}&exp=${EXP}&sig=${SIG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      rows: [{ outbox_id: 45, problem: 'failed' }],
      truncated: false,
      fixes: [],
      fixes_available: true,
    });
    expect(fromCalls).toEqual(['users', 'priority_push_attention_v', 'delivery_gaps_v']);
    // the Admin lookup is filtered to THIS link's chat id: a dropped filter would admit any link holder
    expect(eqCalls).toEqual([{ table: 'users', args: ['chat_id', U] }]);
  });

  // English: לחם = "bread"; אגמי = Agami (supplier)
  it('lines to check in Priority come from delivery_gaps_v, one entry per delivery', async () => {
    const line = {
      delivery_id: 'd1', document_number: '241954682', supplier: 'אגמי', name: 'לחם', unit: 'units', // English: Agami, bread
      gap_note: null, gr_docno: 'GR26000045', created_at: '2026-10-07T07:00:00Z',
    };
    tables.delivery_gaps_v = [
      { ...line, code: '1079', invoice_qty: 525, received_qty: 20, gap_reason: 'supplier_short', rest_expected: 'wont_come',
        count_source: 'counted', unit_risk: 'no_item_defaults_kg', item_not_linked: true },
      { ...line, code: '1003', invoice_qty: 20, received_qty: 20, gap_reason: null, rest_expected: null,
        count_source: 'invoice_assumed', unit_risk: null, item_not_linked: false },
    ];
    const json = await (await get(`u=${U}&exp=${EXP}&sig=${SIG}`)).json();
    expect(json.fixes_available).toBe(true);
    expect(json.fixes).toHaveLength(1);
    expect(json.fixes[0]).toMatchObject({ delivery_id: 'd1', document_number: '241954682', gr_docno: 'GR26000045' });
    expect(json.fixes[0].lines.map((l: { code: string }) => l.code)).toEqual(['1003', '1079']);
  });

  it('delivery_gaps_v not readable (M5 not applied yet): the list still loads, with no lines to fix', async () => {
    errors.delivery_gaps_v = { message: 'relation "public.delivery_gaps_v" does not exist', code: '42P01' };
    const res = await get(`u=${U}&exp=${EXP}&sig=${SIG}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rows).toEqual([{ outbox_id: 45, problem: 'failed' }]);
    expect(json.fixes).toEqual([]);
    expect(json.fixes_available).toBe(false);
  });

  it('a bad link → 401 before anything is read', async () => {
    const res = await get(`u=${U}&exp=${EXP}&sig=${'0'.repeat(64)}`);
    expect(res.status).toBe(401);
    expect(fromCalls).toEqual([]);
  });

  it('not an active Admin → 403, and the view is not read', async () => {
    tables.users = [{ role: 'Manager', active: true }];
    const res = await get(`u=${U}&exp=${EXP}&sig=${SIG}`);
    expect(res.status).toBe(403);
    expect(fromCalls).toEqual(['users']);
  });

  it('the view cannot be read → 500 with the plain message, never an empty list', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.priority_push_attention_v = { message: 'permission denied for view priority_push_attention_v', code: '42501' };
    const res = await get(`u=${U}&exp=${EXP}&sig=${SIG}`);
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Failed to read the list' });
    expect(fromCalls).toEqual(['users', 'priority_push_attention_v']);
  });

  it('the users table cannot be read → 500, nobody is let in and the view is not read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.users = { message: 'connection reset' };
    const res = await get(`u=${U}&exp=${EXP}&sig=${SIG}`);
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
    expect(fromCalls).toEqual(['users']);
  });
});

describe('POST /api/priority/resend', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    u: U, exp: EXP, sig: SIG, outbox_id: 45, priority_checked: true, make_checked: true, ...over,
  });

  it('calls priority_push_resend as admin:<chat id> with the two checks and no override', async () => {
    rpc.mockResolvedValue({ data: { ok: true, refused: null, outbox_id: 45, attempt: 2 }, error: null });
    const res = await resendPOST(post('/api/priority/resend', body()));
    expect(rpc).toHaveBeenCalledWith('priority_push_resend', {
      p_outbox_id: 45,
      p_by: `admin:${U}`,
      p_priority_checked: true,
      p_make_checked: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, outbox_id: 45, attempt: 2 });
  });

  it('only a literal true counts as ticked', async () => {
    rpc.mockResolvedValue({ data: { ok: false, refused: 'checks_not_confirmed' }, error: null });
    await resendPOST(post('/api/priority/resend', body({ priority_checked: 'true', make_checked: 1 })));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_priority_checked: false, p_make_checked: false });
  });

  it('a refusal → 409 with the code and its plain sentence', async () => {
    rpc.mockResolvedValue({ data: { ok: false, refused: 'sibling_in_flight', outbox_id: 45, attempt: null }, error: null });
    const res = await resendPOST(post('/api/priority/resend', body()));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.refused).toBe('sibling_in_flight');
    expect(json.error).toMatch(/duplicate draft/);
  });

  it('a bad link → 401 and nothing is called', async () => {
    const res = await resendPOST(post('/api/priority/resend', body({ sig: 'f'.repeat(64) })));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a valid link whose chat id is not an active Admin → 403 and nothing is called', async () => {
    tables.users = [{ role: 'Manager', active: true }];
    const res = await resendPOST(post('/api/priority/resend', body()));
    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(eqCalls).toEqual([{ table: 'users', args: ['chat_id', U] }]);
  });

  it('no outbox id → 400 and nothing is called', async () => {
    const res = await resendPOST(post('/api/priority/resend', body({ outbox_id: 'all' })));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a database error → 500, never a success', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await resendPOST(post('/api/priority/resend', body()));
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });
});

describe('POST /api/priority/mark-found', () => {
  const body = (over: Record<string, unknown> = {}) => ({ u: U, exp: EXP, sig: SIG, outbox_id: 53, docno: ' gr26000049 ', ...over });

  it('calls priority_push_mark_found with the cleaned number as admin:<chat id>', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const res = await markFoundPOST(post('/api/priority/mark-found', body()));
    expect(rpc).toHaveBeenCalledWith('priority_push_mark_found', {
      p_outbox_id: 53,
      p_docno: 'GR26000049',
      p_by: `admin:${U}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, outbox_id: 53, docno: 'GR26000049' });
  });

  it('a refusal → 409 with the mark-found sentence, never "not sent"', async () => {
    rpc.mockResolvedValue({ data: { ok: false, refused: 'not_markable_status', outbox_id: 53, docno: 'GR26000049', status: 'delivered' }, error: null });
    const res = await markFoundPOST(post('/api/priority/mark-found', body()));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.refused).toBe('not_markable_status');
    expect(json.error).toMatch(/already delivered/);
  });

  it('a tampered link → 401, no database call of any kind', async () => {
    const res = await markFoundPOST(post('/api/priority/mark-found', body({ sig: SIG.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })));
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(fromCalls).toEqual([]);
  });

  it('a missing or odd document number → 400 and nothing is called', async () => {
    for (const docno of ['', 'GR 1', undefined]) {
      const res = await markFoundPOST(post('/api/priority/mark-found', body({ docno })));
      expect(res.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('not an active Admin → 403 and nothing is called', async () => {
    tables.users = [{ role: 'Admin', active: false }];
    const res = await markFoundPOST(post('/api/priority/mark-found', body()));
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
