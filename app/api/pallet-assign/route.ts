import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import type { PalletSession } from '@/types';

const PALLET_SESSION_TTL = 7200;

function palletKey(token: string) {
  return `pallet:${token}`;
}

/**
 * POST /api/pallet-assign
 * Persist a worker's manual box→item assignment in the pallet session.
 * Body: { token, barcode, mix_item_index }
 */
export async function POST(request: NextRequest) {
  try {
    const { token, barcode, mix_item_index } = await request.json();

    if (!token || !barcode || mix_item_index === undefined || mix_item_index === null) {
      return NextResponse.json({ success: false, error: 'Missing fields' }, { status: 400 });
    }

    const redis = getRedisClient();
    let errorResult: string | null = null;

    await sessionStorage.withLock(token, async () => {
      const raw = await redis.get(palletKey(token));
      if (!raw) {
        errorResult = 'Session not found';
        return;
      }
      const session: PalletSession = typeof raw === 'string' ? JSON.parse(raw) : (raw as PalletSession);
      if (!session.manual_assignments) session.manual_assignments = {};
      session.manual_assignments[barcode] = mix_item_index;
      await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });
    });

    if (errorResult) {
      return NextResponse.json({ success: false, error: errorResult }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[pallet-assign] POST error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
