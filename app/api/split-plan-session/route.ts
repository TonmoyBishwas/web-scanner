import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { getRedisClient } from '@/lib/redis';
import type { MultiPalletSession, RosterEntry } from '@/types';

const SESSION_TTL = 7200;

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

/**
 * POST /api/split-plan-session
 * Called by the bot when a manager picks "Split between workers". Creates a
 * session in `planning` status — no slots yet, because the manager has not
 * said how many pallets there are.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { chat_id, document_number, ocr_data, roster, language, category, receipt_id, meat_discrepancy } = body;

    if (!chat_id || !Array.isArray(roster) || roster.length === 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const token = nanoid();
    const session: MultiPalletSession = {
      token,
      chat_id: String(chat_id),
      owner_chat_id: String(chat_id),
      mode: 'split',
      pallet_count: 0,
      loose_box_count: 0,
      current_pallet: 1,
      document_number: document_number || '',
      ocr_data: ocr_data || [],
      receipt_id: receipt_id || undefined,
      completed_pallets: [],
      status: 'planning',
      created_at: new Date().toISOString(),
      language: language === 'Hebrew' ? 'Hebrew' : 'English',
      category: category === 'non_meat' ? 'non_meat' : 'meat',
      roster: roster as RosterEntry[],
      pallets: [],
      loose: null,
      meat_committed: {},
      // Mirrors the same flag on /api/multi-pallet-session. Without it every
      // split worker's scanner renders as if MEAT_DISCREPANCY_ENABLED were
      // off — no declared-count "stickers damaged" mode, no "create LPN
      // anyway" force-confirm — a silent regression vs a single-scanner
      // delivery for the same worker (I2 in the final review).
      meat_discrepancy: Boolean(meat_discrepancy),
    };

    const redis = getRedisClient();
    await redis.set(sessionKey(token), JSON.stringify(session), { ex: SESSION_TTL });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    return NextResponse.json({ token, url: `${appUrl}/assign/${token}` });
  } catch (error) {
    console.error('[split-plan-session] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
