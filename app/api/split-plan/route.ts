import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { buildSlots } from '@/lib/pallet-slots';
import { applySplitState } from '@/lib/session-mode';
import type { MultiPalletSession, RosterEntry } from '@/types';

const SESSION_TTL = 7200;

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

async function load(token: string): Promise<MultiPalletSession | null> {
  const raw = await getRedisClient().get(sessionKey(token));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as MultiPalletSession);
}

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  const session = await load(token);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json(session);
}

/** Commit the manager's plan: create slots, activate, hand off to the bot. */
export async function POST(request: NextRequest) {
  try {
    const { token, pallet_count, loose_box_count = 0, assignments = [], loose_owner = null } =
      (await request.json()) as {
        token?: string; pallet_count?: number; loose_box_count?: number;
        assignments?: Array<{ chat_id: string; quota: number | null }>;
        loose_owner?: string | null;
      };

    if (!token || !pallet_count || pallet_count < 1) {
      return NextResponse.json({ success: false, error: 'invalid_plan' }, { status: 400 });
    }
    if (assignments.length === 0) {
      return NextResponse.json({ success: false, error: 'no_workers' }, { status: 400 });
    }
    const quotaSum = assignments.reduce((s, a) => s + (a.quota ?? 0), 0);
    if (quotaSum > pallet_count) {
      return NextResponse.json({ success: false, error: 'quotas_exceed_total' }, { status: 400 });
    }

    let result: { status: number; body: Record<string, unknown> } | null = null;

    await sessionStorage.withLock(token, async () => {
      const session = await load(token);
      if (!session) { result = { status: 404, body: { success: false, error: 'session_not_found' } }; return; }
      if (session.status !== 'planning') {
        result = { status: 409, body: { success: false, error: 'already_committed' } }; return;
      }

      // Keep only the workers the manager actually ticked, carrying their quota.
      const roster: RosterEntry[] = (session.roster ?? [])
        .filter((r) => assignments.some((a) => a.chat_id === r.chat_id))
        .map((r) => ({ ...r, quota: assignments.find((a) => a.chat_id === r.chat_id)?.quota ?? null }));

      const looseCount = Number(loose_box_count) || 0;
      const updated: MultiPalletSession = {
        ...applySplitState(session, {
          roster,
          pallets: buildSlots(Number(pallet_count)),
          loose: looseCount > 0
            ? { count: looseCount, owner: loose_owner, status: loose_owner ? 'claimed' : 'open' }
            : null,
        }),
        loose_box_count: looseCount,
        status: 'active',
      };

      await getRedisClient().set(sessionKey(token), JSON.stringify(updated), { ex: SESSION_TTL });
      result = { status: 200, body: { success: true, session: updated } };
    });

    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return NextResponse.json({ success: false, error: 'lock_failed' }, { status: 500 });
    if (r.status !== 200) return NextResponse.json(r.body, { status: r.status });

    // Hand off to the bot: it creates the Delivery + Delivery Items and
    // messages each worker. Same direction as every other scanner→bot call.
    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (botUrl) {
      const session = (r.body as { session: MultiPalletSession }).session;
      try {
        await fetch(`${botUrl}/webhook/split-plan-ready`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            owner_chat_id: session.owner_chat_id,
            pallet_count: session.pallets?.length ?? 0,
            loose_box_count: session.loose_box_count,
            roster: session.roster,
          }),
        });
      } catch (e) {
        console.error('[split-plan] bot handoff failed:', e);
        return NextResponse.json({ success: false, error: 'bot_unreachable' }, { status: 502 });
      }
    }

    return NextResponse.json(r.body, { status: 200 });
  } catch (error) {
    console.error('[split-plan] POST error:', error);
    return NextResponse.json({ success: false, error: 'internal' }, { status: 500 });
  }
}

/** Board edits after the job is live: change the total, or edit the roster. */
export async function PATCH(request: NextRequest) {
  try {
    const { token, pallet_count, assignments } = (await request.json()) as {
      token?: string; pallet_count?: number;
      assignments?: Array<{ chat_id: string; quota: number | null }>;
    };
    if (!token) return NextResponse.json({ success: false, error: 'missing_token' }, { status: 400 });

    let result: { status: number; body: Record<string, unknown> } | null = null;

    await sessionStorage.withLock(token, async () => {
      const session = await load(token);
      if (!session) { result = { status: 404, body: { success: false, error: 'session_not_found' } }; return; }

      let pallets = session.pallets ?? [];
      if (typeof pallet_count === 'number' && pallet_count > 0) {
        const highest = pallets.reduce((m, p) => Math.max(m, p.n), 0);
        if (pallet_count > highest) {
          // Grow: append open slots.
          for (let n = highest + 1; n <= pallet_count; n++) {
            pallets = [...pallets, { n, owner: null, status: 'open' }];
          }
        } else {
          // Shrink: drop the highest OPEN slots only. Claimed or done slots
          // represent real work and are never removed by a total change.
          const removable = pallets
            .filter((p) => p.status === 'open')
            .sort((a, b) => b.n - a.n)
            .slice(0, highest - pallet_count)
            .map((p) => p.n);
          pallets = pallets.filter((p) => !removable.includes(p.n));
        }
      }

      const roster = assignments
        ? (session.roster ?? [])
            .filter((r) => assignments.some((a) => a.chat_id === r.chat_id))
            .map((r) => ({ ...r, quota: assignments.find((a) => a.chat_id === r.chat_id)?.quota ?? null }))
        : (session.roster ?? []);

      const updated = applySplitState(session, { roster, pallets, loose: session.loose ?? null });
      await getRedisClient().set(sessionKey(token), JSON.stringify(updated), { ex: SESSION_TTL });
      result = { status: 200, body: { success: true, session: updated } };
    });

    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return NextResponse.json({ success: false, error: 'lock_failed' }, { status: 500 });
    return NextResponse.json(r.body, { status: r.status });
  } catch (error) {
    console.error('[split-plan] PATCH error:', error);
    return NextResponse.json({ success: false, error: 'internal' }, { status: 500 });
  }
}
