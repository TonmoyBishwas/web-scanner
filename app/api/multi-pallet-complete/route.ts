import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redis';
import { t } from '@/lib/i18n/server';
import type { MultiPalletSession, MultiPalletBoxScan, Language } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';
import { matchInvoiceItem } from '@/lib/invoice-match';

const SESSION_TTL = 7200;
// "Same weight" tolerance — kept at 0.5 kg per the user's instruction
// (2026-05-15). Mirrors UNIFORM_WEIGHT_TOLERANCE in pallet-verify/page.tsx.
const UNIFORM_WEIGHT_TOLERANCE_KG = 0.5;

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

async function getSession(token: string): Promise<MultiPalletSession | null> {
  const redis = getRedisClient();
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as MultiPalletSession);
}

function generateLPN(documentNumber: string, palletNumber: number): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const docShort = documentNumber.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'DOC';
  return `LPN-${date}-${docShort}-P${palletNumber}`;
}

/**
 * Classify the pallet into one of the four configurations the warehouse
 * domain recognises:
 *
 *   1. Single   — one item, all weights within 0.5 kg                 →  single
 *   2. Mix (a)  — one item, weights >0.5 kg apart                     →  mix
 *   3. Mix (b)  — 2+ items, varying weights per item                  →  mix
 *   4. Mix (c)  — 2+ items, each item uniform internally              →  mix
 *
 * Pre-2026-05-15 this was keyed on `box.sku` (= barcode digits), so
 * scenario (a) wrongly returned 'single' and scenario (1) sometimes
 * split into multiple SKUs when OCR misread a barcode digit. Now keyed
 * on the OCR'd Hebrew name via groupKeyForBox.
 */
function detectPalletType(
  boxes: MultiPalletBoxScan[],
  mergeMap?: Map<string, string>,
): { pallet_type: 'single' | 'mix'; uniform_weight: boolean } {
  if (boxes.length === 0) return { pallet_type: 'single', uniform_weight: true };

  const groups = groupBoxesByName(boxes, mergeMap);
  if (groups.size > 1) return { pallet_type: 'mix', uniform_weight: false };

  const [onlyGroup] = groups.values();
  const weights = onlyGroup.map((b) => b.weight).filter((w) => w > 0);
  if (weights.length < 2) return { pallet_type: 'single', uniform_weight: true };

  const range = Math.max(...weights) - Math.min(...weights);
  return range < UNIFORM_WEIGHT_TOLERANCE_KG
    ? { pallet_type: 'single', uniform_weight: true }
    : { pallet_type: 'mix', uniform_weight: false };
}

/**
 * Look up the invoice line item that matches a scanned-name group. Returns
 * the OCR'd short item_code from the invoice if found — otherwise empty
 * string. Bot's `_find_stock_batch_for_item` falls back to name-based
 * matching so an empty item_code is still safe for downstream writes.
 */
function findInvoiceItemCode(
  groupKey: string,
  sampleNameHebrew: string,
  sampleNameEnglish: string,
  invoiceItems: MultiPalletSession['ocr_data'] | undefined,
): string {
  void groupKey; // grouping is name-based; kept for call-site stability
  return matchInvoiceItem(sampleNameHebrew, sampleNameEnglish, invoiceItems)?.item_code || '';
}

/**
 * POST /api/multi-pallet-complete
 * Finalise one pallet within a multi-pallet session.
 *
 * Body:
 *   token          - session token
 *   scanned_boxes  - array of MultiPalletBoxScan
 *   box_count      - total box count declared by worker (used for uniform single)
 *   uniform_groups - optional per-NAME-KEY overrides where one or more items
 *                    are uniform-weight. Worker scans 2 sample boxes and
 *                    reports the real total_count; we trust that.
 *   merge_map      - optional Map of {originalKey → canonicalKey} representing
 *                    AI-suggested merges the worker accepted. Server applies
 *                    this when grouping so the webhook payload reflects the
 *                    worker's confirmed item set.
 */
