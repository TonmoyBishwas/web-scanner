import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { t } from '@/lib/i18n/server';
import type { MultiPalletSession, MultiPalletBoxScan, Language } from '@/types';
import { isComplete } from '@/lib/pallet-slots';
import { isSplitSession, splitStateOf, applySplitState } from '@/lib/session-mode';

const SESSION_TTL = 7200;

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

/**
 * POST /api/multi-pallet-loose-complete
 * Body: { token, scanned_boxes: MultiPalletBoxScan[] }
 * Fires a webhook to the bot with the loose box data, then marks session completed.
 */
export async function POST(request: NextRequest) {
  try {
    // worker_chat_id: split jobs only — which worker scanned the loose-box
    // task. Ignored on single sessions (owner is always session.chat_id).
    const { token, scanned_boxes, worker_chat_id } = await request.json();

    if (!token) {
      return NextResponse.json({ success: false, error: t(undefined, 'errors.missingToken') }, { status: 400 });
    }

    let errorResult: { status: number; body: Record<string, unknown> } | null = null;
    let okResult: Record<string, unknown> | null = null;

    // Lock so a refresh / double-submit can't fire the bot webhook twice or
    // race the status flip to 'completed'.
    await sessionStorage.withLock(token, async () => {
      const redis = getRedisClient();
      const raw = await redis.get(sessionKey(token));

      if (!raw) {
        errorResult = { status: 404, body: { success: false, error: t(undefined, 'errors.sessionNotFound') } };
        return;
      }

      const session: MultiPalletSession =
        typeof raw === 'string' ? JSON.parse(raw) : (raw as MultiPalletSession);
      const lang = session.language as Language | undefined;

      if (session.status !== 'active') {
        errorResult = { status: 409, body: { success: false, error: t(lang, 'errors.sessionAlreadyCompleted') } };
        return;
      }

      const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
      if (!botUrl) {
        errorResult = { status: 500, body: { success: false, error: t(lang, 'errors.botWebhookNotConfigured') } };
        return;
      }

      // Split jobs: the loose-box task is shared session state, not owned by
      // a cursor — mark it done and let is_final reflect whether the whole
      // delivery (pallets + loose) is finished. Single jobs keep the
      // unconditional completion this route has always had.
      const split = isSplitSession(session);
      const workerChatId = split ? String(worker_chat_id ?? '') : session.chat_id;

      let updatedSession: MultiPalletSession;
      let isFinal: boolean;

      if (split) {
        const state = splitStateOf(session);
        if (!state.loose || state.loose.status !== 'claimed') {
          // Not claimed, or already done — this is a refresh or a double
          // submit. Before this guard, the session correctly stays 'active'
          // while loose finishes ahead of the last pallet, so the top-level
          // `session.status !== 'active'` check no longer catches a resend
          // and it would re-fire the bot webhook with the same boxes.
          // markDone enforces the same rule for pallets; loose needs it too.
          errorResult = { status: 409, body: { success: false, error: 'loose_not_claimed' } };
          return;
        }
        if (!worker_chat_id || state.loose.owner !== worker_chat_id) {
          // Closing the loose task can finalize the whole delivery, so it
          // must be the worker who took it — not merely anyone holding the
          // session token.
          errorResult = { status: 403, body: { success: false, error: 'not_your_loose_task' } };
          return;
        }
        const next = { ...state, loose: { ...state.loose, status: 'done' as const } };
        updatedSession = applySplitState(session, next);
        isFinal = isComplete(next);
        if (isFinal) updatedSession.status = 'completed';
      } else {
        updatedSession = { ...session, status: 'completed' };
        isFinal = true;
      }

      // Fire-and-forget to bot webhook
      const boxes: MultiPalletBoxScan[] = scanned_boxes || [];
      fetch(`${botUrl}/webhook/loose-boxes-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Lets the bot detect a stale plan the same way pallet-complete
          // does. Additive only — the bot already tolerates the field being
          // absent.
          token: session.token,
          chat_id: session.chat_id,
          document_number: session.document_number,
          receipt_id: session.receipt_id,
          scanned_boxes: boxes,
          worker_chat_id: workerChatId,
          owner_chat_id: session.owner_chat_id ?? session.chat_id,
          is_final: isFinal,
          // Loose boxes can be the final piece of a delivery — when they are,
          // this call is the one that triggers finalization, and in split
          // mode the bot has no local copy of the completed pallets/roster to
          // fall back on. Send the same two fields the pallet route sends on
          // its final call, so the manager's summary and each worker's
          // close-out aren't empty just because the last thing scanned was
          // loose boxes instead of a pallet.
          all_completed_pallets: isFinal ? updatedSession.completed_pallets : undefined,
          roster_chat_ids: isFinal ? (session.roster ?? []).map((r) => r.chat_id) : undefined,
        }),
      }).catch((err) => console.error('[multi-pallet-loose-complete] bot webhook error:', err));

      // Persist session (marks completed when this was the final piece)
      await redis.set(sessionKey(token), JSON.stringify(updatedSession), { ex: SESSION_TTL });

      okResult = { success: true };
    });

    if (errorResult) {
      const e = errorResult as { status: number; body: Record<string, unknown> };
      return NextResponse.json(e.body, { status: e.status });
    }
    return NextResponse.json(okResult);
  } catch (error) {
    console.error('[multi-pallet-loose-complete] error:', error);
    return NextResponse.json({ success: false, error: t(undefined, 'errors.serverError') }, { status: 500 });
  }
}
