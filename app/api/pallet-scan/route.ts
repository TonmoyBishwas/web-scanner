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
 * Triggers OCR via bot webhook (async), then compares with existing scanned boxes.
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

      // Deduplication
      const isDuplicate = session.scanned_boxes.some((b) => b.barcode === barcode);
      if (isDuplicate) {
        result = { success: false, is_duplicate: true, message: 'Barcode already scanned' };
        return;
      }

      // Trigger OCR via bot webhook (fire-and-forget)
      const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
      let ocrData: any = null;

      if (botUrl && image_url) {
        try {
          // Fetch image as base64 for OCR
          let imageToSend = image_url;
          try {
            const imgRes = await fetch(image_url);
            const buf = await imgRes.arrayBuffer();
            imageToSend = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
          } catch {
            // If fetch fails, send URL directly
          }

          const ocrRes = await fetch(`${botUrl}/webhook/process-box-ocr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageToSend, barcode }),
            signal: AbortSignal.timeout(30000),
          });

          if (ocrRes.ok) {
            const ocrJson = await ocrRes.json();
            if (ocrJson.status === 'success' && ocrJson.ocr_data) {
              ocrData = ocrJson.ocr_data;
            }
          }
        } catch (ocrErr) {
          console.error('[pallet-scan] OCR failed:', ocrErr);
        }
      }

      // Build box scan record
      const boxScan: PalletBoxScan = {
        barcode,
        item_name: ocrData?.product_name_english || ocrData?.product_name_hebrew || ocrData?.product_name || '',
        item_name_hebrew: ocrData?.product_name_hebrew || '',
        sku: ocrData?.barcode_digits || barcode,
        weight: ocrData?.weight_kg ?? 0,
        expiry: ocrData?.expiry_date || '',
        image_url: image_url || '',
        scanned_at: new Date().toISOString(),
      };

      session.scanned_boxes.push(boxScan);

      // Check uniformity (compare with first box)
      const mismatches: string[] = [];
      let unified = true;
      if (session.scanned_boxes.length >= 2) {
        const firstBox = session.scanned_boxes[0];
        for (const box of session.scanned_boxes.slice(1)) {
          // SKU mismatch
          if (box.sku && firstBox.sku && box.sku !== firstBox.sku) {
            if (!mismatches.includes('sku')) mismatches.push('sku');
            unified = false;
          }
          // Weight mismatch (allow ±0.5 kg tolerance)
          if (box.weight && firstBox.weight && Math.abs(box.weight - firstBox.weight) > 0.5) {
            if (!mismatches.includes('weight')) mismatches.push('weight');
            // Weight difference is a warning, not a hard block
          }
        }
      }

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
