import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_WAIT_BEFORE_BOOK_MS,
  blocksConfirm,
  failedReadPrefill,
  heldAfterReads,
  snapNamelessByCode,
  waitForReads,
} from './failed-read';
import { groupBoxesByName } from './group-key';
import { isEmptySummaryLine } from './pallet-lines';

// S03, 23/10: carton C13 of the chicken line — 12.570 kg, expiry 22/10/2027.
const C13 = '7290002195832' + '012570' + '1306' + '22102027';
const CHICKEN = { item_code: '7290002195832', item_name_hebrew: 'כרעיים עוף', item_name_english: 'Chicken legs', quantity_kg: 184.31 };
const SALMON = { item_code: '7290011111110', item_name_hebrew: 'סלמון', item_name_english: 'Salmon', quantity_kg: 60 };
const INVOICE = [CHICKEN, SALMON];
const RECEIVED = '2026-10-23';

const failedRow = (over: Record<string, unknown> = {}) => ({
  barcode: C13, sku: C13.slice(0, 13), item_name: '', item_name_hebrew: '', weight: 0, expiry: '',
  ocr_status: 'failed', captured_via: 'scan' as const, ...over,
});

describe('blocksConfirm (the confirm gate and the amber footer share it)', () => {
  it('holds a row flagged needs_review, as before', () => {
    expect(blocksConfirm({ needs_review: true, ocr_status: 'done' })).toBe(true);
  });
  it('holds a row whose label read failed (S03: C13 passed the gate with no name, 0 kg)', () => {
    expect(blocksConfirm({ ocr_status: 'failed' })).toBe(true);
    expect(blocksConfirm({ ocr_status: 'failed', needs_review: undefined })).toBe(true);
  });
  it('lets a read row through, and a row still being read is not "needs a detail"', () => {
    expect(blocksConfirm({ ocr_status: 'done' })).toBe(false);
    expect(blocksConfirm({ ocr_status: 'processing' })).toBe(false);
  });
});

describe('failedReadPrefill (a failed read keeps what the barcode and the invoice already say)', () => {
  it('fills weight and expiry from a 31-digit barcode, and the name from the line its GTIN is', () => {
    const { patch, events } = failedReadPrefill(failedRow(), INVOICE, { receivedIso: RECEIVED });
    expect(patch).toEqual({
      weight: 12.57,
      expiry: '2027-10-22',
      barcode_filled: { weight: null, expiry: null },
      item_name: 'Chicken legs',
      item_name_hebrew: 'כרעיים עוף',
    });
    expect(events.map((e) => [e.field, e.action])).toEqual([['weight', 'filled'], ['expiry', 'filled']]);
  });

  it('never marks the weight as checked and never touches ocr_status — the worker still has to look', () => {
    const { patch } = failedReadPrefill(failedRow(), INVOICE, { receivedIso: RECEIVED });
    expect(patch).not.toHaveProperty('weight_checked');
    expect(patch).not.toHaveProperty('ocr_status');
    expect(patch).not.toHaveProperty('needs_review');
  });

  it('leaves a manual capture alone (its code is a placeholder or OCR digits)', () => {
    expect(failedReadPrefill(failedRow({ captured_via: 'manual' }), INVOICE, { receivedIso: RECEIVED }).patch).toEqual({});
    expect(failedReadPrefill(failedRow({ barcode: 'MANUAL-1789', captured_via: 'manual' }), INVOICE, { receivedIso: RECEIVED }).patch).toEqual({});
  });

  it('a 25-digit barcode carries no weight: only the name, by its GTIN prefix', () => {
    const code25 = '7290002195832' + '015168845516';
    const { patch, events } = failedReadPrefill(failedRow({ barcode: code25 }), INVOICE, { receivedIso: RECEIVED });
    expect(patch).toEqual({ item_name: 'Chicken legs', item_name_hebrew: 'כרעיים עוף' });
    expect(events).toEqual([]);
  });

  it('no name when no line, or two different lines, carry the code', () => {
    const other = '7290099999999' + '012570' + '1306' + '22102027';
    expect(failedReadPrefill(failedRow({ barcode: other }), INVOICE, { receivedIso: RECEIVED }).patch)
      .toEqual({ weight: 12.57, expiry: '2027-10-22', barcode_filled: { weight: null, expiry: null } });
    const twoLines = [CHICKEN, { ...SALMON, item_code: '729000219583' }];
    expect(failedReadPrefill(failedRow(), twoLines, { receivedIso: RECEIVED }).patch).not.toHaveProperty('item_name_hebrew');
  });

  it('keeps a name the row already has, and a value the worker saved', () => {
    const named = failedRow({ item_name_hebrew: 'עוף אחר', weight: 11, weight_checked: true, expiry: '2027-01-01', expiry_checked: true });
    expect(failedReadPrefill(named, INVOICE, { receivedIso: RECEIVED }).patch).toEqual({});
  });

  it('nothing to change on a row already holding the barcode values (a second failure)', () => {
    const again = failedRow({ weight: 12.57, expiry: '2027-10-22', item_name: 'Chicken legs', item_name_hebrew: 'כרעיים עוף' });
    expect(failedReadPrefill(again, INVOICE, { receivedIso: RECEIVED }).patch).toEqual({});
  });

  it('a barcode expiry that cannot be meant is not filled (the 2007 guard)', () => {
    const y2007 = '7290002195832' + '012570' + '1306' + '22102007';
    const { patch } = failedReadPrefill(failedRow({ barcode: y2007 }), [], { receivedIso: RECEIVED });
    expect(patch).toEqual({ weight: 12.57, barcode_filled: { weight: null } });
  });
});

