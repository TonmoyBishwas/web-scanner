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

/** Strip Hebrew niqqud (vowel points U+05B0–U+05C7). */
function stripNiqqud(s: string): string {
  return s.replace(/[\u05B0-\u05C7]/g, '');
}

/** Extract significant Hebrew words (≥4 base letters), splitting on any
 *  non-Hebrew character (hyphens, dots, spaces, punctuation, etc.). */
function hebrewWords(s: string): Set<string> {
  return new Set(stripNiqqud(s).split(/[^\u05D0-\u05EA]+/).filter((w) => w.length >= 4));
}

/** True if any significant Hebrew word from a appears in b, or vice versa. */
function hebrewWordsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  const wA = hebrewWords(a);
  const wB = hebrewWords(b);
  return [...wA].some((w) => wB.has(w)) || [...wB].some((w) => wA.has(w));
}

/** Assign a scanned box to a mix item index.
 *  Manual assignments (worker tap) are checked first; name matching is the fallback. */
function assignBoxToMixItem(
  box: PalletBoxScan,
  mixItems: MixItem[],
  manualAssignments?: Record<string, number>,
): number {
  // Pass 0: explicit manual assignment by worker
  if (manualAssignments && box.barcode in manualAssignments) {
    return manualAssignments[box.barcode];
  }

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
 * Finalize pallet verification: generate LPN, webhook to bot.
 * The bot is the sole Airtable writer — no Airtable calls here.
 *
 * Body: { token }
 */
export async function POST(request: NextRequest) {
  try {
    const { token, confirmed_box_counts } = await request.json();
    const confirmedBoxCounts: Record<string, number> = confirmed_box_counts ?? {};

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
        // A group is valid if: weights are uniform (≥2 matching) OR all expected boxes scanned
        const mixItems = session.mix_items!;
        for (let i = 0; i < mixItems.length; i++) {
          const mi = mixItems[i];
          const groupBoxes = session.scanned_boxes.filter(
            (b) => assignBoxToMixItem(b, mixItems, session.manual_assignments) === i && b.weight > 0
          );
          // Check server-side if uniform (same logic as client)
          const isUniform = (() => {
            if (groupBoxes.length < 2) return false;
            const ref = groupBoxes[0].weight;
            return groupBoxes.every((b) => Math.abs(b.weight - ref) <= 0.1);
          })();
          const groupValid = isUniform || groupBoxes.length >= mi.expected_box_count;
          if (!groupValid) {
            const name = mi.item_name_english || mi.item_name_hebrew || 'item';
            errorResult = {
              success: false,
              error: `Not enough boxes scanned for "${name}". Need ${mi.expected_box_count} (or 2 with matching weights), have ${groupBoxes.length}.`,
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
            (b) => assignBoxToMixItem(b, mixItems, session.manual_assignments) === i && b.weight > 0
          );
          const avgWeight =
            groupBoxes.length > 0
              ? groupBoxes.reduce((s, b) => s + b.weight, 0) / groupBoxes.length
              : 0;
          // Use worker-confirmed count if provided (overrides invoice expected count for accuracy)
          const confirmedCount = confirmedBoxCounts[String(i)] ? Number(confirmedBoxCounts[String(i)]) : null;
          const isUniform = (() => {
            if (groupBoxes.length < 2) return false;
            const ref = groupBoxes[0].weight;
            return groupBoxes.every((b) => Math.abs(b.weight - ref) <= 0.1);
          })();
          const effectiveBoxCount = confirmedCount ?? mi.expected_box_count;
          const calcTotal = isUniform
            ? Math.round(avgWeight * effectiveBoxCount * 100) / 100
            : Math.round(groupBoxes.reduce((s, b) => s + b.weight, 0) * 100) / 100;
          return { mi, groupBoxes, avgWeight: Math.round(avgWeight * 100) / 100, calcTotal, effectiveBoxCount };
        });

        // Mark session completed
        session.status = 'completed';
        const redis = getRedisClient();
        await redis.set(palletKey(token), JSON.stringify(session), { ex: PALLET_SESSION_TTL });

        // Use first item as primary for PalletVerificationResult (backward compat)
        const firstStat = itemStats[0];
        const totalCalc = Math.round(itemStats.reduce((s, x) => s + x.calcTotal, 0) * 100) / 100;

        const totalEffectiveBoxCount = itemStats.reduce((s, x) => s + x.effectiveBoxCount, 0);
        completionResult = {
          verified: unified,
          lpn,
          item_name: firstStat.mi.item_name_english,
          item_code: firstStat.mi.item_code,
          ocr_box_weight: firstStat.avgWeight,
          calculated_total_weight: totalCalc,
          scale_weight: session.scale_weight,
          box_count: totalEffectiveBoxCount,
          verified_scan_count: session.scanned_boxes.length,
          mismatches,
        };

        // Fire webhook — bot writes all Airtable data
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
              items: itemStats.map(({ mi, groupBoxes, avgWeight, calcTotal, effectiveBoxCount }) => ({
                item_code: mi.item_code,
                item_name: mi.item_name_english,
                item_name_hebrew: mi.item_name_hebrew,
                box_count: effectiveBoxCount,
                ocr_box_weight: avgWeight,
                calculated_total_weight: calcTotal,
                scanned_count: groupBoxes.length,
                uniform_weight: mi.uniform_weight,
              })),
              scanned_boxes: session.scanned_boxes.map((box) => {
                const idx = assignBoxToMixItem(box, session.mix_items!, session.manual_assignments);
                return { ...box, item_code: idx >= 0 ? session.mix_items![idx].item_code : '' };
              }),
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
        // Find the OCR item that matches this box by name (not sku which is a raw barcode)
        const matchingOcrItem = session.ocr_data?.find((oi) =>
          namesMatch(
            firstBox?.item_name || '',
            firstBox?.item_name_hebrew || '',
            oi.item_name_english,
            oi.item_name_hebrew,
          )
        ) ?? firstOcrItem;
        const itemCode = matchingOcrItem?.item_code || firstOcrItem?.item_code || firstBox?.sku || '';

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

        // Mark session completed
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

        // Fire webhook — bot writes all Airtable data
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
              scanned_boxes: session.scanned_boxes.map((box) => ({ ...box, item_code: itemCode })),
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
