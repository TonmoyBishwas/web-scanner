import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { normalizeString } from '@/lib/string-utils';
import type { PalletSession, PalletVerificationResult, PalletBoxScan, MixItem } from '@/types';

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

  // Collect Cloudinary image URLs from scanned boxes (uploaded by pallet-ocr).
  const boxImageUrls = session.scanned_boxes
    .filter((b) => b.image_url)
    .map((b) => ({ url: b.image_url }));

  type Fields = Record<string, unknown>;

  // Start with all fields. On each UNKNOWN_FIELD_NAME error we strip the offending
  // field and retry (up to 8 times). Core fields (LPN, weights, Chat ID) are never
  // removed by this loop — they are only absent if Airtable itself rejects them.
  let fields: Fields = {
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

  for (let attempt = 1; attempt <= 8; attempt++) {
    const { ok, text } = await postToAirtable(url, AIRTABLE_TOKEN, fields);

    if (ok) {
      console.log(`[pallet-complete] Pallet saved to Airtable: ${lpn} (attempt ${attempt})`);
      return;
    }

    console.error(`[pallet-complete] Airtable error (attempt ${attempt}):`, text.slice(0, 600));

    // Try to extract and strip the UNKNOWN_FIELD_NAME field, then retry.
    try {
      const errJson = JSON.parse(text);
      if (errJson?.error?.type === 'UNKNOWN_FIELD_NAME') {
        const unknownField: string | undefined =
          errJson?.error?.message?.match(/"([^"]+)"/)?.[1];
        if (unknownField && fields[unknownField] !== undefined) {
          console.warn(`[pallet-complete] Removing unknown field "${unknownField}" and retrying`);
          const next = { ...fields };
          delete next[unknownField];
          fields = next;
          continue; // retry with field removed
        }
      }
    } catch {
      // JSON parse failed — stop retrying
    }

    // Non-UNKNOWN_FIELD_NAME error, or couldn't identify the bad field — stop.
    break;
  }

  console.error('[pallet-complete] Airtable save failed after retries for LPN:', lpn);
}

/** Strip Hebrew niqqud (vowel points U+05B0–U+05C7). */
function stripNiqqud(s: string): string {
  return s.replace(/[\u05B0-\u05C7]/g, '');
}

/** True if any significant word (≥4 Hebrew chars) from a appears in b's word set. */
function hebrewWordsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => normalizeString(stripNiqqud(s));
  const wordsA = a.split(/\s+/).map(norm).filter((w) => w.length >= 4);
  const wordsB = new Set(b.split(/\s+/).map(norm).filter((w) => w.length >= 4));
  return wordsA.some((wA) => wordsB.has(wA));
}

/** Assign a scanned box to a mix item index.
 *  Hebrew names checked across all items first, English as fallback. */
