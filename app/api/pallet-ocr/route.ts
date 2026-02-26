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
 * POST /api/pallet-ocr
 * Fire box sticker OCR for a previously scanned barcode and update session.
 *
 * Call this non-blocking (fire-and-forget from the frontend) AFTER /api/pallet-scan
 * has already recorded the barcode. This enriches the box record with item name and weight.
 *
 * Body: { token, barcode, image }   ← image is base64 string from SmartScanner
 *
 * Returns: { success, scan_result, unified, mismatches }
 */
export async function POST(request: NextRequest) {
  try {
    const { token, barcode, image } = await request.json();

    if (!token || !barcode || !image) {
      return NextResponse.json(
        { success: false, error: 'Missing token, barcode, or image' },
        { status: 400 }
      );
    }

    // 1. Call bot's box sticker OCR webhook (synchronous — this is the "slow" part,
    //    but the frontend fires this non-blocking so the scanner stays live)
    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (!botUrl) {
      return NextResponse.json({ success: false, error: 'Bot webhook URL not configured' }, { status: 500 });
    }

    const ocrRes = await fetch(`${botUrl}/webhook/process-box-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, barcode }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!ocrRes.ok) {
      const errText = await ocrRes.text();
      console.error('[pallet-ocr] OCR webhook error:', errText);
      return NextResponse.json({ success: false, error: 'OCR failed' }, { status: 502 });
    }

    const ocrJson = await ocrRes.json();
    const ocrData = ocrJson?.ocr_data ?? {};

    const itemName = ocrData.product_name_english || ocrData.product_name || '';
    const itemNameHebrew = ocrData.product_name_hebrew || '';
    // Use the barcode SKU from OCR if available (structured GS1 barcodes only)
    const sku = ocrData.barcode_digits || '';
    const weight = typeof ocrData.weight_kg === 'number' ? ocrData.weight_kg : 0;
    const expiry = ocrData.expiry_date || '';

    // 2. Update the box record in the pallet session (within lock)
    let result: any = null;
    let errorResult: any = null;

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

      // Enrich the box record with OCR data
      session.scanned_boxes[boxIndex] = {
        ...session.scanned_boxes[boxIndex],
        item_name: itemName,
        item_name_hebrew: itemNameHebrew,
        sku,
        weight,
        expiry,
      };

      // Uniformity check across all boxes that have OCR results
      const mismatches: string[] = [];
      const boxesWithData = session.scanned_boxes.filter((b) => b.weight > 0);

      if (boxesWithData.length >= 2) {
        const refBox = boxesWithData[0];
        for (const box of boxesWithData.slice(1)) {
          if (refBox.item_name && box.item_name && refBox.item_name !== box.item_name) {
            if (!mismatches.includes('item')) mismatches.push('item');
          }
          if (refBox.weight > 0 && box.weight > 0 && Math.abs(refBox.weight - box.weight) > 0.5) {
            if (!mismatches.includes('weight')) mismatches.push('weight');
          }
        }
      }

      const unified = mismatches.length === 0;

      await savePalletSession(token, session);

      result = {
        success: true,
        scan_result: session.scanned_boxes[boxIndex],
        unified,
        mismatches,
      };
    });

    if (errorResult) {
      return NextResponse.json(errorResult, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[pallet-ocr] POST error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
