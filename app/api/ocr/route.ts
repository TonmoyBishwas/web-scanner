import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { OCRRequest, OCRResponse, ScanEntry } from '@/types';

/**
 * POST /api/ocr
 * Submit an image for OCR processing
 * This endpoint is non-blocking - OCR is processed asynchronously
 */
export async function POST(request: NextRequest) {
  try {
    const body: OCRRequest = await request.json();
    const { token, image, barcode } = body;

    // Validate required fields
    if (!token || !image || !barcode) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Get session
    const session = await sessionStorage.get(token);
    if (!session || session.status !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired session' },
        { status: 400 }
      );
    }

    // Find the scan entry for this barcode
    const scanEntry = session.scanned_barcodes.find(
      (b: ScanEntry) => b.barcode === barcode
    );

    if (!scanEntry) {
      return NextResponse.json(
        { success: false, error: 'Barcode not found in session' },
        { status: 400 }
      );
    }

    // Check if OCR was already processed for this barcode
    if (scanEntry.ocr_status === 'complete') {
      return NextResponse.json({
        success: true,
        ocr_data: scanEntry.ocr_data
      });
    }

    // Mark OCR as pending
    scanEntry.ocr_status = 'pending';
    await sessionStorage.set(token, session, { ex: 3600 });

    // Get bot webhook URL from environment
    const botWebhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (!botWebhookUrl) {
      console.error('TELEGRAM_BOT_WEBHOOK_URL not configured');
      return NextResponse.json(
        { success: false, error: 'OCR service not configured' },
        { status: 500 }
      );
    }

    // Call bot webhook for OCR processing (fire and forget)
    // Process asynchronously to avoid blocking the scanner
    fetch(`${botWebhookUrl}/webhook/process-box-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, barcode })
    })
      .then(async (response) => {
        if (!response.ok) {
          console.error('OCR processing failed:', response.statusText);
          // Update session with failed status
          const updatedSession = await sessionStorage.get(token);
          if (updatedSession) {
            const entry = updatedSession.scanned_barcodes.find(
              (b: ScanEntry) => b.barcode === barcode
            );
            if (entry) {
              entry.ocr_status = 'failed';
              await sessionStorage.set(token, updatedSession, { ex: 3600 });
            }
          }
          return;
        }

        const ocrResult = await response.json();
        if (ocrResult.status === 'success' && ocrResult.ocr_data) {
          // Update session with OCR data
          const updatedSession = await sessionStorage.get(token);
          if (updatedSession) {
            const entry = updatedSession.scanned_barcodes.find(
              (b: ScanEntry) => b.barcode === barcode
            );
            if (entry) {
              entry.ocr_data = ocrResult.ocr_data;
              entry.ocr_status = 'complete';
              entry.ocr_processed_at = new Date().toISOString();
              await sessionStorage.set(token, updatedSession, { ex: 3600 });
            }
          }
        }
      })
      .catch((error) => {
        console.error('OCR webhook error:', error);
      });

    // Return immediately - OCR is processed in background
    return NextResponse.json({
      success: true,
      message: 'OCR processing started'
    });

  } catch (error) {
    console.error('Error submitting OCR:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
