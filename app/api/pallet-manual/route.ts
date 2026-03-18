import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import type { PalletSession } from '@/types';

const PALLET_SESSION_TTL = 7200;

function palletKey(token: string) {
  return `pallet:${token}`;
}

async function getPalletSession(token: string): Promise<PalletSession | null> {
  const redis = getRedisClient();
  const raw = await redis.get(palletKey(token));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as PalletSession);
}

async function savePalletSession(token: string, session: PalletSession): Promise<void> {
  const redis = getRedisClient();
  await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });
}

/**
 * POST /api/pallet-manual
 * Manually set weight / item_name / expiry for a scanned box when OCR failed.
 * Body: { token, barcode, item_name, weight, expiry }
 * Returns: { success, scan_result }
 */
export async function POST(request: NextRequest) {
  try {
    const { token, barcode, item_name, weight, expiry } = await request.json();

    if (!token || !barcode) {
      return NextResponse.json({ success: false, error: 'Missing token or barcode' }, { status: 400 });
    }

    const parsedWeight = typeof weight === 'number' ? weight : parseFloat(weight);
    if (isNaN(parsedWeight) || parsedWeight <= 0) {
      return NextResponse.json({ success: false, error: 'Weight must be a positive number' }, { status: 400 });
    }

    let result: { success: boolean; scan_result: unknown } | null = null;
    let errorResult: { success: boolean; error: string } | null = null;

    await sessionStorage.withLock(token, async () => {
      const session = await getPalletSession(token);
      if (!session || session.status !== 'active') {
        errorResult = { success: false, error: 'Session not found or completed' };
        return;
      }

      const boxIndex = session.scanned_boxes.findIndex((b) => b.barcode === barcode);
      if (boxIndex === -1) {
        errorResult = { success: false, error: 'Barcode not found in session' };
        return;
      }

      session.scanned_boxes[boxIndex] = {
        ...session.scanned_boxes[boxIndex],
        item_name: (item_name as string)?.trim() || session.scanned_boxes[boxIndex].item_name || '',
        weight: parsedWeight,
        expiry: (expiry as string)?.trim() || session.scanned_boxes[boxIndex].expiry || '',
      };

      await savePalletSession(token, session);

      result = {
        success: true,
        scan_result: session.scanned_boxes[boxIndex],
      };
    });

    if (errorResult) {
      return NextResponse.json(errorResult, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[pallet-manual] POST error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
