import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { normalizeString } from '@/lib/string-utils';
import type { PalletSession, PalletVerificationResult } from '@/types';

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

function generateLPN(documentNumber: string, palletNumber: number): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const docShort = documentNumber.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'DOC';
  return `LPN-${date}-${docShort}-P${palletNumber}`;
}

/** Post a single record to Airtable, returning the raw response text on failure. */
async function postToAirtable(
  url: string,
  token: string,
  fields: Record<string, unknown>
): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  const text = await res.text();
  return { ok: res.ok, text };
}

async function savePalletToAirtable(
  lpn: string,
  session: PalletSession,
  item: { sku: string; item_name: string; weight: number },
  verifiedScanCount: number
): Promise<void> {
  const PALLETS_TABLE_ID =
    process.env.AIRTABLE_PALLETS_TABLE_ID || process.env.AIRTABLE_PALLETS_TABLE;
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!PALLETS_TABLE_ID || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    console.warn('[pallet-complete] Airtable Pallets table not configured — skipping');
    return;
  }

  const calcWeight = Math.round(item.weight * session.expected_box_count * 100) / 100;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${PALLETS_TABLE_ID}`;

  // Build field set — we'll strip fields that cause UNKNOWN_FIELD_NAME errors on retry.
  // Collect Cloudinary image URLs from scanned boxes (uploaded by pallet-ocr).
  const boxImageUrls = session.scanned_boxes
    .filter((b) => b.image_url)
    .map((b) => ({ url: b.image_url }));

  type Fields = Record<string, unknown>;
  const fullFields: Fields = {
    LPN: lpn,
    'Item Code': item.sku,
    'Item Name': item.item_name,
    'Document Number': session.invoice_document_number,
    'Box Count': session.expected_box_count,
    'OCR Box Weight (kg)': item.weight,
    'Calculated Total Weight (kg)': calcWeight,
    'Scale Weight (kg)': session.scale_weight,
    'Verified Scan Count': verifiedScanCount,
    Status: 'Verified',
    'Chat ID': String(session.chat_id),
    ...(boxImageUrls.length > 0 && { 'Box Scan Images': boxImageUrls }),
  };

  let { ok, text } = await postToAirtable(url, AIRTABLE_TOKEN, fullFields);

  if (!ok) {
    // Parse error to find and remove unknown fields, then retry (same pattern as Transactions).
    console.error('[pallet-complete] Airtable error (attempt 1):', text.slice(0, 500));
    try {
      const errJson = JSON.parse(text);
      const unknownField: string | undefined =
        errJson?.error?.type === 'UNKNOWN_FIELD_NAME'
          ? errJson?.error?.message?.match(/"([^"]+)"/)?.[1]
          : undefined;
      if (unknownField && fullFields[unknownField] !== undefined) {
        console.warn(`[pallet-complete] Removing unknown field "${unknownField}" and retrying`);
        const retry = { ...fullFields };
        delete retry[unknownField];
        ({ ok, text } = await postToAirtable(url, AIRTABLE_TOKEN, retry));
      }
    } catch {
      // JSON parse failed — fall through
    }
  }

  if (!ok) {
    // Second attempt failed — try minimal set (LPN + core fields only, no optional fields)
    console.error('[pallet-complete] Airtable error (attempt 2):', text.slice(0, 500));
    const minimalFields: Fields = {
      LPN: lpn,
      'Item Name': item.item_name,
      'Document Number': session.invoice_document_number,
      'Box Count': session.expected_box_count,
      'OCR Box Weight (kg)': item.weight,
      'Calculated Total Weight (kg)': calcWeight,
      'Scale Weight (kg)': session.scale_weight,
      'Verified Scan Count': verifiedScanCount,
    };
    ({ ok, text } = await postToAirtable(url, AIRTABLE_TOKEN, minimalFields));
    if (!ok) {
      console.error('[pallet-complete] Airtable error (minimal, attempt 3):', text.slice(0, 500));
    }
  }

  if (ok) {
    console.log('[pallet-complete] Pallet saved to Airtable:', lpn);
  }
}

/**
 * Returns true if the two names (English + Hebrew) are considered the same item.
 * Hebrew is checked first; falls back to normalised English.
 */
function namesMatch(
  nameA: string,
  hebrewA: string,
  nameB: string,
  hebrewB: string
): boolean {
  if (hebrewA && hebrewB) {
    const hA = normalizeString(hebrewA);
    const hB = normalizeString(hebrewB);
    return hA === hB || hA.includes(hB) || hB.includes(hA);
  }
  if (nameA && nameB) {
    const eA = normalizeString(nameA);
    const eB = normalizeString(nameB);
    return eA === eB || eA.includes(eB) || eB.includes(eA);
  }
  return true; // not enough data to decide — don't flag as mismatch
}

/**
 * POST /api/pallet-complete
 * Finalize pallet verification: generate LPN, save to Airtable, webhook to bot.
 *
 * Body: { token }
 */
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json({ success: false, error: 'Missing token' }, { status: 400 });
    }

    let completionResult: PalletVerificationResult | null = null;
    let errorResult: any = null;

    await sessionStorage.withLock(token, async () => {
      const session = await getPalletSession(token);
      if (!session) {
        errorResult = { success: false, error: 'Session not found' };
        return;
      }
      if (session.status !== 'active') {
        errorResult = { success: false, error: 'Session already completed' };
        return;
      }
      if (session.scanned_boxes.length < 2) {
        errorResult = {
          success: false,
          error: 'At least 2 boxes must be scanned to verify',
        };
        return;
      }

      // Require at least one box to have a valid weight from OCR.
      const refBoxWithWeight = session.scanned_boxes.find((b) => b.weight > 0);
      if (!refBoxWithWeight) {
        errorResult = {
          success: false,
          error:
            'Box weight not determined. Please ensure boxes were scanned with camera and OCR completed successfully.',
        };
        return;
      }

      // Use box sticker OCR data enriched by /api/pallet-ocr.
      // Use the first box with a valid weight as the reference for calculations.
      // Fall back to invoice OCR (session.ocr_data) for item name/code if missing.
      const firstBox = refBoxWithWeight;
      const firstOcrItem = session.ocr_data?.[0] ?? null;

      const itemName =
        firstBox?.item_name ||
        firstBox?.item_name_hebrew ||
        firstOcrItem?.item_name_english ||
        firstOcrItem?.item_name_hebrew ||
        '';
      const itemCode = firstBox?.sku || firstOcrItem?.item_code || '';

      // Per-box weight from box sticker OCR (the source of truth for weight calculation).
      const perBoxWeight = firstBox.weight;
      const calcWeight = Math.round(perBoxWeight * session.expected_box_count * 100) / 100;

      // Uniformity: Hebrew-first name comparison + weight check
      const mismatches: string[] = [];
      const boxesWithData = session.scanned_boxes.filter((b) => b.weight > 0);
      let unified = true;

      if (boxesWithData.length >= 2) {
        const refBox = boxesWithData[0];
        for (const box of boxesWithData.slice(1)) {
          if (
            refBox.item_name &&
            box.item_name &&
            !namesMatch(
              refBox.item_name,
              refBox.item_name_hebrew || '',
              box.item_name,
              box.item_name_hebrew || ''
            )
          ) {
            if (!mismatches.includes('item')) mismatches.push('item');
            unified = false;
          }
          if (refBox.weight > 0 && box.weight > 0 && Math.abs(refBox.weight - box.weight) > 0.5) {
            if (!mismatches.includes('weight')) mismatches.push('weight');
            unified = false;
          }
        }
      }

      const lpn = generateLPN(session.invoice_document_number, session.pallet_number);

      // Save to Airtable (non-fatal: errors are logged but don't block LPN generation)
      try {
        await savePalletToAirtable(
          lpn,
          session,
          { sku: itemCode, item_name: itemName, weight: perBoxWeight },
          session.scanned_boxes.length
        );
      } catch (atErr) {
        console.error('[pallet-complete] Airtable save failed (non-fatal):', atErr);
      }

      // Mark session as completed
      session.status = 'completed';
      const redis = getRedisClient();
      await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });

      // Build result
      completionResult = {
        verified: unified,
        lpn,
        item_name: itemName,
        item_code: itemCode,
        ocr_box_weight: perBoxWeight,
        calculated_total_weight: calcWeight,
        scale_weight: session.scale_weight,
        box_count: session.expected_box_count,
        verified_scan_count: session.scanned_boxes.length,
        mismatches,
      };

      // Fire webhook to bot
      const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
      if (botUrl) {
        fetch(`${botUrl}/webhook/pallet-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: session.chat_id,
            pallet_number: session.pallet_number,
            lpn,
            item_code: itemCode,
            item_name: itemName,
            box_count: session.expected_box_count,
            ocr_box_weight: perBoxWeight,
            calculated_total_weight: calcWeight,
            scale_weight: session.scale_weight,
            document_number: session.invoice_document_number,
            verified_scan_count: session.scanned_boxes.length,
            mismatches,
          }),
        }).catch((err) => console.error('[pallet-complete] Bot webhook failed:', err));
      }
    });

    if (errorResult) {
      return NextResponse.json(errorResult, { status: 400 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const result = completionResult as unknown as PalletVerificationResult;

    return NextResponse.json({
      success: true,
      verified: result.verified,
      lpn: result.lpn,
      item_name: result.item_name,
      item_code: result.item_code,
      ocr_box_weight: result.ocr_box_weight,
      calculated_total_weight: result.calculated_total_weight,
      scale_weight: result.scale_weight,
      box_count: result.box_count,
      verified_scan_count: result.verified_scan_count,
      mismatches: result.mismatches,
      lpn_url: `${appUrl}/pallet/${result.lpn}`,
    });
  } catch (error) {
    console.error('[pallet-complete] POST error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
