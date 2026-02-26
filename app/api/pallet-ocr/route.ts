import { NextRequest, NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { normalizeString } from '@/lib/string-utils';
import type { PalletSession, PalletBoxScan } from '@/types';

const PALLET_SESSION_TTL = 7200;

// Configure Cloudinary (same pattern as /api/cloudinary/upload)
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

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
 * Upload a pallet box image to Cloudinary.
 * Returns the secure URL, or '' if Cloudinary is not configured or upload fails.
 */
async function uploadBoxImage(
  base64Image: string,
  barcode: string,
  documentNumber: string
): Promise<string> {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return '';

  const imageData = base64Image.startsWith('data:')
    ? base64Image
    : `data:image/jpeg;base64,${base64Image}`;

  const folder = documentNumber ? `Invoice ${documentNumber}` : 'pallet-boxes';
  // Use last 12 chars of barcode to keep public_id short
  const publicId = `pallet-box-${barcode.slice(-12)}-${Date.now()}`;

  try {
    const result = await cloudinary.uploader.upload(imageData, {
      folder,
      public_id: publicId,
      resource_type: 'image',
      overwrite: false,
    });
    console.log('[pallet-ocr] Image uploaded to Cloudinary:', result.secure_url);
    return result.secure_url;
  } catch (err) {
    console.error('[pallet-ocr] Cloudinary upload failed:', err);
    return '';
  }
}

/**
 * POST /api/pallet-ocr
 * Fire box sticker OCR for a previously scanned barcode and update session.
 * Also uploads the box image to Cloudinary and stores the URL in the session.
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

    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (!botUrl) {
      return NextResponse.json({ success: false, error: 'Bot webhook URL not configured' }, { status: 500 });
    }

    // Run OCR and session read (for document number) in parallel.
    const [ocrRes, sessionForUpload] = await Promise.all([
      fetch(`${botUrl}/webhook/process-box-ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, barcode }),
        signal: AbortSignal.timeout(30_000),
      }),
      getPalletSession(token),
    ]);

    if (!ocrRes.ok) {
      const errText = await ocrRes.text();
      console.error('[pallet-ocr] OCR webhook error:', errText);
      return NextResponse.json({ success: false, error: 'OCR failed' }, { status: 502 });
    }

    const ocrJson = await ocrRes.json();
    const ocrData = ocrJson?.ocr_data ?? {};

    const itemName = ocrData.product_name_english || ocrData.product_name || '';
    const itemNameHebrew = ocrData.product_name_hebrew || '';
    const sku = ocrData.barcode_digits || '';
    const weight = typeof ocrData.weight_kg === 'number' ? ocrData.weight_kg : 0;
    const expiry = ocrData.expiry_date || '';

    // Upload image to Cloudinary alongside OCR (non-blocking failure = empty URL).
    const documentNumber = sessionForUpload?.invoice_document_number || '';
    const imageUrl = await uploadBoxImage(image, barcode, documentNumber);

    // Update the box record in the pallet session (within lock).
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

      // Enrich the box record with OCR data + Cloudinary image URL
      session.scanned_boxes[boxIndex] = {
        ...session.scanned_boxes[boxIndex],
        item_name: itemName,
        item_name_hebrew: itemNameHebrew,
        sku,
        weight,
        expiry,
        image_url: imageUrl,
      };

      // Uniformity check: Hebrew-first, normalised English fallback
      const mismatches: string[] = [];
      const boxesWithData = session.scanned_boxes.filter((b) => b.weight > 0);

      if (boxesWithData.length >= 2) {
        const refBox = boxesWithData[0];
        for (const box of boxesWithData.slice(1)) {
          const bothHaveHebrew = refBox.item_name_hebrew && box.item_name_hebrew;
          const hebrewMatch =
            bothHaveHebrew &&
            (normalizeString(refBox.item_name_hebrew) === normalizeString(box.item_name_hebrew) ||
              normalizeString(refBox.item_name_hebrew).includes(normalizeString(box.item_name_hebrew)) ||
              normalizeString(box.item_name_hebrew).includes(normalizeString(refBox.item_name_hebrew)));
          const engMatch =
            refBox.item_name &&
            box.item_name &&
            (normalizeString(refBox.item_name) === normalizeString(box.item_name) ||
              normalizeString(refBox.item_name).includes(normalizeString(box.item_name)) ||
              normalizeString(box.item_name).includes(normalizeString(refBox.item_name)));
          const nameOk = hebrewMatch || (!bothHaveHebrew && engMatch);
          if (refBox.item_name && box.item_name && !nameOk) {
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
