import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import {
  claimNext, releaseSlot, reassignSlot, addSlot, closeShort, claimLoose, isComplete,
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
      // Once the job is fully done, no action may mutate it further — most
      // importantly 'add', which never checked status and would otherwise
      // open a brand-new claimed slot on a session multi-pallet-complete
      // still believes is 'active' (because close_short, below, is the only
      // completing action that used to skip writing status: 'completed'
      // at all). Scanning that slot would then pass multi-pallet-complete's
      // own `status === 'completed'` guard and re-run the bot's finalize —
      // double-booking the delivery's stock. See C2 in the final review.
      if (session.status === 'completed') {
        result = { status: 409, body: { success: false, error: 'session_already_completed' } };
        return;
      }
      // Reject an unknown ?w= — the token is a bearer credential, but the
      // identity must still be one this job recognises.
      //
      // The job OWNER always qualifies, even when they aren't on the roster.
      // A manager who split the work without keeping any pallets for
      // themselves is not a roster member, yet Release and Reassign on their
      // own board are exactly their job. Without this the board has to
      // impersonate the slot's current owner to get past the gate, which
      // misattributes the action in the bot's notification — it would read as
      // the worker releasing their own pallet.
      const isOwner = !!worker_chat_id && worker_chat_id === session.owner_chat_id;
      const known = isOwner || (session.roster ?? []).some((r) => r.chat_id === worker_chat_id);
      if (!known) {
        result = { status: 403, body: { success: false, error: 'not_on_this_job' } };
        return;
      }
      // Owner-only actions. A worker may hand their own pallet back
      // (`release`), but reassigning someone else's is a manager action.
      if (action === 'reassign' && !isOwner) {
        result = { status: 403, body: { success: false, error: 'owner_action_only' } };
        return;
      }

      const state = splitStateOf(session);
      const now = new Date().toISOString();
      let next = state;
      let slot: unknown = undefined;
      let dropped: number[] | undefined;

      // A worker holds at most one pallet at a time. Two claims make "which
      // slot is this worker finishing?" ambiguous, and the completion route
      // would resolve it to the wrong one.
      if (
        (action === 'next' || action === 'add') &&
        state.pallets.some((p) => p.owner === worker_chat_id && p.status === 'claimed')
      ) {
        result = { status: 409, body: { success: false, error: 'already_holding_a_pallet' } };
        return;
      }

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
          const r = claimLoose(state, worker_chat_id!);
          if (!r.ok) { result = { status: 409, body: { success: false, error: r.reason } }; return; }
          next = r.state; break;
        }
        default:
          result = { status: 400, body: { success: false, error: 'unknown_action' } };
          return;
      }

      const updated = applySplitState(session, next);
      // close_short is the only action here that can finish the job (it
      // drops every remaining open slot); mirror the status write
      // multi-pallet-complete already does on its own completing actions,
      // so a stale 'active' status never lets a later action re-open —
      // and re-finalize — a done delivery.
      if (isComplete(next)) {
        updated.status = 'completed';
      }
      await redis.set(sessionKey(token), JSON.stringify(updated), { ex: SESSION_TTL });
      result = { status: 200, body: { success: true, slot, dropped, session: updated } };

      // Notify the bot after the save is durable. Fire-and-forget: a worker
      // who already completed the claim/release must never see it fail
      // because a WhatsApp notification timed out.
      const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
      if (botUrl && ['release', 'reassign', 'add', 'close_short'].includes(action)) {
        const path = action === 'close_short' ? 'split-closed-short' : 'pallet-released';
        const body = action === 'close_short'
          ? {
              owner_chat_id: session.owner_chat_id, actor_chat_id: worker_chat_id,
              document_number: session.document_number,
              done_count: next.pallets.filter((p) => p.status === 'done').length,
              planned_count: state.pallets.length,
              is_final: isComplete(next),
              all_completed_pallets: updated.completed_pallets,
              roster_chat_ids: (next.roster ?? []).map((r) => r.chat_id),
            }
          : {
              owner_chat_id: session.owner_chat_id, actor_chat_id: worker_chat_id,
              pallet_number: pallet_n ?? (slot as { n?: number } | undefined)?.n,
              action,
              former_owner_chat_id: state.pallets.find((p) => p.n === Number(pallet_n))?.owner ?? null,
              to_chat_id: action === 'reassign' ? to_chat_id : undefined,
            };
        fetch(`${botUrl}/webhook/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch((e) => console.error('[pallet-claim] bot notify failed:', e));
      }
    });

    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return NextResponse.json({ success: false, error: 'lock_failed' }, { status: 500 });
    return NextResponse.json(r.body, { status: r.status });
  } catch (error) {
    console.error('[pallet-claim] POST error:', error);
    return NextResponse.json({ success: false, error: 'internal' }, { status: 500 });
  }
}
