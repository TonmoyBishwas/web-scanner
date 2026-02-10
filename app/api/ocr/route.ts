import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { OCRRequest, OCRResponse, ScanEntry, BoxStickerOCR } from '@/types';

/**
 * POST /api/ocr
 * Submit an image for OCR processing via bot webhook (Gemini 2.5 Flash Lite)
 * This endpoint is non-blocking - OCR is processed asynchronously
 */
export async function POST(request: NextRequest) {
  try {
    const body: OCRRequest = await request.json();
    const { token, image, image_url, barcode } = body;

    // Validate required fields
    if (!token || !barcode || (!image && !image_url)) {
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

    // Update image_url if provided (from Cloudinary)
    if (image_url && !scanEntry.image_url) {
      scanEntry.image_url = image_url;
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

    // Prepare image data - prefer Cloudinary URL, fall back to base64
    let imageToSend = image_url || image;

    // If image_url is provided, fetch it and convert to base64 for OCR
    if (image_url && !image) {
      try {
        const response = await fetch(image_url);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        imageToSend = `data:image/jpeg;base64,${base64}`;
      } catch (fetchError) {
        console.error('Failed to fetch image from Cloudinary:', fetchError);
        imageToSend = image;
      }
    }

    // Call bot webhook for OCR processing (fire and forget)
    fetch(`${botWebhookUrl}/webhook/process-box-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageToSend, barcode })
    })
      .then(async (response) => {
        if (!response.ok) {
          console.error('OCR processing failed:', response.statusText);
          try {
            await sessionStorage.withLock(token, async () => {
              const updatedSession = await sessionStorage.get(token);
              if (updatedSession) {
                const entry = updatedSession.scanned_barcodes.find(
                  (b: ScanEntry) => b.barcode === barcode
                );
                if (entry) {
                  entry.ocr_status = 'failed';
                  // Save session inside lock
                  await sessionStorage.set(token, updatedSession, { ex: 3600 });
                }
              }
            });
          } catch (lockError) {
            console.error('Failed to acquire lock for OCR failure update:', lockError);
          }
          return;
        }

        const ocrResult = await response.json();
        if (ocrResult.status === 'success' && ocrResult.ocr_data) {
          try {
            await sessionStorage.withLock(token, async () => {
              // Re-fetch session inside lock (CRITICAL)
              const latestSession = await sessionStorage.get(token);

              if (latestSession) {
                const entryToUpdate = latestSession.scanned_barcodes.find(
                  (b: ScanEntry) => b.barcode === barcode
                );

                if (entryToUpdate) {
                  // New OCR format
                  const ocrData: BoxStickerOCR = {
                    product_name: ocrResult.ocr_data.product_name || null,
                    weight_kg: ocrResult.ocr_data.weight_kg || null,
                    production_date: ocrResult.ocr_data.production_date || null,
                    expiry_date: ocrResult.ocr_data.expiry_date || null,
                    barcode_digits: ocrResult.ocr_data.barcode_digits || null,
                  };

                  entryToUpdate.ocr_data = ocrData;
                  entryToUpdate.ocr_status = 'complete';
                  entryToUpdate.ocr_processed_at = new Date().toISOString();

                  // Match OCR product name to invoice item and update scanned_items
                  if (ocrData.product_name) {
                    const productName = ocrData.product_name;
                    // ... matching logic ...
                    const matchedItem = latestSession.invoice_items.find(
                      (item: any) => {
                        if (item.item_name_hebrew === productName) return true;
                        if (item.item_name_hebrew && (
                          productName.includes(item.item_name_hebrew) ||
                          item.item_name_hebrew.includes(productName)
                        )) return true;
                        if (item.item_name_english &&
                          item.item_name_english.toLowerCase() === productName.toLowerCase()
                        ) return true;
                        return false;
                      }
                    );

                    if (matchedItem) {
                      const itemIndex = matchedItem.item_index;
                      if (!latestSession.scanned_items[itemIndex]) {
                        latestSession.scanned_items[itemIndex] = {
                          item_index: matchedItem.item_index,
                          item_name: matchedItem.item_name_english,
                          scanned_count: 0,
                          scanned_weight: 0,
                          expected_weight: matchedItem.quantity_kg,
                          expected_boxes: matchedItem.expected_boxes
                        };
                      }
                      latestSession.scanned_items[itemIndex].scanned_count += 1;
                      if (ocrData.weight_kg) {
                        latestSession.scanned_items[itemIndex].scanned_weight += ocrData.weight_kg;
                      }
                      console.log(`[API/ocr] Matched item ${itemIndex} (${matchedItem.item_name_english}). New count: ${latestSession.scanned_items[itemIndex].scanned_count}`);
                    } else {
                      console.log(`[API/ocr] No matching item found for product: ${productName}`);
                    }
                  }

                  // Save the LATEST session inside lock
                  await sessionStorage.set(token, latestSession, { ex: 3600 });
                  console.log(`[API/ocr] Saved session with OCR update for ${barcode}`);
                } else {
                  // Barcode not found (maybe session expired or cleared?)
                  console.warn(`[API/ocr] Barcode ${barcode} not found in latest locked session`);
                }
              }
            });
          } catch (lockError) {
            console.error('Failed to acquire lock for OCR success update:', lockError);
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
