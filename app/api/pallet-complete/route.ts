import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
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

async function savePalletToAirtable(
  lpn: string,
  session: PalletSession,
  item: { sku: string; item_name: string; weight: number },
  verifiedScanCount: number
): Promise<void> {
  const PALLETS_TABLE_ID = process.env.AIRTABLE_PALLETS_TABLE_ID;
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!PALLETS_TABLE_ID || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    console.warn('[pallet-complete] Airtable Pallets table not configured — skipping');
    return;
  }

  const calcWeight = Math.round(item.weight * session.expected_box_count * 100) / 100;

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${PALLETS_TABLE_ID}`;
  const body = {
    records: [
      {
        fields: {
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
          'Chat ID': session.chat_id,
        },
      },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[pallet-complete] Airtable error:', text);
    // Non-fatal: log but don't throw
  } else {
    console.log('[pallet-complete] Pallet saved to Airtable:', lpn);
  }
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

      // Get item data from the invoice OCR (stored in session when created by bot).
      // Scanned boxes are opaque barcode IDs only — no SKU/weight extracted from them.
      const firstOcrItem = session.ocr_data?.[0] ?? null;
      const itemName = firstOcrItem?.item_name_english || firstOcrItem?.item_name_hebrew || '';
      const itemCode = firstOcrItem?.item_code || '';

      // Per-box weight: divide scale weight by expected box count.
      // calcWeight will equal scale_weight (no artificial discrepancy).
      const perBoxWeight =
        session.expected_box_count > 0
          ? Math.round((session.scale_weight / session.expected_box_count) * 100) / 100
          : 0;
      const calcWeight = Math.round(perBoxWeight * session.expected_box_count * 100) / 100;

      const mismatches: string[] = [];
      const unified = true; // barcode-only flow — no SKU comparison

      const lpn = generateLPN(session.invoice_document_number, session.pallet_number);

      // Save to Airtable (non-blocking error handling)
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
