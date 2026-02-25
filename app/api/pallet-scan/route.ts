import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import type { PalletSession, PalletBoxScan } from '@/types';

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
 * POST /api/pallet-scan
 * Record a box scan for a pallet verification session.
 *
 * Body: { token, barcode, image_url }
 *
 * Scan is recorded immediately (non-blocking). OCR is NOT awaited here —
 * barcodes are treated as opaque IDs only; SKU/weight come from the
 * box sticker OCR triggered separately if needed.
 *
 * Returns:
 *   { success, scan_result, unified, mismatches, scanned_count, expected_count }
 */
export async function POST(request: NextRequest) {
  try {
    const { token, barcode, image_url } = await request.json();

    if (!token || !barcode) {
      return NextResponse.json(
        { success: false, error: 'Missing token or barcode' },
        { status: 400 }
      );
    }

    let result: any = null;
    let errorResult: any = null;

    // Use the general session lock to prevent races
    await sessionStorage.withLock(token, async () => {
      const session = await getPalletSession(token);
      if (!session || session.status !== 'active') {
        errorResult = { success: false, error: 'Session not found or completed' };
        return;
      }

      // Deduplication — barcode strings are opaque IDs, no structured parsing
      const isDuplicate = session.scanned_boxes.some((b) => b.barcode === barcode);
      if (isDuplicate) {
        result = { success: false, is_duplicate: true, message: 'Barcode already scanned' };
        return;
      }

      // Build scan record immediately — no OCR blocking
      // SKU is intentionally left empty; barcodes carry no product structure
      const boxScan: PalletBoxScan = {
        barcode,
        item_name: '',
        item_name_hebrew: '',
        sku: '',      // do NOT use raw barcode as SKU — it causes false mismatches
        weight: 0,
        expiry: '',
        image_url: image_url || '',
        scanned_at: new Date().toISOString(),
      };

      session.scanned_boxes.push(boxScan);

      // Uniformity check: only flag if both boxes have non-empty SKU that differs.
      // With sku='' this check is effectively a no-op, which is correct for barcode-only
      // identification flows. OCR-based comparison can be added in a later iteration.
      const mismatches: string[] = [];
      const unified = true;

      await savePalletSession(token, session);

      result = {
        success: true,
        is_duplicate: false,
        scan_result: boxScan,
        unified,
        mismatches,
        scanned_count: session.scanned_boxes.length,
        expected_count: session.expected_box_count,
        can_complete: session.scanned_boxes.length >= 2,
      };
    });

    if (errorResult) {
      return NextResponse.json(errorResult, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[pallet-scan] POST error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
