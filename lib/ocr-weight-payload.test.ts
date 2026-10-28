import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The sticker OCR's own weight reaches the bot (Mevaser, 28/10): every carton
 * of a pallet (mix and single) and of the loose pile goes with
 * `ocr_weight_kg` — the row's `ocr_weight`, set once from
 * /api/multi-pallet-ocr before any barcode override — for
 * box_inventory.ocr_weight_kg and the barcode-vs-OCR weight check. Never
 * under the key `ocr_weight`: the bot's reconcile uses that one for the
 * weight it was sent.
 */
const sessions = new Map<string, unknown>();
const botCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

vi.mock('@/lib/redis', () => ({
  getRedisClient: () => ({
    get: async (key: string) => sessions.get(key) ?? null,
    set: async (key: string, value: string) => { sessions.set(key, JSON.parse(value)); },
    del: async (key: string) => { sessions.delete(key); },
  }),
  sessionStorage: { withLock: async (_t: string, fn: () => Promise<void>) => fn() },
}));
vi.mock('@/lib/carton-labels', () => ({ findUnprintedForSession: async () => [] }));
vi.mock('@/lib/server-events', () => ({
  logServerEvent: async () => {},
  errorData: (e: unknown) => ({ error: String(e) }),
  postToBot: async (_token: string, url: string, body: string) => {
    botCalls.push({ url, body: JSON.parse(body) });
    return null;
  },
}));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void fn(); },
}));

const pallet = await import('@/app/api/multi-pallet-complete/route');
const loose = await import('@/app/api/multi-pallet-loose-complete/route');

const TOKEN = 'tokOcrWeight';
const CHICKEN = { item_code: '7290002195832', item_name_hebrew: 'כרעיים עוף', item_name_english: 'Chicken legs', quantity_kg: 40 };
const SALMON = { item_code: '7290011111110', item_name_hebrew: 'סלמון', item_name_english: 'Salmon', quantity_kg: 30 };

const box = (barcode: string, item: typeof CHICKEN, weight: number, over: Record<string, unknown> = {}) => ({
  barcode, sku: barcode.slice(0, 13), item_name: item.item_name_english, item_name_hebrew: item.item_name_hebrew,
  weight, expiry: '2027-10-22', scanned_at: '2026-10-28T10:00:00Z', ...over,
});
// 12.46 kg in the code; the OCR read 4.38 (IN264189933's shape), the page booked the barcode.
const MISREAD = box('7290002195832' + '01246' + '01295' + '14072027', CHICKEN, 12.46, { ocr_weight: 4.38 });
// Code and OCR agree; the OCR's 5 g reading was booked.
const AGREE = box('7290002195832' + '01240' + '01289' + '12072027', CHICKEN, 12.395, { ocr_weight: 12.395 });
// The OCR read no weight.
const NONE = box('7290002195832' + '01300' + '01290' + '12072027', CHICKEN, 13, { ocr_weight: null });
// A row from before this field existed.
const OLD = box('7290011111110' + '01500' + '01300' + '12072027', SALMON, 15);

beforeEach(() => {
  process.env.TELEGRAM_BOT_WEBHOOK_URL = 'http://bot.test';
  botCalls.length = 0;
  sessions.clear();
  sessions.set(`pallet:multi:${TOKEN}`, {
    token: TOKEN, chat_id: '1', pallet_count: 2, loose_box_count: 4, current_pallet: 1,
    document_number: 'W28', ocr_data: [CHICKEN, SALMON], completed_pallets: [], status: 'active',
    category: 'meat',
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

type Sent = { barcode: string; weight: number; ocr_weight_kg?: unknown; ocr_weight?: unknown };
const sentBoxes = () => (botCalls[0].body.scanned_boxes as Sent[]);
const byCode = (code: string) => sentBoxes().find((b) => b.barcode === code)!;

async function completePallet(scanned_boxes: unknown[]) {
  const res = await pallet.POST(new NextRequest('http://scanner.test/api/multi-pallet-complete', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, scanned_boxes, box_count: scanned_boxes.length, pallet_number: 1 }),
  } as never));
  return res.status;
}

async function completeLoose(scanned_boxes: unknown[]) {
  const res = await loose.POST(new NextRequest('http://scanner.test/api/multi-pallet-loose-complete', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, scanned_boxes }),
  } as never));
  return res.status;
}

describe('ocr_weight_kg on every carton sent to the bot', () => {
  it('mix pallet: the OCR reading per carton, null when there was none', async () => {
    expect(await completePallet([MISREAD, AGREE, NONE, OLD])).toBe(200);
    expect(botCalls[0].body.pallet_type).toBe('mix');
    expect(byCode(MISREAD.barcode)).toMatchObject({ weight: 12.46, ocr_weight_kg: 4.38 });
    expect(byCode(AGREE.barcode)).toMatchObject({ weight: 12.395, ocr_weight_kg: 12.395 });
    expect(byCode(NONE.barcode).ocr_weight_kg).toBeNull();
    expect(byCode(OLD.barcode).ocr_weight_kg).toBeNull();
    expect(sentBoxes().every((b) => !('ocr_weight' in b))).toBe(true);
  });

  it('single-item pallet (uniform weights): the same', async () => {
    const twin = { ...AGREE, weight: 12.46, ocr_weight: 12.462 };
    const blank = { ...NONE, weight: 12.46 };
    expect(await completePallet([MISREAD, twin, blank])).toBe(200);
    expect(botCalls[0].body.pallet_type).toBe('single');
    expect(byCode(MISREAD.barcode).ocr_weight_kg).toBe(4.38);
    expect(byCode(twin.barcode).ocr_weight_kg).toBe(12.462);
    expect(byCode(blank.barcode).ocr_weight_kg).toBeNull();
    expect(sentBoxes().every((b) => !('ocr_weight' in b))).toBe(true);
  });

  it('loose pile: renamed to ocr_weight_kg, the rest of the box passed through', async () => {
    expect(await completeLoose([MISREAD, NONE, OLD])).toBe(200);
    expect(botCalls[0].url).toBe('http://bot.test/webhook/loose-boxes-complete');
    expect(byCode(MISREAD.barcode)).toMatchObject({
      weight: 12.46, ocr_weight_kg: 4.38, item_name_hebrew: CHICKEN.item_name_hebrew, expiry: '2027-10-22',
    });
    expect(byCode(NONE.barcode).ocr_weight_kg).toBeNull();
    expect(byCode(OLD.barcode).ocr_weight_kg).toBeNull();
    expect(sentBoxes().every((b) => !('ocr_weight' in b))).toBe(true);
  });
});
