import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/multi-pallet-ocr
 * Synchronous OCR for a single box sticker image in the multi-pallet flow.
 * Unlike /api/ocr (which is fire-and-forget and session-coupled), this
 * blocks until the bot returns a result.
 *
 * Body: { image: string (base64 data URL), barcode?: string }
 * Returns: { success: boolean, ocr_data?: { product_name_hebrew, product_name_english, weight_kg, expiry_date, ... } }
 */
export async function POST(request: NextRequest) {
  try {
    const { image, barcode } = await request.json();

    if (!image) {
      return NextResponse.json({ success: false, error: 'Missing image' }, { status: 400 });
    }

    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (!botUrl) {
      return NextResponse.json({ success: false, error: 'OCR service not configured' }, { status: 500 });
    }

    const res = await fetch(`${botUrl}/webhook/process-box-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, barcode: barcode || 'multi-pallet' }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error('[multi-pallet-ocr] Bot OCR failed:', res.status, res.statusText);
      return NextResponse.json({ success: false, error: 'OCR service error' }, { status: 502 });
    }

    const result = await res.json();

    if (result.status === 'success' && result.ocr_data) {
      return NextResponse.json({ success: true, ocr_data: result.ocr_data });
    }

    return NextResponse.json({ success: false, error: result.error || 'OCR returned no data' });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    console.error('[multi-pallet-ocr] error:', isTimeout ? 'timeout' : error);
    return NextResponse.json(
      { success: false, error: isTimeout ? 'OCR timed out (30s)' : 'Internal error' },
      { status: 500 }
    );
  }
}
