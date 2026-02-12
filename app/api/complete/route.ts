import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { CompleteRequest, CompleteResponse, ScannedItem, ScanEntry } from '@/types';

/**
 * POST /api/complete
 * Mark session as complete and send webhook to bot
 */
export async function POST(request: NextRequest) {
  try {
    const body: CompleteRequest = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Missing token' },
        { status: 400 }
      );
    }

    let response: CompleteResponse | null = null;
    let errorResponse: NextResponse | null = null;

    try {
      await sessionStorage.withLock(token, async () => {
        // Get session inside lock
        const session = await sessionStorage.get(token);
        console.log(`[API/complete] Completing session ${token}. Scanned barcodes: ${session?.scanned_barcodes?.length}, Scanned items keys: ${Object.keys(session?.scanned_items || {}).join(',')}`);

        if (!session) {
          errorResponse = NextResponse.json(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
          return;
        }

        // Check if already completed AND webhook sent
        if (session.status === 'COMPLETED' && session.webhook_sent) {
          console.log(`[API/complete] Session ${token} already completed and webhook sent.`);
          response = {
            success: true,
            summary: session.scanned_items,
            scanned_barcodes: session.scanned_barcodes
          };
          return;
        }

        // Re-calculate summary from scratch to ensure accuracy (fix for missing items)
        // We do not trust session.scanned_items as it might have missed unmatched items during incremental updates
        interface AggregatedItem {
          item_index: number;
          item_name: string;
          scanned_count: number;
          scanned_weight: number;
          expected_weight: number;
          expected_boxes: number;
        }

        const freshSummary: Record<string, AggregatedItem> = {};

        // 1. Initialize with invoice items (optional, but good for completeness if we want to show 0/X)
        // We will just add them as we find them in scans to match current behavior

        // 2. Iterate through all scanned barcodes
        const validScans = session.scanned_barcodes.filter((b: ScanEntry) =>
          b.ocr_status === 'complete' || b.ocr_status === 'manual'
        );

        let totalWeightScanned = 0;

        for (const scan of validScans) {
          // Determine the product name and weight for this scan
          let productName = null;
          let weight = 0;

          if (scan.ocr_status === 'manual' && scan.manual_entry) {
            productName = scan.manual_entry.item_name;
            weight = scan.manual_entry.weight || 0;
          } else if (scan.resolved_item_name) {
            productName = scan.resolved_item_name;
            weight = scan.resolved_weight || (scan.ocr_data?.weight_kg || 0);
          } else if (scan.ocr_data) {
            productName = scan.ocr_data.product_name;
            weight = scan.ocr_data.weight_kg || 0;
          }

          if (!productName) {
            // Should not happen for completed/manual scans, but safe fallback
            productName = "Unknown Item";
          }

          totalWeightScanned += weight;

          // 3. Try to match to an invoice item
          const matchedItem = session.invoice_items.find((item: any) => {
            const pName = productName!.toLowerCase().trim(); // Non-null assertion safe due to check above
            const iNameHeb = item.item_name_hebrew?.toLowerCase().trim() || "";
            const iNameEng = item.item_name_english?.toLowerCase().trim() || "";

            return pName === iNameHeb || pName === iNameEng ||
              (iNameHeb && pName.includes(iNameHeb)) ||
              (iNameHeb && iNameHeb.includes(pName));
          });

          // 4. Update the fresh summary
          if (matchedItem) {
            const index = matchedItem.item_index;
            if (!freshSummary[index]) {
              freshSummary[index] = {
                item_index: index,
                item_name: matchedItem.item_name_english || matchedItem.item_name_hebrew,
                scanned_count: 0,
                scanned_weight: 0,
                expected_weight: matchedItem.quantity_kg,
                expected_boxes: matchedItem.expected_boxes
              };
            }
            freshSummary[index].scanned_count += 1;
            freshSummary[index].scanned_weight += weight;
          } else {
            // UNMATCHED ITEM - Create a special entry
            // Use a key that won't collide with numeric item_index
            const unmatchedKey = `unmatched_${productName.replace(/\s+/g, '_')}`;
            if (!freshSummary[unmatchedKey]) {
              freshSummary[unmatchedKey] = {
                item_index: -1, // -1 indicates unmatched
                item_name: `[Unmatched] ${productName}`,
                scanned_count: 0,
                scanned_weight: 0,
                expected_weight: 0,
                expected_boxes: 0
              };
            }
            freshSummary[unmatchedKey].scanned_count += 1;
            freshSummary[unmatchedKey].scanned_weight += weight;
          }
        }

        console.log(`[API/complete] Re-aggregated summary. Total weight: ${totalWeightScanned}`);

        const webhookPayload = {
          chat_id: session.chat_id,
          token: token,
          document_number: session.document_number,
          operation_type: session.operation_type,
          summary: {
            total_items: Object.keys(freshSummary).length,
            total_scans: validScans.length,
            total_weight_scanned: totalWeightScanned,
            scanned_items: freshSummary // Use the fresh summary
          },
          scanned_barcodes: session.scanned_barcodes
        };

        // Send webhook to Telegram bot
        const webhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
        if (!webhookUrl) {
          throw new Error('TELEGRAM_BOT_WEBHOOK_URL not configured');
        }

        console.log(`[API/complete] Sending webhook to ${webhookUrl}/webhook/scan-complete`);

        // Note: We are holding the lock while calling the webhook. 
        // This is necessary to prevent double-sends.
        const webhookRes = await fetch(`${webhookUrl}/webhook/scan-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload)
        });

        if (!webhookRes.ok) {
          const errorText = await webhookRes.text();
          console.error(`[API/complete] Webhook failed: ${webhookRes.status} ${webhookRes.statusText} - ${errorText}`);
          throw new Error(`Bot webhook failed: ${webhookRes.status}`);
        }

        console.log('[API/complete] Webhook sent successfully');

        // Mark session as COMPLETED (only after successful webhook)
        session.status = 'COMPLETED';
        session.webhook_sent = true;
        session.completed_at = new Date().toISOString();

        // Save with extended expiry (24 hours)
        await sessionStorage.set(token, session, { ex: 86400 });

        response = {
          success: true,
          summary: session.scanned_items || {},
          scanned_barcodes: session.scanned_barcodes
        };
      });
    } catch (lockError) {
      console.error('[API/complete] Error or Lock failed:', lockError);
      return NextResponse.json(
        { success: false, error: 'Failed to notify bot. Please try again.' },
        { status: 500 }
      );
    }

    if (errorResponse) {
      return errorResponse;
    }

    return NextResponse.json(response!);

  } catch (error) {
    console.error('[API/complete] Error completing session:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to notify bot. Please try again.' },
      { status: 500 }
    );
  }
}
