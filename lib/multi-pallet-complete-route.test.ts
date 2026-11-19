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
// no_hand_codes (05/11): off unless a test turns it on; the real reader
// would ask the database.
let noHandCodes = false;
// glatt_code_match (11/11): likewise off unless a test turns it on.
let glattCodeMatch = false;
vi.mock('@/lib/scanner-flags', () => ({ noHandCodesOn: async () => noHandCodes, glattCodeMatchOn: async () => glattCodeMatch }));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void fn(); },
}));

const route = await import('@/app/api/multi-pallet-complete/route');
const { groupKeyForBox } = await import('@/lib/group-key');

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
  noHandCodes = false;
  glattCodeMatch = false;
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

describe('multi-pallet-complete: the single-item question on 2 weightless-label samples (04/11)', () => {
  // Glatt ground turkey 2465: the label prints no net weight (25-digit code,
  // weight field 0001); the worker typed 8 kg on two cartons, answered the
  // single-item question and declared 50. The page hands the declared total
  // and the locked group over explicitly (handlePalletCountSubmit →
  // handleConfirmPallet({ boxCount, groups })) — this pins what the bot gets.
  const TURKEY = { item_code: '2465', item_name_hebrew: 'הודו טחון 500 גרם', item_name_english: '', quantity_kg: 800 };
  const g = (serial: string) => box('1' + '02465' + '010010' + '0001' + serial, {
    item_name_hebrew: TURKEY.item_name_hebrew, weight: 8, expiry: '2027-02-26', weight_typed: true,
  });

  it('2 samples + declared 50 → one single-item line of 50 cartons, 400 kg', async () => {
    sessions.set(`pallet:multi:${TOKEN}`, {
      ...(sessions.get(`pallet:multi:${TOKEN}`) as Record<string, unknown>),
      ocr_data: [TURKEY],
    });
    const samples = [g('000708241'), g('000708309')];
    const name_key = groupKeyForBox(samples[0]);
    const res = await route.POST(new NextRequest('http://scanner.test/api/multi-pallet-complete', {
      method: 'POST',
      body: JSON.stringify({
        token: TOKEN, scanned_boxes: samples, box_count: 50, pallet_number: 1,
        uniform_groups: [{ name_key, total_count: 50, avg_weight: 8 }],
      }),
    } as never));
    expect(res.status).toBe(200);
    // One item → the bot's single-pallet shape: the line's fields at the top.
    const sent = botCalls[0].body;
    expect(sent.pallet_type).toBe('single');
    expect(sent.item_code).toBe('2465');
    expect(sent.box_count).toBe(50);
    expect(sent.ocr_box_weight).toBe(8);
    expect(sent.calculated_total_weight).toBe(400);
    expect(sent.verified_scan_count).toBe(2);
  });
});

