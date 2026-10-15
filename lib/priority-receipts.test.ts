import { describe, expect, it } from 'vitest';
import {
  countByState,
  deriveReceiptState,
  errorClass,
  filterReceipts,
  formatReceiptTime,
  needsAttention,
  normalizeCategory,
  priorityErrorText,
  type OutboxInput,
  type ReceiptRow,
} from './priority-receipts';

const ob = (over: Partial<OutboxInput> = {}): OutboxInput => ({
  id: 1,
  status: 'queued',
  status_code: null,
  response_body: null,
  response_error: null,
  not_ready_reason: null,
  target: 'make',
  ...over,
});

// real replies from priority_push_outbox (14-15/10)
const SUPPLIER_400 = JSON.stringify({
  ok: false,
  error: "Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס' ספק ",
  stage: 'createHeader',
  form: 'DOCUMENTS_P',
});
const UNIT_DEEP = JSON.stringify({
  ok: false,
  stage: 'deepInsert',
  error: "[400] שורה 10- ליחידה יח' ציין רק ערך שלם (שדה 'כמות מפעל')",
});
const ITEM_ROLLBACK = JSON.stringify({ ok: false, stage: 'rollbackFailed', error: "[400] שורה 2- - חסר מק'ט " });

describe('deriveReceiptState', () => {
  it('a Priority GR settles it, with its status word', () => {
    const s = deriveReceiptState({
      delivery_status: 'Complete',
      outbox: ob({ status: 'delivered' }),
      gr: { docno: 'GR26000088', statdes: 'טיוטא' },
    });
    expect(s).toMatchObject({ state: 'done', gr_docno: 'GR26000088', gr_status: 'טיוטא' });
  });

  it('delivered without a GR row takes the number from the hand confirmation text', () => {
    const s = deriveReceiptState({
      delivery_status: 'Complete',
      outbox: ob({ status: 'delivered', not_ready_reason: 'confirmed by hand: Priority draft GR26000091' }),
      gr: null,
    });
    expect(s).toMatchObject({ state: 'done', gr_docno: 'GR26000091' });
  });

  it('already_in_priority is done with the GR from the reason', () => {
    const s = deriveReceiptState({
      delivery_status: 'Complete',
      outbox: ob({
        status: 'already_in_priority',
        response_error: 'not sent: Priority already has GR GR26000035 (origin priority_push, טיוטא)',
      }),
      gr: null,
    });
    expect(s).toMatchObject({ state: 'done', gr_docno: 'GR26000035', reason: 'already_in_priority' });
  });

  it('a supplier refusal at the header is refused, with Priority text trimmed', () => {
    const s = deriveReceiptState({
      delivery_status: 'Complete',
      outbox: ob({ status: 'failed', status_code: 400, response_body: SUPPLIER_400 }),
      gr: null,
    });
    expect(s.state).toBe('refused');
    expect(s.reason).toBe('supplier_missing');
    expect(s.priority_error).toBe("Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס' ספק");
  });

  it('a deepInsert / rollbackFailed refusal is partial (the header exists)', () => {
    expect(
      deriveReceiptState({
        delivery_status: 'Complete',
        outbox: ob({ status: 'failed', status_code: 400, response_body: UNIT_DEEP }),
        gr: null,
      }),
    ).toMatchObject({ state: 'partial', reason: 'unit_whole', partial_docno: null });
    expect(
      deriveReceiptState({
        delivery_status: 'Complete',
        outbox: ob({ status: 'failed', status_code: 400, response_body: ITEM_ROLLBACK }),
        gr: null,
      }),
    ).toMatchObject({ state: 'partial', reason: 'item_missing' });
  });

  it('partial_docno from the column, or from Make reply, names the draft', () => {
    expect(
      deriveReceiptState({
        delivery_status: 'Complete',
        outbox: ob({ status: 'failed', status_code: 400, response_body: SUPPLIER_400, partial_docno: 'GR26000091' }),
        gr: null,
      }),
    ).toMatchObject({ state: 'partial', partial_docno: 'GR26000091' });
    const body = JSON.stringify({ ok: false, stage: 'deepInsert', error: 'x', partial_docno: 'GR26000092' });
    expect(
      deriveReceiptState({ delivery_status: 'Complete', outbox: ob({ status: 'failed', response_body: body }), gr: null }),
    ).toMatchObject({ state: 'partial', partial_docno: 'GR26000092' });
  });

  it('expired without a send is refused as expired', () => {
    expect(
      deriveReceiptState({ delivery_status: 'Complete', outbox: ob({ status: 'expired' }), gr: null }),
    ).toMatchObject({ state: 'refused', reason: 'expired' });
  });

  it('unconfirmed, sent and queued', () => {
    expect(
      deriveReceiptState({
        delivery_status: 'Complete',
        outbox: ob({ status: 'unconfirmed', status_code: 200, response_body: 'Accepted' }),
        gr: null,
      }),
    ).toMatchObject({ state: 'unconfirmed', reason: 'make_no_ok' });
    expect(deriveReceiptState({ delivery_status: 'Complete', outbox: ob({ status: 'sent' }), gr: null }).state).toBe('waiting');
    expect(deriveReceiptState({ delivery_status: 'Complete', outbox: ob(), gr: null }).state).toBe('waiting');
  });

  it('skipped: a test (never shows the phone) or held by hand', () => {
    const test = deriveReceiptState({
      delivery_status: 'Has Discrepancy',
      outbox: ob({ status: 'skipped', response_error: 'skipped: Test user 972500000000' }),
      gr: null,
    });
    expect(test).toMatchObject({ state: 'not_sent', reason: 'test', is_test: true });
    expect(JSON.stringify(test)).not.toContain('9725');
    expect(
      deriveReceiptState({
        delivery_status: 'Complete',
        outbox: ob({ status: 'skipped', not_ready_reason: 'items_unmapped' }),
        gr: null,
      }),
    ).toMatchObject({ state: 'not_sent', reason: 'held', is_test: false });
  });

  it('no outbox: receiving while In Progress, else closed but never queued', () => {
    expect(deriveReceiptState({ delivery_status: 'In Progress', outbox: null, gr: null }).state).toBe('receiving');
    expect(deriveReceiptState({ delivery_status: 'Complete', outbox: null, gr: null })).toMatchObject({
      state: 'not_sent',
      reason: 'not_queued',
    });
    expect(
      deriveReceiptState({ delivery_status: 'Complete', outbox: null, gr: { docno: 'GR26000001', statdes: null } }).state,
    ).toBe('done');
  });

  it('a target=test outbox row is a test', () => {
    expect(deriveReceiptState({ delivery_status: 'Complete', outbox: ob({ target: 'test' }), gr: null }).is_test).toBe(true);
  });
});