type UniformGroupOverride = {
  // Post-2026-05-15: keyed on the normalized name (`he:...`/`en:...`).
  // Older clients may still send `sku` — accept either for graceful rollout.
  name_key?: string;
  sku?: string;
  total_count: number;
  avg_weight?: number;
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, scanned_boxes, box_count, uniform_groups, merge_map } = body as {
      token: string;
      scanned_boxes: MultiPalletBoxScan[];
      box_count: number;
      uniform_groups?: UniformGroupOverride[];
      merge_map?: Record<string, string>;
    };

    if (!token) {
      return NextResponse.json({ success: false, error: t(undefined, 'errors.missingToken') }, { status: 400 });
    }

    const session = await getSession(token);
    if (!session) {
      return NextResponse.json({ success: false, error: t(undefined, 'errors.sessionNotFound') }, { status: 404 });
    }
    const lang = session.language as Language | undefined;
    if (session.status === 'completed') {
      return NextResponse.json({ success: false, error: t(lang, 'errors.sessionAlreadyCompleted') }, { status: 400 });
    }

    const palletNumber = session.current_pallet;
    const lpn = generateLPN(session.document_number, palletNumber);

    // Worker-accepted AI merges (originalKey → canonicalKey).
    const mergeMap = new Map<string, string>(Object.entries(merge_map ?? {}));

    const { pallet_type, uniform_weight } = detectPalletType(scanned_boxes, mergeMap);

    // Build webhook payload — same contract as existing /webhook/pallet-complete
    let webhookPayload: Record<string, unknown>;

    if (pallet_type === 'mix') {
      // Group boxes by the OCR'd Hebrew name (with the worker's accepted merges
      // applied). The barcode digits play no role in grouping — they only exist
      // to prevent duplicate scans of the same physical box.
      const grouped = groupBoxesByName(scanned_boxes, mergeMap);

      const items = Array.from(grouped.entries()).map(([nameKey, itemBoxes]) => {
        const override =
          uniform_groups?.find((g) => g.name_key === nameKey) ??
          // Backward-compat: older clients sent `sku` (which used to be the
          // grouping key). If the override's sku matches any scanned box's
          // sku in this group, accept it.
          uniform_groups?.find((g) => g.sku && itemBoxes.some((b) => b.sku === g.sku));
        const weights = itemBoxes.map((b) => b.weight).filter((w) => w > 0);
        const weightRange = weights.length > 1 ? Math.max(...weights) - Math.min(...weights) : 0;
        const isUniform = override !== undefined || weightRange < UNIFORM_WEIGHT_TOLERANCE_KG;
        const scannedAvg = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
        const avgWeight = override?.avg_weight ?? scannedAvg;
        // For uniform sub-groups the worker only physically scans 2 sample
        // boxes; total_count is the true count reported via the prompt.
        const totalBoxCount = override?.total_count ?? itemBoxes.length;
        const calcWeight = isUniform
          ? Math.round(avgWeight * totalBoxCount * 1000) / 1000
          : Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000;

        // Sample box → invoice cross-ref. The first box in the group is
        // representative since they all share a normalized name.
        const sample = itemBoxes[0];
        const itemNameEnglish = itemBoxes.find((b) => b.item_name)?.item_name || '';
        const itemNameHebrew = itemBoxes.find((b) => b.item_name_hebrew)?.item_name_hebrew || '';
        const invoiceItemCode = findInvoiceItemCode(
          nameKey,
          itemNameHebrew,
          itemNameEnglish,
          session.ocr_data,
        );

        return {
          // item_code is the OCR'd short product code from the invoice
          // (e.g. "10004"), NOT the barcode digits. Empty when no invoice
          // line matches this name — bot falls back to name-based Stock
          // Batches matching.
          item_code: invoiceItemCode,
          item_name: itemNameEnglish,
          item_name_hebrew: itemNameHebrew,
          name_key: nameKey,
          box_count: totalBoxCount,
          calculated_total_weight: calcWeight,
          uniform_weight: isUniform,
          sample_barcode: sample?.barcode || '',
        };
      });

      webhookPayload = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn,
        pallet_type: 'mix',
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: scanned_boxes.length,
        items,
        // scanned_boxes intentionally drops the `item_code` field — barcode
        // digits aren't a product identifier. The box's Hebrew name carries
        // its identity; bot looks up the parent Pallet Item via name match.
        scanned_boxes: scanned_boxes.map((b) => ({
          barcode: b.barcode,
          sku: b.sku, // legacy field; stored as Box SKU column for dedup queries
          name_key: mergeMap.get(groupKeyForBox(b)) ?? groupKeyForBox(b),
          weight: b.weight,
          expiry: b.expiry,
          item_name: b.item_name,
          item_name_hebrew: b.item_name_hebrew,
        })),
      };
    } else {
      // Single-item pallet — exactly one name-group.
      const grouped = groupBoxesByName(scanned_boxes, mergeMap);
      const [onlyGroupBoxes] = grouped.values() ?? [scanned_boxes];
      const itemBoxes = onlyGroupBoxes ?? scanned_boxes;
      const itemNameEnglish = itemBoxes.find((b) => b.item_name)?.item_name || '';
      const itemNameHebrew = itemBoxes.find((b) => b.item_name_hebrew)?.item_name_hebrew || '';
      const weights = itemBoxes.map((b) => b.weight).filter((w) => w > 0);
      const avgWeight =
        weights.length > 0 ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 1000) / 1000 : 0;
      const totalBoxes = uniform_weight ? (box_count || itemBoxes.length) : itemBoxes.length;
      const calcWeight = uniform_weight
        ? Math.round(avgWeight * totalBoxes * 1000) / 1000
        : Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000;
      const invoiceItemCode = findInvoiceItemCode(
        '',
        itemNameHebrew,
        itemNameEnglish,
        session.ocr_data,
      );

      webhookPayload = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn,
        pallet_type: 'single',
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: itemBoxes.length,
        item_code: invoiceItemCode,
        item_name: itemNameEnglish,
        item_name_hebrew: itemNameHebrew,
        box_count: totalBoxes,
        ocr_box_weight: avgWeight,
        calculated_total_weight: calcWeight,
        scanned_boxes: scanned_boxes.map((b) => ({
          barcode: b.barcode,
          sku: b.sku, // legacy field — Box SKU column for dedup
          name_key: mergeMap.get(groupKeyForBox(b)) ?? groupKeyForBox(b),
          weight: b.weight,
          expiry: b.expiry,
          item_name: b.item_name,
          item_name_hebrew: b.item_name_hebrew,
        })),
      };
    }

    // Fire webhook to bot (fire-and-forget)
    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (botUrl) {
      fetch(`${botUrl}/webhook/pallet-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      }).catch((err) => console.error('[multi-pallet-complete] Bot webhook failed:', err));
    }

    // Advance session
    const newCurrentPallet = palletNumber + 1;
    const allPalletsDone = newCurrentPallet > session.pallet_count;
    const looseBoxesPending = allPalletsDone && (session.loose_box_count || 0) > 0;
    const sessionFullyDone = allPalletsDone && !looseBoxesPending;

    const updatedSession: MultiPalletSession = {
      ...session,
      current_pallet: newCurrentPallet,
      status: sessionFullyDone ? 'completed' : 'active',
      completed_pallets: [
        ...session.completed_pallets,
        { pallet_number: palletNumber, lpn, pallet_type, box_count: scanned_boxes.length },
      ],
    };

    const redis = getRedisClient();
    await redis.set(sessionKey(token), JSON.stringify(updatedSession), { ex: SESSION_TTL });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;

    return NextResponse.json({
      success: true,
      lpn,
      lpn_url: `${appUrl}/pallet/${lpn}`,
      pallet_number: palletNumber,
      next_pallet: allPalletsDone ? null : newCurrentPallet,
      all_done: allPalletsDone,
    });
  } catch (error) {
    console.error('[multi-pallet-complete] POST error:', error);
    return NextResponse.json({ success: false, error: t(undefined, 'errors.serverError') }, { status: 500 });
  }
}