describe('multi-pallet-complete: no_hand_codes (05/11)', () => {
  const nobc = box('NOBC-S03-P1-3', { sku: '', item_name_hebrew: CHICKEN.item_name_hebrew, item_name: CHICKEN.item_name_english, weight: 12.4, expiry: '2027-10-22' });
  type Sent = { barcode: string; sku: string; barcode_source?: string; barcode_format_ok?: boolean | null };

  it('off: a carton booked without a barcode still goes as its NOBC- marker', async () => {
    const { status } = await complete([chicken(1, 12.2), nobc, salmon(1)]);
    expect(status).toBe(200);
    const sent = botCalls[0].body.scanned_boxes as Sent[];
    const row = sent.find((b) => b.barcode.startsWith('NOBC-'))!;
    expect(row.barcode_source).toBe('minted');
  });

  it('on: it goes with no barcode and no barcode_source (pending); the real codes and the count are untouched', async () => {
    noHandCodes = true;
    const manual = box('MANUAL-1793781692727-4v2wvr', { sku: 'MANUAL-1793781692727-4v2wvr', item_name_hebrew: SALMON.item_name_hebrew, item_name: SALMON.item_name_english, weight: 15, expiry: '2027-10-22' });
    const { status } = await complete([chicken(1, 12.2), nobc, salmon(1), manual]);
    expect(status).toBe(200);
    const body = botCalls[0].body;
    const sent = body.scanned_boxes as Sent[];
    expect(sent).toHaveLength(4);
    expect(body.verified_scan_count).toBe(4);
    const blank = sent.filter((b) => b.barcode === '');
    expect(blank).toHaveLength(2);
    for (const b of blank) {
      expect(b.sku).toBe('');
      expect(b.barcode_source).toBeUndefined();
      expect(b.barcode_format_ok).toBeUndefined();
    }
    expect(sent.some((b) => /^(MANUAL|NOBC)-/.test(b.barcode))).toBe(false);
    const items = body.items as Item[];
    expect(items.find((i) => i.item_code === CHICKEN.item_code)!.box_count).toBe(2);
    expect(items.find((i) => i.item_code === SALMON.item_code)!.box_count).toBe(2);
    // The real codes keep their provenance.
    expect(sent.find((b) => b.barcode === chicken(1, 12.2).barcode)!.barcode_source).toBe('scan');
  });

  it('on: a uniform pallet with a no-barcode sample still books 2 samples + the declared 50', async () => {
    noHandCodes = true;
    const TURKEY = { item_code: '2465', item_name_hebrew: 'הודו טחון 500 גרם', item_name_english: '', quantity_kg: 800 };
    sessions.set(`pallet:multi:${TOKEN}`, {
      ...(sessions.get(`pallet:multi:${TOKEN}`) as Record<string, unknown>),
      ocr_data: [TURKEY],
    });
    const real = box('1024650100100001670708241', { item_name_hebrew: TURKEY.item_name_hebrew, weight: 8, expiry: '2027-02-26' });
    const pending = box('NOBC-S03-P1-2', { sku: '', item_name_hebrew: TURKEY.item_name_hebrew, weight: 8, expiry: '2027-02-26' });
    const name_key = groupKeyForBox(real);
    const res = await route.POST(new NextRequest('http://scanner.test/api/multi-pallet-complete', {
      method: 'POST',
      body: JSON.stringify({
        token: TOKEN, scanned_boxes: [real, pending], box_count: 50, pallet_number: 1,
        uniform_groups: [{ name_key, total_count: 50, avg_weight: 8 }],
      }),
    } as never));
    expect(res.status).toBe(200);
    const sent = botCalls[0].body;
    expect(sent.pallet_type).toBe('single');
    expect(sent.box_count).toBe(50);
    expect(sent.calculated_total_weight).toBe(400);
    expect(sent.verified_scan_count).toBe(2);
    expect((sent.scanned_boxes as Sent[]).map((b) => b.barcode)).toEqual([real.barcode, '']);
  });

  it('on: a Type A non-meat sample captured by photo goes with no code', async () => {
    noHandCodes = true;
    const RICE = { item_code: '500', item_name_hebrew: 'אורז', item_name_english: 'Rice', quantity_kg: 100, box_count: 10, unit_weight_kg: 10 };
    sessions.set(`pallet:multi:${TOKEN}`, {
      ...(sessions.get(`pallet:multi:${TOKEN}`) as Record<string, unknown>),
      category: 'non_meat', ocr_data: [RICE],
    });
    const { nonMeatItemKey } = await import('@/lib/nonmeat-key');
    const res = await route.POST(new NextRequest('http://scanner.test/api/multi-pallet-complete', {
      method: 'POST',
      body: JSON.stringify({
        token: TOKEN, pallet_number: 1,
        nonmeat_items: [{ item_key: nonMeatItemKey(RICE), box_count: 10, sample_barcode: 'MANUAL-1-0' }],
      }),
    } as never));
    expect(res.status).toBe(200);
    const sent = botCalls[0].body;
    const json = JSON.stringify(sent);
    expect(json.includes('MANUAL-')).toBe(false);
  });
});