describe('errorClass', () => {
  it('ports priority_push_error_class', () => {
    expect(errorClass('failed', 400, SUPPLIER_400, null)).toBe('supplier_missing');
    expect(errorClass('failed', 400, ITEM_ROLLBACK, null)).toBe('item_missing');
    expect(errorClass('failed', 400, '{"error":"הכנסה לקובץ נכשלה"}', null)).toBe('already_in_priority');
    expect(errorClass('failed', 502, null, 'Scenario failed to complete.')).toBe('make_crash');
    expect(errorClass('unconfirmed', 200, 'Accepted', null)).toBe('make_no_ok');
    expect(errorClass('unconfirmed', null, null, null)).toBe('no_reply');
    expect(errorClass('failed', 400, '{"error":"something"}', null)).toBe('other');
    expect(errorClass('delivered', 200, null, null)).toBeNull();
    expect(errorClass('failed', null, null, null)).toBeNull();
  });
});

describe('priorityErrorText', () => {
  it('drops the HTTP code prefix and caps the length', () => {
    expect(priorityErrorText(UNIT_DEEP)).toBe("שורה 10- ליחידה יח' ציין רק ערך שלם (שדה 'כמות מפעל')");
    expect(priorityErrorText(JSON.stringify({ error: 'א'.repeat(300) }))!.length).toBe(160);
    expect(priorityErrorText('Accepted')).toBeNull();
    expect(priorityErrorText(null)).toBeNull();
  });
});

describe('needsAttention / normalizeCategory', () => {
  it('problem states only, never a test', () => {
    expect(needsAttention('refused', false)).toBe(true);
    expect(needsAttention('partial', false)).toBe(true);
    expect(needsAttention('unconfirmed', false)).toBe(true);
    expect(needsAttention('not_sent', false)).toBe(true);
    expect(needsAttention('not_sent', true)).toBe(false);
    expect(needsAttention('done', false)).toBe(false);
    expect(needsAttention('waiting', false)).toBe(false);
  });

  it('normalizes category spellings', () => {
    expect(normalizeCategory('meat')).toBe('meat');
    expect(normalizeCategory('non_meat')).toBe('non_meat');
    expect(normalizeCategory('Non-Meat')).toBe('non_meat');
    expect(normalizeCategory('')).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
    expect(normalizeCategory('fish')).toBeNull();
  });
});

describe('filterReceipts / countByState / formatReceiptTime', () => {
  const row = (id: string, created_at: string | null, category: ReceiptRow['category'], state: ReceiptRow['state'] = 'done') =>
    ({ delivery_id: id, created_at, category, state }) as ReceiptRow;
  // 15/10 10:00 Israel (UTC+3)
  const NOW = new Date('2026-10-15T07:00:00Z');
  const rows = [
    row('a', '2026-10-15T05:00:00Z', 'meat'), // today 08:00 IL
    row('b', '2026-10-14T21:30:00Z', 'non_meat', 'refused'), // 15/10 00:30 IL = today
    row('c', '2026-10-14T20:30:00Z', 'meat', 'waiting'), // 14/10 23:30 IL = yesterday
    row('d', '2026-10-10T07:00:00Z', 'non_meat'),
    row('e', null, null),
  ];

  it('today = the Israel calendar day', () => {
    expect(filterReceipts(rows, 'today', 'all', NOW).map((r) => r.delivery_id)).toEqual(['a', 'b']);
  });

  it('3 days, 14 days and category', () => {
    expect(filterReceipts(rows, '3d', 'all', NOW).map((r) => r.delivery_id)).toEqual(['a', 'b', 'c']);
    expect(filterReceipts(rows, '14d', 'all', NOW).map((r) => r.delivery_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(filterReceipts(rows, '14d', 'non_meat', NOW).map((r) => r.delivery_id)).toEqual(['b', 'd']);
    expect(filterReceipts(rows, '3d', 'meat', NOW).map((r) => r.delivery_id)).toEqual(['a', 'c']);
  });

  it('counts per state', () => {
    expect(countByState(rows)).toMatchObject({ done: 3, refused: 1, waiting: 1, partial: 0 });
  });

  it('formats in Israel time, 24 h', () => {
    expect(formatReceiptTime('2026-10-14T21:30:00Z')).toBe('15/10 00:30');
    expect(formatReceiptTime(null)).toBe('—');
    expect(formatReceiptTime('nope')).toBe('—');
  });
});
