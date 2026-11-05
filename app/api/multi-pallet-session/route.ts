import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { getRedisClient, touchSession } from '@/lib/redis';
import { cameraShortSerialOn, identicalNoSerialOn, manualCaptureReviewOn, manualTargetHintOn, noHandCodesOn, ocrNetworkNoticeOn, typedNearMatchOn, uniformAfterCountOn, unitsModeOn } from '@/lib/scanner-flags';
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
    const { chat_id, pallet_count, loose_box_count = 0, document_number, ocr_data, receipt_id, language, category, nonmeat_meta, meat_discrepancy } = body;

    // 0 pallets is a delivery that came loose (BOT-30): the page opens in the
    // loose-box phase (current_pallet 1 > pallet_count 0) and the loose
    // webhook closes the delivery. Only 0 pallets AND 0 loose boxes is invalid.
    const pallets = Number(pallet_count) || 0;
    const loose = Number(loose_box_count) || 0;
    if (!chat_id || pallets < 0 || (pallets < 1 && loose < 1)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const token = nanoid();

    const session: MultiPalletSession = {
      token,
      chat_id: String(chat_id),
      pallet_count: pallets,
      loose_box_count: loose,
      current_pallet: 1,
      document_number: document_number || '',
      ocr_data: ocr_data || [],
      receipt_id: receipt_id || undefined,
      completed_pallets: [],
      status: 'active',
      created_at: new Date().toISOString(),
      language: language === 'Hebrew' ? 'Hebrew' : 'English',
      category: category === 'non_meat' ? 'non_meat' : 'meat',
      nonmeat_meta: nonmeat_meta || null,
      nonmeat_committed: {},
      meat_discrepancy: Boolean(meat_discrepancy),
      meat_committed: {},
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
 * PATCH /api/multi-pallet-session
 * Persist current_box_count so refresh restores scanning phase.
 * Body: { token, current_box_count }
 */
export async function PATCH(request: NextRequest) {
  try {
    const { token, current_box_count } = await request.json();
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
    session.current_box_count = Number(current_box_count) || 0;
    await redis.set(sessionKey(token), JSON.stringify(session), { ex: SESSION_TTL });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[multi-pallet-session] PATCH error:', error);
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
    // Opening / reloading the page is activity too (SCN-24).
    touchSession(token).catch((err) => console.warn('[multi-pallet-session] touch failed:', err));
    // Runtime feature switches for this session's chat (lib/scanner-flags.ts).
    // Added to the response only, never stored on the session.
    // camera_short_serial (item 1, 04/11) and manual_capture_review (04/11)
    // appear only when on, so with the flags off the response is exactly as before.
    const features = {
      units_mode: await unitsModeOn(session.chat_id),
      ...((await cameraShortSerialOn(session.chat_id, session.receipt_id)) ? { camera_short_serial: true } : {}),
      ...((await manualCaptureReviewOn(session.chat_id)) ? { manual_capture_review: true } : {}),
      // manual_target_hint (04/11, Well Done 48745): present only when on.
      ...((await manualTargetHintOn(session.chat_id)) ? { manual_target_hint: true } : {}),
      // typed_near_match and uniform_after_count (04/11): same, present only when on.
      ...((await typedNearMatchOn(session.chat_id)) ? { typed_near_match: true } : {}),
      ...((await uniformAfterCountOn(session.chat_id)) ? { uniform_after_count: true } : {}),
      // identical_no_serial and ocr_network_notice (04/11): same, present only when on.
      ...((await identicalNoSerialOn(session.chat_id)) ? { identical_no_serial: true } : {}),
      ...((await ocrNetworkNoticeOn(session.chat_id)) ? { ocr_network_notice: true } : {}),
      // no_hand_codes (05/11): same, present only when on.
      ...((await noHandCodesOn(session.chat_id)) ? { no_hand_codes: true } : {}),
    };
    return NextResponse.json({ ...session, features });
  } catch (error) {
    console.error('[multi-pallet-session] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
