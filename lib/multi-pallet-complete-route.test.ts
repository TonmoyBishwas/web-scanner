import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/multi-pallet-complete against an in-memory session store, with
 * the bot call captured instead of sent. Pins what the bot receives for a
 * nameless carton (S03, 23/10, lib/failed-read.ts snapNamelessByCode): a
 * 31-digit carton whose GTIN is an invoice item_code is booked under that
 * line, and the SCN-11 filter still drops a true ghost.
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

const route = await import('@/app/api/multi-pallet-complete/route');

const TOKEN = 'tokS03';
// S03's chicken line and carton C13 (12.570 kg, 22/10/2027).
const CHICKEN = { item_code: '7290002195832', item_name_hebrew: 'כרעיים עוף', item_name_english: 'Chicken legs', quantity_kg: 184.31 };
const SALMON = { item_code: '7290011111110', item_name_hebrew: 'סלמון', item_name_english: 'Salmon', quantity_kg: 60 };
const C13 = '7290002195832' + '012570' + '1306' + '22102027';

const box = (barcode: string, over: Record<string, unknown> = {}) => ({
  barcode, sku: barcode.slice(0, 13), item_name: '', item_name_hebrew: '', weight: 0, expiry: '',
  scanned_at: '2026-10-23T14:00:00Z', ...over,
});
const chicken = (n: number, kg: number) => box(`7290002195832${String(10000 + n).padStart(6, '0')}130622102027`, {
  item_name: CHICKEN.item_name_english, item_name_hebrew: CHICKEN.item_name_hebrew, weight: kg, expiry: '2027-10-22',
});
const salmon = (n: number) => box(`7290011111110${String(15000 + n).padStart(6, '0')}130622102027`, {
  item_name: SALMON.item_name_english, item_name_hebrew: SALMON.item_name_hebrew, weight: 15, expiry: '2027-10-22',
});

async function complete(scanned_boxes: unknown[]) {
  const res = await route.POST(new NextRequest('http://scanner.test/api/multi-pallet-complete', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, scanned_boxes, box_count: scanned_boxes.length, pallet_number: 1 }),
  } as never));
  return { status: res.status, data: await res.json() };
}

let savedBotUrl: string | undefined;
beforeEach(() => {
  savedBotUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
  process.env.TELEGRAM_BOT_WEBHOOK_URL = 'http://bot.test';
  botCalls.length = 0;
  sessions.clear();
  sessions.set(`pallet:multi:${TOKEN}`, {
    token: TOKEN, chat_id: '1', pallet_count: 2, loose_box_count: 0, current_pallet: 1,
    document_number: 'S03', ocr_data: [CHICKEN, SALMON], completed_pallets: [], status: 'active',
    category: 'meat',
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  process.env.TELEGRAM_BOT_WEBHOOK_URL = savedBotUrl;
  vi.restoreAllMocks();
});

type Item = { item_code: string; item_name_hebrew: string; name_key: string; box_count: number; calculated_total_weight: number };
type SentBox = { barcode: string; name_key: string; item_name_hebrew: string };

describe('multi-pallet-complete: a nameless carton', () => {
  it('S03: an empty-name 31-digit row whose GTIN is an invoice item_code groups into that line', async () => {
    const { status, data } = await complete([chicken(1, 12.2), chicken(2, 12.9), box(C13), salmon(1), salmon(2)]);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(botCalls).toHaveLength(1);
    const sent = botCalls[0].body;
    expect(sent.pallet_type).toBe('mix');
    const items = sent.items as Item[];
    expect(items).toHaveLength(2);
    const line = items.find((i) => i.item_code === CHICKEN.item_code)!;
    expect(line.box_count).toBe(3);
    // The carton's weight stays what the page sent (0 here); the bot fills
    // it from the barcode. What matters is that it belongs to the line.
    const c13 = (sent.scanned_boxes as SentBox[]).find((b) => b.barcode === C13)!;
    expect(c13.name_key).toBe(line.name_key);
    expect(c13.item_name_hebrew).toBe(CHICKEN.item_name_hebrew);
    expect(items.some((i) => i.name_key.startsWith('unknown:'))).toBe(false);
  });

  it('SCN-11 still drops a true ghost (no name, no weight, no code on the invoice)', async () => {
    const ghost = box('7290099999999012570130622102027');
    const { status } = await complete([chicken(1, 12.2), salmon(1), ghost]);
    expect(status).toBe(200);
    const sent = botCalls[0].body;
    const items = sent.items as Item[];
    expect(items.map((i) => i.item_code).sort()).toEqual([CHICKEN.item_code, SALMON.item_code].sort());
    // Its row still travels in scanned_boxes, unnamed.
    const row = (sent.scanned_boxes as SentBox[]).find((b) => b.barcode === ghost.barcode)!;
    expect(row.name_key).toBe(`unknown:${ghost.barcode}`);
    expect(sent.verified_scan_count).toBe(3);
  });
});

describe('multi-pallet-complete: a units line declared on a pallet (27/10)', () => {
  // Note 008955's KK117: 7 cartons x 18 portions = 126 UNITS in quantity_kg.
  const KK117 = { item_code: 'KK117', item_name_hebrew: 'מנה', item_name_english: 'Meal', quantity_kg: 126, box_count: 7, unit: 'units' };

  it('the declared total stays in the line\'s own unit: 7 cartons = 126 units, never 0', async () => {
    sessions.set(`pallet:multi:${TOKEN}`, {
      ...(sessions.get(`pallet:multi:${TOKEN}`) as Record<string, unknown>),
      ocr_data: [KK117],
    });
    const res = await route.POST(new NextRequest('http://scanner.test/api/multi-pallet-complete', {
      method: 'POST',
      body: JSON.stringify({
        token: TOKEN, scanned_boxes: [], box_count: 7, pallet_number: 1,
        manual_declared: true, manual_items: [{ item_key: 'KK117', box_count: 7 }],
      }),
    } as never));
    expect(res.status).toBe(200);
    const items = botCalls[0].body.items as Array<Item & { ocr_box_weight: number }>;
    expect(items).toHaveLength(1);
    expect(items[0].box_count).toBe(7);
    expect(items[0].calculated_total_weight).toBe(126);
    expect(items[0].ocr_box_weight).toBe(18);
  });
});
