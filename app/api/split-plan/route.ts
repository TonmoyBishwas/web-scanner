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

    // Coerce ONCE, here, and use the coerced values for every check below.
    // The request body is only TS-cast, never runtime-validated, so a numeric
    // string reaching `+` would concatenate instead of add: quotas "1","2","3"
    // sum to "0123" → 123, and a legitimate plan is rejected as over-allocated.
    const totalPallets = Number(pallet_count);
    if (!token || !Number.isFinite(totalPallets) || totalPallets < 1) {
      return NextResponse.json({ success: false, error: 'invalid_plan' }, { status: 400 });
    }
    if (assignments.length === 0) {
      return NextResponse.json({ success: false, error: 'no_workers' }, { status: 400 });
    }
    // `?? 0` before Number(), not after: a null quota means pool-only and
    // contributes nothing to the reserved total. Number(null) is 0 too, but
    // spelling it this way keeps the null-means-pool intent visible.
    const quotaSum = assignments.reduce((s, a) => s + Number(a.quota ?? 0), 0);
    if (!Number.isFinite(quotaSum)) {
      return NextResponse.json({ success: false, error: 'invalid_plan' }, { status: 400 });
    }
    if (quotaSum > totalPallets) {
      return NextResponse.json({ success: false, error: 'quotas_exceed_total' }, { status: 400 });
    }

    let result: { status: number; body: Record<string, unknown> } | null = null;
    let needsHandoff = false;

    await sessionStorage.withLock(token, async () => {
      const session = await load(token);
      if (!session) { result = { status: 404, body: { success: false, error: 'session_not_found' } }; return; }

      // Re-entry after a failed bot handoff. The session is already committed
      // (commit-before-webhook is the ordering invariant), but no Delivery was
      // created and no worker was told. Re-fire the webhook instead of
      // committing a second time — `handle_split_plan_ready` is idempotent.
      if (session.status === 'active' && session.handoff_ok !== true) {
        result = { status: 200, body: { success: true, session, resent: true } };
        needsHandoff = true;
        return;
      }
      if (session.status !== 'planning') {
        result = { status: 409, body: { success: false, error: 'already_committed' } }; return;
      }

      // Keep only the workers the manager actually ticked, carrying their quota.
      // Quota is coerced explicitly: the body is only TS-cast, so a numeric
      // string from a client would otherwise turn the Σ-quota check into string
      // concatenation. `null` must survive as null — it means pool-only, whereas
      // 0 would be a real zero reservation.
      const roster: RosterEntry[] = (session.roster ?? [])
        .filter((r) => assignments.some((a) => a.chat_id === r.chat_id))
        .map((r) => {
          const q = assignments.find((a) => a.chat_id === r.chat_id)?.quota;
          return { ...r, quota: q === null || q === undefined ? null : Number(q) };
        });

      // Every assignment must name someone actually on this session's roster.
      // Without this, a mismatched payload commits a job with an EMPTY roster:
      // the bot still creates the Delivery and messages nobody, and every
      // worker is then rejected by pallet-claim with not_on_this_job. PATCH
      // can only filter the roster, never re-add — so the job would be
      // permanently unclaimable. Mirrors the membership guard in pallet-claim.
      if (roster.length !== assignments.length) {
        result = { status: 400, body: { success: false, error: 'unknown_workers' } }; return;
      }

      // The loose-box owner, when pinned, must be on the roster for the same
      // reason — a pinned owner who isn't on the job can never claim it.
      if (loose_owner && !roster.some((r) => r.chat_id === loose_owner)) {
        result = { status: 400, body: { success: false, error: 'loose_owner_not_on_this_job' } }; return;
      }

      const looseCount = Number(loose_box_count) || 0;
      const updated: MultiPalletSession = {
        ...applySplitState(session, {
          roster,
          pallets: buildSlots(totalPallets),
          loose: looseCount > 0
            ? { count: looseCount, owner: loose_owner, status: loose_owner ? 'claimed' : 'open' }
            : null,
        }),
        loose_box_count: looseCount,
        status: 'active',
      };

      await getRedisClient().set(sessionKey(token), JSON.stringify(updated), { ex: SESSION_TTL });
      result = { status: 200, body: { success: true, session: updated } };
      needsHandoff = true;
    });

    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return NextResponse.json({ success: false, error: 'lock_failed' }, { status: 500 });
    if (r.status !== 200 || !needsHandoff) {
      return NextResponse.json(r!.body, { status: r!.status });
    }

    // Hand off to the bot: it creates the Delivery + Delivery Items and
    // messages each worker. Fires only AFTER the session is durably saved, so
    // a handoff failure can never leave workers holding links to a job that
    // does not exist.
    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (botUrl) {
      const session = (r.body as { session: MultiPalletSession }).session;
      // A hung bot must degrade to a reported 502, not an uncontrolled
      // platform timeout that tells the manager nothing.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15_000);
      try {
        const res = await fetch(`${botUrl}/webhook/split-plan-ready`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            owner_chat_id: session.owner_chat_id,
            pallet_count: session.pallets?.length ?? 0,
            loose_box_count: session.loose_box_count,
            roster: session.roster,
          }),
          signal: abort.signal,
        });
        // fetch does NOT throw on 4xx/5xx. Without this check a bot-side
        // failure — no Delivery created, no worker messaged — would be
        // reported to the manager as success.
        if (!res.ok) {
          console.error(`[split-plan] bot handoff returned ${res.status}`);
          return NextResponse.json({ success: false, error: 'bot_unreachable' }, { status: 502 });
        }
      } catch (e) {
        console.error('[split-plan] bot handoff failed:', e);
        return NextResponse.json({ success: false, error: 'bot_unreachable' }, { status: 502 });
      } finally {
        clearTimeout(timer);
      }

      // Mark the handoff done so a retry of this endpoint re-commits nothing.
      // Until this flag is set, the session is committed but un-notified, and
      // POSTing again re-fires the webhook instead of returning 409.
      //
      // Failing to record the flag must NOT be reported as a failed handoff:
      // by this point the Delivery exists and the workers have been messaged.
      // Telling the manager it failed would send them round the retry loop for
      // work that already succeeded. Worst case the flag stays unset and a
      // later retry re-sends the notifications, which the bot handler
      // tolerates (it is idempotent on the plan token).
      try {
        await sessionStorage.withLock(token, async () => {
          const fresh = await load(token);
          if (!fresh) return;
          await getRedisClient().set(
            sessionKey(token),
            JSON.stringify({ ...fresh, handoff_ok: true }),
            { ex: SESSION_TTL },
          );
        });
      } catch (e) {
        console.error('[split-plan] handoff succeeded but handoff_ok not persisted:', e);
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
    const { token, worker_chat_id, pallet_count, assignments } = (await request.json()) as {
      token?: string; worker_chat_id?: string; pallet_count?: number;
      assignments?: Array<{ chat_id: string; quota: number | null }>;
    };
    if (!token) return NextResponse.json({ success: false, error: 'missing_token' }, { status: 400 });

    let result: { status: number; body: Record<string, unknown> } | null = null;

    await sessionStorage.withLock(token, async () => {
      const session = await load(token);
      if (!session) { result = { status: 404, body: { success: false, error: 'session_not_found' } }; return; }

      // Same owner-only gate as /api/pallet-claim's reassign. Every worker on
      // the job holds this token in their own `?w=` link, so without this any
      // of them could rewrite the roster, drop a colleague, or change the
      // pallet total — actions the board only ever intends for the manager
      // who planned the job (I7 in the final review).
      if (worker_chat_id !== session.owner_chat_id) {
        result = { status: 403, body: { success: false, error: 'owner_action_only' } };
        return;
      }

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

      // Same coercion and membership rules as POST — a board edit must not be
      // able to empty the roster or corrupt a quota where the initial commit
      // could not.
      let roster = session.roster ?? [];
      if (assignments) {
        const next = roster
          .filter((r) => assignments.some((a) => a.chat_id === r.chat_id))
          .map((r) => {
            const q = assignments.find((a) => a.chat_id === r.chat_id)?.quota;
            return { ...r, quota: q === null || q === undefined ? null : Number(q) };
          });
        if (next.length !== assignments.length) {
          result = { status: 400, body: { success: false, error: 'unknown_workers' } }; return;
        }
        if (next.length === 0) {
          result = { status: 400, body: { success: false, error: 'no_workers' } }; return;
        }
        // Anyone dropped from the roster must not still be holding work.
        const droppedWithWork = pallets.some(
          (p) => p.status === 'claimed' && p.owner && !next.some((r) => r.chat_id === p.owner),
        );
        if (droppedWithWork) {
          result = { status: 409, body: { success: false, error: 'worker_still_holds_a_pallet' } }; return;
        }
        roster = next;
      }

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
