import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { ScanSession } from '@/types';

/**
 * POST /api/issue-complete
 * Complete an issue session. Sends webhook to bot with summary of all issued boxes.
 */
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Missing token' },
        { status: 400 }
      );
    }

    let result: any = null;
    let errorResponse: NextResponse | null = null;

    try {
      await sessionStorage.withLock(token, async () => {
        const session: ScanSession | null = await sessionStorage.get(token);

        if (!session) {
          errorResponse = NextResponse.json(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
          return;
        }

        // Prevent double-completion
        if (session.status === 'COMPLETED' && session.webhook_sent) {
          result = { success: true, message: 'Already completed' };
          return;
        }

        const issuedBoxes = session.issued_boxes || [];

        if (issuedBoxes.length === 0) {
          errorResponse = NextResponse.json(
            { success: false, error: 'No boxes have been issued in this session' },
            { status: 400 }
          );
          return;
        }

        // Build summary
        const totalWeight = issuedBoxes.reduce((sum, b) => sum + b.weight, 0);

        // Group by item name for breakdown
        const itemBreakdown: Record<
          string,
          { item_name: string; boxes: number; weight: number }
        > = {};
        for (const box of issuedBoxes) {
          const key = box.item_name || 'Unknown';
          if (!itemBreakdown[key]) {
            itemBreakdown[key] = { item_name: key, boxes: 0, weight: 0 };
          }
          itemBreakdown[key].boxes += 1;
          itemBreakdown[key].weight += box.weight;
        }

        // Build webhook payload
        const webhookPayload = {
          chat_id: session.chat_id,
          token,
          operation_type: 'ISSUE',
          summary: {
            total_boxes: issuedBoxes.length,
            total_weight: totalWeight,
            item_breakdown: Object.values(itemBreakdown),
            issued_items: issuedBoxes.map((b) => ({
              barcode: b.barcode,
              sku: b.sku,
              item_name: b.item_name,
              weight: b.weight,
              expiry: b.expiry,
              supplier: b.supplier,
              invoice_number: b.invoice_number,
              transaction_id: b.transaction_id,
              box_record_id: b.box_record_id,
              batch_id: b.batch_id,
            })),
          },
        };

        // Send webhook to Telegram bot
        const webhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
        if (!webhookUrl) {
          throw new Error('TELEGRAM_BOT_WEBHOOK_URL not configured');
        }

        console.log(
          `[issue-complete] Sending ISSUE webhook for ${issuedBoxes.length} boxes, ${totalWeight.toFixed(2)} kg`
        );

        const webhookRes = await fetch(
          `${webhookUrl}/webhook/scan-complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookPayload),
          }
        );

        if (!webhookRes.ok) {
          const errorText = await webhookRes.text();
          console.error(
            `[issue-complete] Webhook failed: ${webhookRes.status} - ${errorText}`
          );
          throw new Error(`Bot webhook failed: ${webhookRes.status}`);
        }

        console.log('[issue-complete] Webhook sent successfully');

        // Mark session as completed
        session.status = 'COMPLETED';
        session.webhook_sent = true;
        session.completed_at = new Date().toISOString();

        // Save with extended expiry (24 hours)
        await sessionStorage.set(token, session, { ex: 86400 });

        result = {
          success: true,
          summary: {
            total_boxes: issuedBoxes.length,
            total_weight: totalWeight,
            item_breakdown: Object.values(itemBreakdown),
          },
        };
      });
    } catch (lockError) {
      console.error('[issue-complete] Lock error:', lockError);
      return NextResponse.json(
        { success: false, error: 'Failed to complete. Please try again.' },
        { status: 500 }
      );
    }

    if (errorResponse) return errorResponse;
    return NextResponse.json(result);
  } catch (error) {
    console.error('[issue-complete] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
