import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/multi-pallet-ocr with the bot's OCR answer stubbed: a Glatt
 * 25-digit carton is booked at its barcode weight (28/10), the override is
 * traced, and every other carton gets the OCR's reading untouched.
 */
const events: Array<{ token: unknown; event: string; data: unknown }> = [];

vi.mock('@/lib/redis', () => ({ touchSession: async () => {} }));
vi.mock('@/lib/server-events', () => ({
  logServerEvent: async (token: unknown, event: string, data: unknown) => { events.push({ token, event, data }); },
  errorData: (e: unknown) => ({ error: String(e) }),
}));

const route = await import('@/app/api/multi-pallet-ocr/route');

let botAnswer: Record<string, unknown> = {};
const botBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  events.length = 0;
  botBodies.length = 0;
  process.env.TELEGRAM_BOT_WEBHOOK_URL = 'http://bot.test';
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    botBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(botAnswer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function ocr(barcode: string, weight_kg: unknown) {
  botAnswer = { status: 'success', ocr_data: { product_name_hebrew: 'פילה עוף', weight_kg, expiry_date: '2026-11-20' } };
  const res = await route.POST(new NextRequest('http://scanner.test/api/multi-pallet-ocr', {
    method: 'POST',
    body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA', barcode, token: 'tokGlatt', candidates: [] }),
  } as never));
  return res.json();
}

describe('/api/multi-pallet-ocr — barcode weight', () => {
  it('Glatt code, OCR 10.15 → 10.12 booked, override traced', async () => {
    const data = await ocr('1050861100101012067935140', 10.15);
    expect(data.success).toBe(true);
    expect(data.ocr_data.weight_kg).toBe(10.12);
    // The OCR's own reading goes back beside it, for the weight check.
    expect(data.ocr_data.ocr_weight_kg).toBe(10.15);
    // Everything else the OCR read is passed through.
    expect(data.ocr_data.product_name_hebrew).toBe('פילה עוף');
    expect(data.ocr_data.expiry_date).toBe('2026-11-20');
    expect(events).toEqual([{
      token: 'tokGlatt',
      event: 'weight_barcode_override',
      data: { barcode: '1050861100101012067935140', ocr_kg: 10.15, barcode_kg: 10.12, source: 'glatt25', item_code: '05086' },
    }]);
    // The bot still gets the scanned code (photo upright, name check).
    expect(botBodies[0].barcode).toBe('1050861100101012067935140');
  });

  it('Glatt code, OCR agrees → the OCR weight stays, no trace', async () => {
    const data = await ocr('1015781100101359065737237', 13.595);
    expect(data.ocr_data.weight_kg).toBe(13.595);
    expect(data.ocr_data.ocr_weight_kg).toBe(13.595);
    expect(events).toEqual([]);
  });

  it('Glatt code, OCR read no weight → filled from the barcode, ocr_weight_kg null', async () => {
    const data = await ocr('1015781100101495074263576', null);
    expect(data.ocr_data.weight_kg).toBe(14.95);
    expect(data.ocr_data.ocr_weight_kg).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['weight_barcode_override']);
  });

  it('per-product code → the OCR weight, untouched', async () => {
    const data = await ocr('7290020497000', 0.9);
    expect(data.ocr_data.weight_kg).toBe(0.9);
    expect(data.ocr_data.ocr_weight_kg).toBe(0.9);
    expect(events).toEqual([]);
  });

  it('31-digit code → untouched here (the page reconciles it with its guards)', async () => {
    const data = await ocr('7290002195832' + '012570' + '1306' + '22102027', 14.34);
    expect(data.ocr_data.weight_kg).toBe(14.34);
    expect(data.ocr_data.ocr_weight_kg).toBe(14.34);
    expect(events).toEqual([]);
  });

  it('a units Glatt code (mid 140010) → the OCR weight, untouched', async () => {
    const data = await ocr('1043041400100001178251135', 6.6);
    expect(data.ocr_data.weight_kg).toBe(6.6);
    expect(events).toEqual([]);
  });

  it('manual capture (no decoded barcode) → the OCR weight, even if its printed digits are Glatt', async () => {
    const data = await ocr('', 10.15);
    expect(data.ocr_data.weight_kg).toBe(10.15);
    expect(events).toEqual([]);
  });

  it('26-digit misread → the OCR weight', async () => {
    const data = await ocr('10508611001010140679351090', 10.15);
    expect(data.ocr_data.weight_kg).toBe(10.15);
  });
});
