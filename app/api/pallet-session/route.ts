import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { getRedisClient } from '@/lib/redis';
import type { PalletSession } from '@/types';

const PALLET_SESSION_TTL = 7200; // 2 hours

function palletKey(token: string) {
  return `pallet:${token}`;
}

/**
 * POST /api/pallet-session
 * Create a pallet verification session.
 *
 * Body:
 *   chat_id, pallet_number, pallet_count,
 *   scale_weight, expected_box_count,
 *   document_number, ocr_data
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      chat_id,
      pallet_number,
      pallet_count,
      scale_weight,
      expected_box_count,
      document_number,
      ocr_data,
      pallet_type,
      mix_items,
      receipt_id,
    } = body;

    if (!chat_id || !pallet_number || !pallet_count || scale_weight == null || !expected_box_count) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const token = nanoid();

    const session: PalletSession = {
      token,
      chat_id: String(chat_id),
      pallet_number: Number(pallet_number),
      pallet_count: Number(pallet_count),
      scale_weight: Number(scale_weight),
      expected_box_count: Number(expected_box_count),
      invoice_document_number: document_number || '',
      ocr_data: ocr_data || [],
      scanned_boxes: [],
      status: 'active',
      created_at: new Date().toISOString(),
      pallet_type: pallet_type || 'single',
      mix_items: mix_items || [],
      receipt_id: receipt_id || undefined,
    };

    const redis = getRedisClient();
    await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;

    return NextResponse.json({
      token,
      url: `${appUrl}/pallet-verify/${token}`,
    });
  } catch (error) {
    console.error('[pallet-session] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/pallet-session?token=xxx
 * Fetch a pallet session.
 */
export async function GET(request: NextRequest) {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const redis = getRedisClient();
    const raw = await redis.get(palletKey(token));

    if (!raw) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const session: PalletSession = typeof raw === 'string' ? JSON.parse(raw) : raw as PalletSession;
    return NextResponse.json(session);
  } catch (error) {
    console.error('[pallet-session] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
