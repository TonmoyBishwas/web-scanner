import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redis';
import type { MultiPalletSession, MultiPalletBoxScan } from '@/types';

const SESSION_TTL = 7200;

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

function detectPalletType(
  boxes: MultiPalletBoxScan[]
): { pallet_type: 'single' | 'mix'; uniform_weight: boolean } {
  if (boxes.length === 0) return { pallet_type: 'single', uniform_weight: true };

  const skus = new Set(boxes.map((b) => b.sku).filter(Boolean));
  if (skus.size > 1) return { pallet_type: 'mix', uniform_weight: false };

  // Single SKU — check weight variance
  const weights = boxes.map((b) => b.weight).filter((w) => w > 0);
  if (weights.length < 2) return { pallet_type: 'single', uniform_weight: true };

  const weightRange = Math.max(...weights) - Math.min(...weights);
  return { pallet_type: 'single', uniform_weight: weightRange < 0.5 };
}

/**
 * POST /api/multi-pallet-complete
 * Finalise one pallet within a multi-pallet session.
 *
 * Body:
 *   token         - session token
 *   scanned_boxes - array of MultiPalletBoxScan
 *   box_count     - total box count declared by worker (for uniform single)
 *
 * Returns: { success, lpn, lpn_url, next_pallet | null, all_done }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, scanned_boxes, box_count } = body as {
      token: string;
      scanned_boxes: MultiPalletBoxScan[];
      box_count: number;
    };

    if (!token) {
      return NextResponse.json({ success: false, error: 'Missing token' }, { status: 400 });
    }

    const session = await getSession(token);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }
    if (session.status === 'completed') {
      return NextResponse.json({ success: false, error: 'Session already completed' }, { status: 400 });
    }

    const palletNumber = session.current_pallet;
    const lpn = generateLPN(session.document_number, palletNumber);

    const { pallet_type, uniform_weight } = detectPalletType(scanned_boxes);

    // Build webhook payload — same contract as existing /webhook/pallet-complete
    let webhookPayload: Record<string, unknown>;

    if (pallet_type === 'mix') {
      // Group boxes by SKU
      const itemMap = new Map<string, { item_name: string; boxes: MultiPalletBoxScan[] }>();
      for (const box of scanned_boxes) {
        const sku = box.sku || 'unknown';
        if (!itemMap.has(sku)) {
          itemMap.set(sku, { item_name: box.item_name || '', boxes: [] });
        }
        itemMap.get(sku)!.boxes.push(box);
      }

      const items = Array.from(itemMap.entries()).map(([sku, { item_name, boxes: itemBoxes }]) => {
        const weights = itemBoxes.map((b) => b.weight).filter((w) => w > 0);
        const weightRange = weights.length > 1 ? Math.max(...weights) - Math.min(...weights) : 0;
        const isUniform = weightRange < 0.5;
        const avgWeight = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
        const calcWeight = isUniform
          ? Math.round(avgWeight * itemBoxes.length * 1000) / 1000
          : Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000;

        return {
          item_code: sku,
          item_name,
          box_count: itemBoxes.length,
          calculated_total_weight: calcWeight,
          uniform_weight: isUniform,
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
        scanned_boxes: scanned_boxes.map((b) => ({
          sku: b.sku,
          item_code: b.sku,
          weight: b.weight,
          expiry: b.expiry,
        })),
      };
    } else {
      // Single-item pallet
      const firstBox = scanned_boxes[0];
      const weights = scanned_boxes.map((b) => b.weight).filter((w) => w > 0);
      const avgWeight =
        weights.length > 0 ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 1000) / 1000 : 0;
      const totalBoxes = uniform_weight ? (box_count || scanned_boxes.length) : scanned_boxes.length;
      const calcWeight = uniform_weight
        ? Math.round(avgWeight * totalBoxes * 1000) / 1000
        : Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000;

      webhookPayload = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn,
        pallet_type: 'single',
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: scanned_boxes.length,
        item_code: firstBox?.sku || '',
        item_name: firstBox?.item_name || '',
        box_count: totalBoxes,
        ocr_box_weight: avgWeight,
        calculated_total_weight: calcWeight,
        scanned_boxes: scanned_boxes.map((b) => ({
          sku: b.sku,
          item_code: b.sku,
          weight: b.weight,
          expiry: b.expiry,
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
    // Only mark the session 'completed' when there are no loose boxes to scan after.
    // Otherwise a refresh during the loose phase would short-circuit to "all done".
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
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