describe('heldAfterReads (what the confirm does once in-flight reads are waited for)', () => {
  it('books when every waited row was read cleanly', () => {
    const rows = [{ barcode: 'a', ocr_status: 'done' }, { barcode: 'b', ocr_status: 'done' }];
    expect(heldAfterReads(rows, new Set(['b']), { soft: false })).toEqual([]);
  });
  it('holds a waited row that came back failed or flagged, even in soft mode (nobody saw it yet)', () => {
    const rows = [{ barcode: 'a', ocr_status: 'failed' }, { barcode: 'b', ocr_status: 'done', needs_review: true }];
    expect(heldAfterReads(rows, new Set(['a', 'b']), { soft: true })).toEqual(['a', 'b']);
  });
  it('holds any failed row when warnings block (a confirm that skipped the footer gate)', () => {
    const rows = [{ barcode: 'a', ocr_status: 'failed' }, { barcode: 'b', ocr_status: 'done' }];
    expect(heldAfterReads(rows, new Set(), { soft: false })).toEqual(['a']);
  });
  it('soft mode: a failed row the worker already saw goes on to the force-confirm', () => {
    const rows = [{ barcode: 'a', ocr_status: 'failed' }];
    expect(heldAfterReads(rows, new Set(), { soft: true })).toEqual([]);
  });
});

describe('waitForReads (bounded wait for in-flight label reads before booking)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns at once when nothing is being read', async () => {
    await expect(waitForReads(() => false)).resolves.toBe(true);
  });

  it('returns as soon as the reads finish', async () => {
    let pending = true;
    const p = waitForReads(() => pending, { timeoutMs: 30_000, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(1_000);
    pending = false;
    await vi.advanceTimersByTimeAsync(250);
    await expect(p).resolves.toBe(true);
  });

  it('gives up after the bound (default ~30 s) and says so', async () => {
    expect(READ_WAIT_BEFORE_BOOK_MS).toBe(30_000);
    let done = false;
    const p = waitForReads(() => true).then((v) => { done = true; return v; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(p).resolves.toBe(false);
  });
});

describe('snapNamelessByCode (multi-pallet-complete, defence in depth)', () => {
  const box = (barcode: string, over: Record<string, unknown> = {}) => ({
    barcode, sku: barcode.slice(0, 13), item_name: '', item_name_hebrew: '', weight: 0, expiry: '', scanned_at: '', ...over,
  });
  const named = (n: number) => box(`7290002195832${String(10000 + n).padStart(6, '0')}130622102027`, {
    item_name: CHICKEN.item_name_english, item_name_hebrew: CHICKEN.item_name_hebrew, weight: 12,
  });

  it('S03: an empty-name 31-digit row whose GTIN is an invoice item_code groups into that line', () => {
    const boxes = [named(1), named(2), box(C13)];
    const { boxes: out, snapped } = snapNamelessByCode(boxes, INVOICE);
    expect(snapped).toEqual([C13]);
    const groups = groupBoxesByName(out);
    expect(groups.size).toBe(1);
    const [only] = groups.values();
    expect(only.map((b) => b.barcode)).toContain(C13);
    // Before the snap it was a group of its own, which SCN-11 dropped.
    expect(groupBoxesByName(boxes).size).toBe(2);
  });

  it('touches nothing else: named rows pass through as the same objects', () => {
    const boxes = [named(1), box(C13)];
    const { boxes: out } = snapNamelessByCode(boxes, INVOICE);
    expect(out[0]).toBe(boxes[0]);
    expect(out[1]).toMatchObject({ barcode: C13, weight: 0, item_name_hebrew: CHICKEN.item_name_hebrew });
  });

  it('a true ghost (no name, no weight, no matching code) stays nameless and SCN-11 still drops it', () => {
    const ghost = box('7290099999999012570130622102027');
    const { boxes: out, snapped } = snapNamelessByCode([named(1), ghost], INVOICE);
    expect(snapped).toEqual([]);
    const groups = Array.from(groupBoxesByName(out).entries());
    expect(groups).toHaveLength(2);
    const ghostGroup = groups.find(([k]) => k.startsWith('unknown:'))!;
    expect(isEmptySummaryLine({ item_code: null, item_name: '', item_name_hebrew: '' }, ghostGroup[1])).toBe(true);
  });

  it('never snaps by a short supplier code, nor when two lines claim the carton', () => {
    expect(snapNamelessByCode([box(C13)], [{ ...CHICKEN, item_code: '90500010' }]).snapped).toEqual([]);
    expect(snapNamelessByCode([box(C13)], [CHICKEN, { ...SALMON, item_code: '729000219583' }]).snapped).toEqual([]);
    expect(snapNamelessByCode([box(C13)], undefined).snapped).toEqual([]);
  });
});