describe('multi-pallet-complete: glatt_code_match (11/11, MB Glatt 261064790)', () => {
  const L1510 = { item_code: '1510', item_name_hebrew: 'שניצל עוף פרוס 100-מוסדי-קפוא', item_name_english: '', quantity_kg: 100 };
  const L5035 = { item_code: '5035', item_name_hebrew: 'שניצל עוף אמיתי-120 גרם', item_name_english: '', quantity_kg: 100 };
  const L5086 = { item_code: '5086', item_name_hebrew: 'כדורי עוף-ת. הזנה', item_name_english: '', quantity_kg: 100 };
  const glatt = (code: string, name: string, kg: number, over: Record<string, unknown> = {}) =>
    box(code, { item_name_hebrew: name, weight: kg, expiry: '2027-02-26', ...over });
  // Two real 05086 cartons, sent under the 1510 line's name (what the page
  // snapped them to by name), beside a real 05035 carton.
  const wrong = [
    glatt('1050861100101014067939346', L1510.item_name_hebrew, 10.14),
    glatt('1050861100101011067939359', L1510.item_name_hebrew, 10.11),
  ];
  const seed = () => sessions.set(`pallet:multi:${TOKEN}`, {
    ...(sessions.get(`pallet:multi:${TOKEN}`) as Record<string, unknown>),
    ocr_data: [L1510, L5035, L5086],
  });
  const items = () => (botCalls[0].body.items as Item[]) ?? [{ item_code: botCalls[0].body.item_code as string } as Item];

  it('off: the group goes by its name, as before (1510)', async () => {
    seed();
    const { status } = await complete([...wrong, glatt('1050351100101011067952479', L5035.item_name_hebrew, 10.11)]);
    expect(status).toBe(200);
    expect(items().map((i) => i.item_code).sort()).toEqual(['1510', '5035']);
  });

  it("on: the group's own Glatt code names its line (5086)", async () => {
    seed();
    glattCodeMatch = true;
    const { status } = await complete([...wrong, glatt('1050351100101011067952479', L5035.item_name_hebrew, 10.11)]);
    expect(status).toBe(200);
    expect(items().map((i) => i.item_code).sort()).toEqual(['5035', '5086']);
  });

  it("on: a carton the worker settled himself (named_by_worker) keeps its name's line", async () => {
    seed();
    glattCodeMatch = true;
    const settled = wrong.map((b) => ({ ...b, named_by_worker: true }));
    const { status } = await complete([...settled, glatt('1050351100101011067952479', L5035.item_name_hebrew, 10.11)]);
    expect(status).toBe(200);
    expect(items().map((i) => i.item_code).sort()).toEqual(['1510', '5035']);
  });

  // The whole note (lines and real cartons of 261064790): 05076 is the
  // 5075 line's product (32 of its cartons were booked there), so a 05076
  // carton named as another schnitzel line belongs on 5075 once the other
  // lines' cartons are counted.
  const L1565 = { item_code: '1565', item_name_hebrew: 'שניצל עוף פרוס 120-מוסדי-קפוא', item_name_english: '', quantity_kg: 100 };
  const L5075 = { item_code: '5075', item_name_hebrew: 'שניצלון הודו-ת. הזנה', item_name_english: '', quantity_kg: 100 };
  const NOTE = [L1510, L1565, L5035, L5086, L5075];
  const C01510 = ['1015101100100976069559252', '1015101100101005069559265'];
  const C01565 = '1015651100101200069572563';
  const C05035 = '1050351100101011067952479';
  const C05086 = '1050861100101011067939359';
  const C05076 = '1050761100101017067924891';
  // The session as beforeEach left it, read once per test: a completion
  // marks its pallet done, and a second one on top would be refused (409).
  let fresh: Record<string, unknown> | undefined;
  const withBooked = (barcodes: string[]) => {
    fresh ??= sessions.get(`pallet:multi:${TOKEN}`) as Record<string, unknown>;
    sessions.set(`pallet:multi:${TOKEN}`, {
      ...fresh, ocr_data: NOTE,
      completed_pallets: [{ pallet_number: 2, lpn: 'LPN-X-P2', pallet_type: 'mix', box_count: barcodes.length, barcodes }],
    });
  };
  const lines = () => items().map((i) => `${i.item_code}:${i.box_count}`).sort();

  it('on: a 05076 carton (no line) named as 5035 goes to 5075, the one schnitzel line no other carton carries', async () => {
    fresh = undefined;
    const c05076 = () => [glatt(C05076, L5035.item_name_hebrew, 10.17)];
    withBooked([C01510[0], C01565, C05035, C05086]);
    await complete(c05076());
    expect(items()[0].item_code).toBe('5035'); // off: by the name, as before
    botCalls.length = 0;
    glattCodeMatch = true;
    withBooked([C01510[0], C01565, C05035, C05086]);
    const { status } = await complete(c05076());
    expect(status).toBe(200);
    expect(items()[0].item_code).toBe('5075');
  });

  // Review 11/11: the page names a carton once, when its read comes back. A
  // 05076 carton read before any 01510 carton was on the session was named
  // as 1510; the 01510 cartons scanned after it share its name. The group's
  // pooled codes {1510, 5076} gave 1510 for all three.
  it('on: a 05076 carton named as 1510 before the 01510 cartons were scanned is not booked with them', async () => {
    fresh = undefined;
    const pallet = () => [
      glatt(C05076, L1510.item_name_hebrew, 10.17),
      glatt(C01510[0], L1510.item_name_hebrew, 9.76),
      glatt(C01510[1], L1510.item_name_hebrew, 10.05),
    ];
    withBooked([C01565, C05035, C05086]);
    await complete(pallet());
    expect(lines()).toEqual(['1510:3']); // off: one name, one line, as before
    botCalls.length = 0;
    glattCodeMatch = true;
    withBooked([C01565, C05035, C05086]);
    const { status } = await complete(pallet());
    expect(status).toBe(200);
    expect(lines()).toEqual(['1510:2', '5075:1']);
    // Each box travels under its own line's name, so the bot hangs it there.
    const boxes = botCalls[0].body.scanned_boxes as Array<{ barcode: string; item_name_hebrew: string; name_key: string }>;
    const b05076 = boxes.find((b) => b.barcode === C05076)!;
    expect(b05076.item_name_hebrew).toBe(L5075.item_name_hebrew);
    expect((botCalls[0].body.items as Item[]).find((i) => i.item_code === '5075')?.name_key).toBe(b05076.name_key);
  });
});
