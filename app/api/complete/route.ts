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

        // Prepare webhook payload
        const totalItems = session.invoice_items.length;
        const totalScans = session.scanned_barcodes.length;
        let totalWeightScanned = 0;
        if (session.scanned_items) {
          totalWeightScanned = Object.values(session.scanned_items).reduce(
            (sum: number, item: any) => sum + (item.scanned_weight || 0),
            0
          );
        }

        const webhookPayload = {
          chat_id: session.chat_id,
          token: token,
          document_number: session.document_number,
          operation_type: session.operation_type,
          summary: {
            total_items: totalItems,
            total_scans: totalScans,
            total_weight_scanned: totalWeightScanned,
            scanned_items: session.scanned_items || {}
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
