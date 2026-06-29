import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { supabase } from '@/lib/supabase';
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

function toChatIdBigint(chatId: unknown): number | null {
  if (chatId === null || chatId === undefined || chatId === '') return null;
  const s = String(chatId).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function savePalletToSupabase(
  lpn: string,
  session: PalletSession,
  firstBox: { sku: string; item_name: string; item_name_hebrew?: string; weight: number },
  verifiedScanCount: number
): Promise<void> {
  const calcWeight = firstBox.weight * session.expected_box_count;

  const { error } = await supabase.from('pallets').insert({
    lpn,
    item_code: firstBox.sku,
    item_name: firstBox.item_name || firstBox.item_name_hebrew || '',
    document_number: session.invoice_document_number,
    box_count: session.expected_box_count,
    ocr_box_weight_kg: firstBox.weight,
    calculated_total_weight_kg: calcWeight,
    scale_weight_kg: session.scale_weight,
    verified_scan_count: verifiedScanCount,
    status: 'Verified',
    chat_id: toChatIdBigint(session.chat_id),
  });

  if (error) {
    // Non-fatal: log but don't throw
    console.error('[pallet-complete] Supabase pallet insert error:', error.message);
  } else {
    console.log('[pallet-complete] Pallet saved to Supabase:', lpn);
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

      const firstBox = session.scanned_boxes[0];
      const mismatches: string[] = [];
      let unified = true;

      for (const box of session.scanned_boxes.slice(1)) {
        if (box.sku && firstBox.sku && box.sku !== firstBox.sku) {
          if (!mismatches.includes('sku')) mismatches.push('sku');
          unified = false;
        }
      }

      const lpn = generateLPN(session.invoice_document_number, session.pallet_number);
      const calcWeight = firstBox.weight * session.expected_box_count;

      // Save to Supabase (non-blocking error handling)
      try {
        await savePalletToSupabase(lpn, session, firstBox, session.scanned_boxes.length);
      } catch (atErr) {
        console.error('[pallet-complete] Supabase save failed (non-fatal):', atErr);
      }

      // Mark session as completed
      session.status = 'completed';
      const redis = getRedisClient();
      await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });

      // Build result
      completionResult = {
        verified: unified,
        lpn,
        item_name: firstBox.item_name || firstBox.item_name_hebrew || '',
        item_code: firstBox.sku,
        ocr_box_weight: firstBox.weight,
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
            item_code: firstBox.sku,
            item_name: firstBox.item_name || firstBox.item_name_hebrew || '',
            box_count: session.expected_box_count,
            ocr_box_weight: firstBox.weight,
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
