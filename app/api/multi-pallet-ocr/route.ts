import { logServerEvent, errorData } from '@/lib/server-events';
import { NextRequest, NextResponse } from 'next/server';
import { touchSession } from '@/lib/redis';
import { ocrWeightFromBarcode } from '@/lib/barcode-weight';

/**
 * POST /api/multi-pallet-ocr
 * Synchronous OCR for a single box sticker image in the multi-pallet flow.
 * Unlike /api/ocr (which is fire-and-forget and session-coupled), this
 * blocks until the bot returns a result.
 *
 * Body: { image: string (base64 data URL), barcode?: string,
 *         candidates?: Array<{name_hebrew, name_english, code}> }
 *   `candidates` = the delivery's invoice items, forwarded so the bot's OCR
 *   prompt can pick a known canonical Hebrew name (closed set).
 * Returns: { success: boolean, ocr_data?: { product_name_hebrew, product_name_english, weight_kg, expiry_date, ... } }
 */
const OCR_TIMEOUT_MS = 55000;

export async function POST(request: NextRequest) {
  let traceToken = '';
  let traceBarcode = '';
  const started = Date.now();
  try {
    const { image, barcode, candidates, token } = await request.json();
    traceToken = typeof token === 'string' ? token : '';
    traceBarcode = typeof barcode === 'string' ? barcode : '';

    // Every scan is activity: keep the session alive while the worker is
    // working on it (SCN-24). Fire-and-forget — OCR must not wait on it.
    if (typeof token === 'string' && token) {
      touchSession(token).catch((err) => console.warn('[multi-pallet-ocr] touch failed:', err));
    }

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
      body: JSON.stringify({ image, barcode: barcode || 'multi-pallet', candidates: candidates || undefined }),
      // Longer than the bot's whole box-OCR budget (OCR_BUDGET_S = 40 s in
      // box_sticker_ocr_service.py) plus a cold start: at 30 s, with the bot
      // allowed 30 s per model, one stalled model turned readable stickers red
      // a moment before the next model answered (S01, 23/10).
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error('[multi-pallet-ocr] Bot OCR failed:', res.status, res.statusText);
      await logServerEvent(traceToken, 'bot_callback', {
        route: 'multi-pallet-ocr', path: '/webhook/process-box-ocr', status: res.status, ok: false,
        ms: Date.now() - started, barcode: traceBarcode,
      });
      return NextResponse.json({ success: false, error: 'OCR service error' }, { status: 502 });
    }

    const result = await res.json();

    if (result.status === 'success' && result.ocr_data) {
      // A Glatt 25-digit carton code carries the carton's net weight, and on
      // 747 past cartons it was right wherever the label OCR disagreed with
      // it (lib/barcode-weight.ts). Its weight is what the carton is booked
      // at; the OCR's reading only fills in when there is no such code.
      // Server-side so every page (and a phone on an older bundle) gets it.
      // Nothing changes on the worker's screen.
      const fromBarcode = ocrWeightFromBarcode(traceBarcode, result.ocr_data.weight_kg);
      if (fromBarcode) {
        if (fromBarcode.event) {
          await logServerEvent(traceToken, 'weight_barcode_override', fromBarcode.event);
        }
        return NextResponse.json({ success: true, ocr_data: { ...result.ocr_data, weight_kg: fromBarcode.weight_kg } });
      }
      return NextResponse.json({ success: true, ocr_data: result.ocr_data });
    }

    return NextResponse.json({ success: false, error: result.error || 'OCR returned no data' });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    console.error('[multi-pallet-ocr] error:', isTimeout ? 'timeout' : error);
    await logServerEvent(traceToken, 'route_error', errorData(error, {
      route: 'multi-pallet-ocr', timeout: isTimeout, ms: Date.now() - started, barcode: traceBarcode,
    }));
    return NextResponse.json(
      { success: false, error: isTimeout ? `OCR timed out (${OCR_TIMEOUT_MS / 1000}s)` : 'Internal error' },
      { status: 500 }
    );
  }
}
