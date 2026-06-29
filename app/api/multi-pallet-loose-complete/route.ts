import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { t } from '@/lib/i18n/server';
import type { MultiPalletSession, MultiPalletBoxScan, Language } from '@/types';

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
    const { token, scanned_boxes } = await request.json();

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

      // Fire-and-forget to bot webhook
      const boxes: MultiPalletBoxScan[] = scanned_boxes || [];
      fetch(`${botUrl}/webhook/loose-boxes-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: session.chat_id,
          document_number: session.document_number,
          receipt_id: session.receipt_id,
          scanned_boxes: boxes,
        }),
      }).catch((err) => console.error('[multi-pallet-loose-complete] bot webhook error:', err));

      // Mark session completed
      session.status = 'completed';
      await redis.set(sessionKey(token), JSON.stringify(session), { ex: SESSION_TTL });

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