function assignBoxToMixItem(box: PalletBoxScan, mixItems: MixItem[]): number {
  const normHeb = (s: string) => normalizeString(stripNiqqud(s));

  // Pass 1: Hebrew full-string match (niqqud-stripped)
  if (box.item_name_hebrew) {
    const hA = normHeb(box.item_name_hebrew);
    for (let i = 0; i < mixItems.length; i++) {
      if (mixItems[i].item_name_hebrew) {
        const hB = normHeb(mixItems[i].item_name_hebrew);
        if (hA && hB && (hA === hB || hA.includes(hB) || hB.includes(hA))) return i;
      }
    }
  }
  // Pass 2: Hebrew word-level match
  if (box.item_name_hebrew) {
    for (let i = 0; i < mixItems.length; i++) {
      if (mixItems[i].item_name_hebrew &&
          hebrewWordsOverlap(box.item_name_hebrew, mixItems[i].item_name_hebrew)) return i;
    }
  }
  // Pass 3: English name fallback
  if (box.item_name) {
    const eA = normalizeString(box.item_name);
    for (let i = 0; i < mixItems.length; i++) {
      if (mixItems[i].item_name_english) {
        const eB = normalizeString(mixItems[i].item_name_english);
        if (eA && eB && (eA === eB || eA.includes(eB) || eB.includes(eA))) return i;
      }
    }
  }
  return -1;
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
      const isMix = session.pallet_type === 'mix' && (session.mix_items?.length ?? 0) > 0;

      if (isMix) {
        // Mix pallet: validate that each item group has enough scans
        const mixItems = session.mix_items!;
        for (const mi of mixItems) {
          const groupBoxes = session.scanned_boxes.filter(
            (b) => assignBoxToMixItem(b, mixItems) === mixItems.indexOf(mi) && b.weight > 0
          );
          const required = mi.uniform_weight ? 2 : mi.expected_box_count;
          if (groupBoxes.length < required) {
            const name = mi.item_name_english || mi.item_name_hebrew || 'item';
            errorResult = {
              success: false,
              error: `Not enough boxes scanned for "${name}". Need ${required}, have ${groupBoxes.length}.`,
            };
            return;
          }
        }
      } else {
        if (session.scanned_boxes.length < 2) {
          errorResult = {
            success: false,
            error: 'At least 2 boxes must be scanned to verify',
          };
          return;
        }
        const refBoxWithWeight = session.scanned_boxes.find((b) => b.weight > 0);
        if (!refBoxWithWeight) {
          errorResult = {
            success: false,
            error:
              'Box weight not determined. Please ensure boxes were scanned with camera and OCR completed successfully.',
          };
          return;
        }
      }

      const lpn = generateLPN(session.invoice_document_number, session.pallet_number);
      const mismatches: string[] = [];
      let unified = true;

      if (isMix) {
        const mixItems = session.mix_items!;

        // Per-item: compute avg weight and calculated total
        const itemStats = mixItems.map((mi, i) => {
          const groupBoxes = session.scanned_boxes.filter(
            (b) => assignBoxToMixItem(b, mixItems) === i && b.weight > 0
          );
          const avgWeight =
            groupBoxes.length > 0
              ? groupBoxes.reduce((s, b) => s + b.weight, 0) / groupBoxes.length
              : 0;
          const calcTotal = mi.uniform_weight
            ? Math.round(avgWeight * mi.expected_box_count * 100) / 100
            : Math.round(groupBoxes.reduce((s, b) => s + b.weight, 0) * 100) / 100;
          return { mi, groupBoxes, avgWeight: Math.round(avgWeight * 100) / 100, calcTotal };
        });

        // Save one Airtable row per item
        for (const { mi, groupBoxes, avgWeight } of itemStats) {
          try {
            await savePalletToAirtable(
              lpn,
              session,
              { sku: mi.item_code, item_name: mi.item_name_english, weight: avgWeight },
              groupBoxes.length
            );
          } catch (atErr) {
            console.error('[pallet-complete] Airtable save failed for mix item (non-fatal):', atErr);
          }
        }

        session.status = 'completed';
        const redis = getRedisClient();
        await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });

        // Use first item as primary for PalletVerificationResult (backward compat)
        const firstStat = itemStats[0];
        const totalCalc = Math.round(itemStats.reduce((s, x) => s + x.calcTotal, 0) * 100) / 100;

        completionResult = {
          verified: unified,
          lpn,
          item_name: firstStat.mi.item_name_english,
          item_code: firstStat.mi.item_code,
          ocr_box_weight: firstStat.avgWeight,
          calculated_total_weight: totalCalc,
          scale_weight: session.scale_weight,
          box_count: session.expected_box_count,
          verified_scan_count: session.scanned_boxes.length,
          mismatches,
        };

        // Fire webhook with mix payload
        const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
        if (botUrl) {
          fetch(`${botUrl}/webhook/pallet-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: session.chat_id,
              pallet_number: session.pallet_number,
              lpn,
              pallet_type: 'mix',
              items: itemStats.map(({ mi, groupBoxes, avgWeight, calcTotal }) => ({
                item_code: mi.item_code,
                item_name: mi.item_name_english,
                box_count: mi.expected_box_count,
                ocr_box_weight: avgWeight,
                calculated_total_weight: calcTotal,
                scanned_count: groupBoxes.length,
                uniform_weight: mi.uniform_weight,
              })),
              scale_weight: session.scale_weight,
              document_number: session.invoice_document_number,
              verified_scan_count: session.scanned_boxes.length,
              mismatches,
            }),
          }).catch((err) => console.error('[pallet-complete] Bot webhook failed:', err));
        }
      } else {
        // Single-item pallet
        const refBoxWithWeight = session.scanned_boxes.find((b) => b.weight > 0)!;
        const firstBox = refBoxWithWeight;
        const firstOcrItem = session.ocr_data?.[0] ?? null;

        const itemName =
          firstBox?.item_name ||
          firstBox?.item_name_hebrew ||
          firstOcrItem?.item_name_english ||
          firstOcrItem?.item_name_hebrew ||
          '';
        const itemCode = firstBox?.sku || firstOcrItem?.item_code || '';

        const perBoxWeight = firstBox.weight;
        const calcWeight = Math.round(perBoxWeight * session.expected_box_count * 100) / 100;

        const boxesWithData = session.scanned_boxes.filter((b) => b.weight > 0);
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

        session.status = 'completed';
        const redis = getRedisClient();
        await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });

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

        const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
        if (botUrl) {
          fetch(`${botUrl}/webhook/pallet-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: session.chat_id,
              pallet_number: session.pallet_number,
              lpn,
              pallet_type: 'single',
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
