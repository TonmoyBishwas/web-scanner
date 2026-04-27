import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { getRedisClient } from '@/lib/redis';
import type { MultiPalletSession } from '@/types';

const SESSION_TTL = 7200; // 2 hours

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

/**
 * POST /api/multi-pallet-session
 * Create a multi-pallet verification session covering all pallets in one link.
 *
 * Body: { chat_id, pallet_count, document_number, ocr_data, receipt_id? }
 * Returns: { token, url }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { chat_id, pallet_count, document_number, ocr_data, receipt_id } = body;

    if (!chat_id || !pallet_count || pallet_count < 1) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const token = nanoid();

    const session: MultiPalletSession = {
      token,
      chat_id: String(chat_id),
      pallet_count: Number(pallet_count),
      current_pallet: 1,
      document_number: document_number || '',
      ocr_data: ocr_data || [],
      receipt_id: receipt_id || undefined,
      completed_pallets: [],
      status: 'active',
      created_at: new Date().toISOString(),
    };

    const redis = getRedisClient();
    await redis.set(sessionKey(token), JSON.stringify(session), { ex: SESSION_TTL });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;

    return NextResponse.json({
      token,
      url: `${appUrl}/pallet-verify/${token}`,
    });
  } catch (error) {
    console.error('[multi-pallet-session] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/multi-pallet-session?token=xxx
 * Fetch current session state (polled by pallet-verify page).
 */
export async function GET(request: NextRequest) {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const redis = getRedisClient();
    const raw = await redis.get(sessionKey(token));

    if (!raw) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const session: MultiPalletSession =
      typeof raw === 'string' ? JSON.parse(raw) : (raw as MultiPalletSession);
    return NextResponse.json(session);
  } catch (error) {
    console.error('[multi-pallet-session] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
