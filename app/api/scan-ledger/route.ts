import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { touchSession } from '@/lib/redis';

/**
 * Server copy of every carton on an in-progress pallet / loose list
 * (lib/scan-ledger.ts; table scan_cartons, docs/migrations/2026-10-18-scan-cartons-ledger.sql).
 *
 *   POST /api/scan-ledger { token, ops: [{pallet, key, row, deleted, ver, tab}] }
 *        → { acks: [{pallet, key, ver}] }   (ver = what the server now holds)
 *   GET  /api/scan-ledger?token=…&pallet=n
 *        → { cartons: [{pallet, key, row, deleted, ver}] }
 *
 * The token is the credential, as on every scanner route. Writes are accepted
 * for any multi-pallet session that exists — also an expired one: a phone
 * that was offline for hours must still be able to hand its scans over.
 * Every call slides a live session's expiry (touchSession), so a receipt is
 * never cut off while its page is open.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** The table / function is not deployed yet (migration not applied): the
 *  page treats this as "server copy off" and keeps working from the phone. */
function isMissingLedger(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(String(err.code ?? ''))
    || /does not exist|could not find the (function|table)/i.test(err.message ?? '');
}

function unavailable() {
  return NextResponse.json({ error: 'ledger_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
const MAX_OPS = 200;
const MAX_ROW_BYTES = 16000;

async function sessionExists(token: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('scan_sessions')
    .select('token')
    .eq('token', token)
    .eq('kind', 'multi_pallet')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

interface CleanOp {
  pallet: number;
  key: string;
  row: Record<string, unknown> | null;
  deleted: boolean;
  ver: number;
  tab: string;
}

function cleanOp(raw: unknown): CleanOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pallet = Number(o.pallet);
  const ver = Number(o.ver);
  const key = typeof o.key === 'string' ? o.key : '';
  if (!Number.isInteger(pallet) || pallet < 0 || pallet > 9999) return null;
  if (!Number.isSafeInteger(ver) || ver <= 0) return null;
  if (!key || key.length > 128) return null;
  const deleted = o.deleted === true;
  let row: Record<string, unknown> | null = null;
  if (!deleted) {
    if (!o.row || typeof o.row !== 'object' || Array.isArray(o.row)) return null;
    const r = { ...(o.row as Record<string, unknown>) };
    delete r.image_data;
    delete r.photo_pending;
    if (r.barcode !== key) return null;
    if (JSON.stringify(r).length > MAX_ROW_BYTES) return null;
    row = r;
  }
  const tab = typeof o.tab === 'string' ? o.tab.slice(0, 64) : '';
  return { pallet, key, row, deleted, ver, tab };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { token?: unknown; ops?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    if (!TOKEN_RE.test(token) || !Array.isArray(body.ops)) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    if (body.ops.length > MAX_OPS) {
      return NextResponse.json({ error: 'too_many_ops' }, { status: 413 });
    }
    if (!(await sessionExists(token))) {
      return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
    }
    const ops: CleanOp[] = [];
    // A change the server cannot take is answered as refused (never silently
    // dropped — the phone would resend it forever).
    const refused: Array<{ pallet: number; key: string; ver: number; rejected: string }> = [];
    for (const raw of body.ops) {
      const op = cleanOp(raw);
      if (op) { ops.push(op); continue; }
      const o = (raw ?? {}) as Record<string, unknown>;
      if (typeof o.key === 'string') {
        refused.push({ pallet: Number(o.pallet), key: o.key, ver: Number(o.ver) || 0, rejected: 'bad_op' });
      }
    }
    touchSession(token).catch((err) => console.warn('[scan-ledger] touch failed:', err));
    if (ops.length === 0) return NextResponse.json({ acks: refused });

    const { data, error } = await supabase.rpc('scan_carton_push', { p_token: token, p_ops: ops });
    if (error) {
      if (isMissingLedger(error)) return unavailable();
      console.error('[scan-ledger] push failed', error.message);
      return NextResponse.json({ error: 'push_failed' }, { status: 500 });
    }
    const rows = (data as Array<{ pallet: number; carton_key: string; ver: number | string; applied: boolean; deleted: boolean }>) ?? [];
    const acks = rows.map((a) => ({
      pallet: Number(a.pallet), key: a.carton_key, ver: Number(a.ver), applied: Boolean(a.applied), deleted: Boolean(a.deleted),
    }));
    if (refused.length) console.warn('[scan-ledger] refused ops', refused.length);
    return NextResponse.json({ acks: [...acks, ...refused] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[scan-ledger] POST failed', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token') ?? '';
    const palletParam = request.nextUrl.searchParams.get('pallet');
    const pallet = palletParam === null || palletParam === '' ? NaN : Number(palletParam);
    if (!TOKEN_RE.test(token) || !Number.isInteger(pallet) || pallet < 0 || pallet > 9999) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const { data, error } = await supabase
      .from('scan_cartons')
      .select('pallet, carton_key, row_data, deleted, ver')
      .eq('token', token)
      .eq('pallet', pallet)
      .limit(5000);
    if (error) {
      if (isMissingLedger(error)) return unavailable();
      console.error('[scan-ledger] pull failed', error.message);
      return NextResponse.json({ error: 'pull_failed' }, { status: 500 });
    }
    touchSession(token).catch((err) => console.warn('[scan-ledger] touch failed:', err));
    const cartons = (data ?? []).map((c) => ({
      pallet: Number(c.pallet),
      key: c.carton_key as string,
      row: (c.row_data as Record<string, unknown> | null) ?? null,
      deleted: Boolean(c.deleted),
      ver: Number(c.ver),
    }));
    return NextResponse.json({ cartons }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[scan-ledger] GET failed', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
