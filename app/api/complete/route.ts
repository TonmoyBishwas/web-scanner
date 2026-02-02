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

    // Get session
    const session = await sessionStorage.get(token);

    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 }
      );
    }

    // Mark as completed
    session.status = 'COMPLETED';
    session.completed_at = new Date().toISOString();

    // Save with extended expiry (24 hours)
    await sessionStorage.set(token, session, { ex: 86400 });

    // Send webhook to Telegram bot
    const webhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        // Calculate summary
        const totalItems = session.invoice_items.length;
        const totalScans = session.scanned_barcodes.length;
        const totalWeightScanned = Object.values(session.scanned_items).reduce(
          (sum: number, item: any) => sum + (item.scanned_weight || 0),
          0
        );

        await fetch(`${webhookUrl}/webhook/scan-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: session.chat_id,
            token: token,
            document_number: session.document_number,
            operation_type: session.operation_type,
            summary: {
              total_items: totalItems,
              total_scans: totalScans,
              total_weight_scanned: totalWeightScanned,
              scanned_items: session.scanned_items
            },
            scanned_barcodes: session.scanned_barcodes
          })
        }).catch((err) => {
          console.error('Webhook error (non-critical):', err);
        });
      } catch (webhookError) {
        console.error('Failed to send webhook:', webhookError);
        // Don't fail the request if webhook fails
      }
    }

    const response: CompleteResponse = {
      success: true,
      summary: session.scanned_items,
      scanned_barcodes: session.scanned_barcodes
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error completing session:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
