import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import {
  claimNext, releaseSlot, reassignSlot, addSlot, closeShort,
} from '@/lib/pallet-slots';
import { isSplitSession, splitStateOf, applySplitState } from '@/lib/session-mode';
import type { MultiPalletSession } from '@/types';

const SESSION_TTL = 7200;

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

type Action = 'next' | 'release' | 'reassign' | 'add' | 'close_short' | 'take_loose';

export async function POST(request: NextRequest) {
  try {
    const { token, worker_chat_id, action, pallet_n, to_chat_id } =
      (await request.json()) as {
        token?: string; worker_chat_id?: string; action?: Action;
        pallet_n?: number; to_chat_id?: string;
      };

    if (!token || !action) {
      return NextResponse.json({ success: false, error: 'missing_fields' }, { status: 400 });
    }

    let result: { status: number; body: Record<string, unknown> } | null = null;

    await sessionStorage.withLock(token, async () => {
      const redis = getRedisClient();
      const raw = await redis.get(sessionKey(token));
      if (!raw) {
        result = { status: 404, body: { success: false, error: 'session_not_found' } };
        return;
      }
      const session: MultiPalletSession =
        typeof raw === 'string' ? JSON.parse(raw) : (raw as MultiPalletSession);

      if (!isSplitSession(session)) {
        result = { status: 400, body: { success: false, error: 'not_a_split_session' } };
        return;
      }
      // Reject an unknown ?w= — the token is a bearer credential, but the
      // worker identity must still be one this job actually invited.
      const known = (session.roster ?? []).some((r) => r.chat_id === worker_chat_id);
      if (!known) {
        result = { status: 403, body: { success: false, error: 'not_on_this_job' } };
        return;
      }

      const state = splitStateOf(session);
      const now = new Date().toISOString();
      let next = state;
      let slot: unknown = undefined;
      let dropped: number[] | undefined;

      switch (action) {
        case 'next': {
          const r = claimNext(state, worker_chat_id!, now);
          if (!r.ok) { result = { status: 409, body: { success: false, error: r.reason } }; return; }
          next = r.state; slot = r.slot; break;
        }
        case 'release': {
          const r = releaseSlot(state, Number(pallet_n), now);
          if (!r.ok) { result = { status: 409, body: { success: false, error: r.reason } }; return; }
          next = r.state; break;
        }
        case 'reassign': {
          if (!to_chat_id) { result = { status: 400, body: { success: false, error: 'missing_to_chat_id' } }; return; }
          // The destination must also be on this job — otherwise a pallet
          // could be handed to someone who was never assigned to the delivery
          // and has no way to see or scan it.
          if (!(session.roster ?? []).some((r) => r.chat_id === to_chat_id)) {
            result = { status: 400, body: { success: false, error: 'target_not_on_this_job' } };
            return;
          }
          const r = reassignSlot(state, Number(pallet_n), to_chat_id, now);
          if (!r.ok) { result = { status: 409, body: { success: false, error: r.reason } }; return; }
          next = r.state; break;
        }
        case 'add': {
          const r = addSlot(state, worker_chat_id!, now);
          if (!r.ok) { result = { status: 409, body: { success: false, error: r.reason } }; return; }
          next = r.state; slot = r.slot; break;
        }
        case 'close_short': {
          const r = closeShort(state);
          if (!r.ok) { result = { status: 409, body: { success: false, error: r.reason } }; return; }
          next = r.state; dropped = r.dropped; break;
        }
        case 'take_loose': {
          if (!state.loose || state.loose.status !== 'open') {
            result = { status: 409, body: { success: false, error: 'loose_unavailable' } }; return;
          }
          next = { ...state, loose: { ...state.loose, owner: worker_chat_id!, status: 'claimed' } };
          break;
        }
        default:
          result = { status: 400, body: { success: false, error: 'unknown_action' } };
          return;
      }

      const updated = applySplitState(session, next);
      await redis.set(sessionKey(token), JSON.stringify(updated), { ex: SESSION_TTL });
      result = { status: 200, body: { success: true, slot, dropped, session: updated } };
    });

    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return NextResponse.json({ success: false, error: 'lock_failed' }, { status: 500 });
    return NextResponse.json(r.body, { status: r.status });
  } catch (error) {
    console.error('[pallet-claim] POST error:', error);
    return NextResponse.json({ success: false, error: 'internal' }, { status: 500 });
  }
}
