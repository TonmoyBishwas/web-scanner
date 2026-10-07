import { describe, expect, it } from 'vitest';
import {
  canMarkFound,
  canSendAgain,
  emptyStateText,
  errorClassText,
  fixLineText,
  formatIsraelTime,
  groupFixLines,
  markFoundConfirmText,
  markFoundNeedsConfirm,
  markFoundRefusalText,
  parseDocno,
  parseOutboxId,
  problemInfo,
  receiverLabel,
  refusalText,
  MARK_FOUND_REFUSAL_TEXT,
  PROBLEM_INFO,
  REFUSAL_TEXT,
  type AttentionRow,
  type GapLine,
} from './priority-attention';

// English: supplier 'אגמי' = Agami (the bread supplier of outbox 45)
const row = (over: Partial<AttentionRow> = {}): AttentionRow => ({
  outbox_id: 45, delivery_id: 'd45', document_number: '1536030', supplier: 'אגמי', category: 'non_meat',
  problem: 'failed', reason_text: 'supplier not in Priority', status_code: 400, error_class: 'supplier_missing',
  sent_at: '2026-10-05T08:00:00Z', created_at: '2026-10-05T07:59:00Z', receiver_chat_id: 972528331573,
  ...over,
});

describe('which actions a row offers', () => {
  it('Send again only where priority_push_resend can accept it: outbox status failed / unconfirmed', () => {
    expect(canSendAgain(row({ problem: 'failed', outbox_status: 'failed' }))).toBe(true);
    expect(canSendAgain(row({ problem: 'unconfirmed', outbox_status: 'unconfirmed' }))).toBe(true);
    // an expired row is listed as problem 'failed'; resend refuses it
    expect(canSendAgain(row({ problem: 'failed', outbox_status: 'expired' }))).toBe(false);
    // no_writeback is a row still 'sent'; resend refuses it
    expect(canSendAgain(row({ problem: 'no_writeback', outbox_status: 'sent' }))).toBe(false);
    // Priority already has a GR for the delivery → Mark as found, not Send again
    expect(canSendAgain(row({ problem: 'failed', outbox_status: 'failed', gr_docno: 'GR26000040' }))).toBe(false);
    for (const problem of ['held', 'not_queued', 'bot_unreachable', 'orphan_class1', 'orphan_class2', 'orphan_class3']) {
      expect(canSendAgain(row({ problem }))).toBe(false);
    }
  });

  it('a row Priority refused as already_in_priority is a Mark as found, never a Send again', () => {
    const refused = row({ problem: 'failed', outbox_status: 'failed', error_class: 'already_in_priority' });
    expect(canSendAgain(refused)).toBe(false);
    expect(canMarkFound(refused)).toBe(true);
    // without the outbox_status column too
    expect(canSendAgain(row({ problem: 'failed', error_class: 'already_in_priority' }))).toBe(false);
    // any other refusal class still offers it
    for (const error_class of ['supplier_missing', 'item_missing', 'make_crash', 'make_no_ok', 'no_reply', 'other', null]) {
      expect(canSendAgain(row({ problem: 'failed', outbox_status: 'failed', error_class })), String(error_class)).toBe(true);
    }
  });

  it('without the outbox_status column, falls back to the problem (no_writeback never resendable)', () => {
    for (const problem of ['failed', 'unconfirmed']) expect(canSendAgain(row({ problem }))).toBe(true);
    expect(canSendAgain(row({ problem: 'no_writeback' }))).toBe(false);
  });

  it('Mark as found also for held and no_writeback rows, never for rows without an outbox id', () => {
    expect(canMarkFound(row({ problem: 'held' }))).toBe(true);
    expect(canMarkFound(row({ problem: 'no_writeback', outbox_status: 'sent' }))).toBe(true);
    expect(canMarkFound(row({ problem: 'not_queued', outbox_id: null }))).toBe(false);
    // bot_unreachable sits next to the row's own card and offers no button (outbox_status is null)
    expect(canMarkFound(row({ problem: 'bot_unreachable', outbox_status: null }))).toBe(false);
    expect(canSendAgain(row({ problem: 'bot_unreachable', outbox_status: null }))).toBe(false);
    expect(canMarkFound(row({ problem: 'failed', outbox_id: null }))).toBe(false);
    expect(canSendAgain(row({ problem: 'failed', outbox_id: null }))).toBe(false);
  });
});

describe('plain words', () => {
  it('every problem the view can list has a title and a check', () => {
    for (const p of ['failed', 'unconfirmed', 'no_writeback', 'held', 'not_queued', 'bot_unreachable', 'orphan_class1', 'orphan_class2', 'orphan_class3']) {
      expect(PROBLEM_INFO[p]?.title, p).toBeTruthy();
      expect(PROBLEM_INFO[p]?.check, p).toBeTruthy();
    }
  });

  it('the checks before a re-send name the note search in any status, including draft', () => {
    expect(problemInfo('unconfirmed').check).toMatch(/BOOKNUM.*any status, including draft/);
    expect(problemInfo('no_writeback').check).toMatch(/Make history/);
  });

  it('an unknown problem is shown as is', () => {
    expect(problemInfo('brand_new_problem')).toEqual({ title: 'brand_new_problem', check: 'Tell Tonmoy.' });
  });

  it('Hebrew Priority errors are glossed in English', () => {
    expect(errorClassText('supplier_missing')).toMatch(/missing supplier number/);
    expect(errorClassText('item_missing')).toMatch(/missing item code/);
    expect(errorClassText(null)).toBeNull();
    expect(errorClassText('new_class')).toBeNull();
  });

  it('every resend refusal code has its own sentence; an unknown one a safe default', () => {
    for (const code of [
      'not_resendable_status', 'already_in_priority', 'request_in_flight', 'checks_not_confirmed',
      'sibling_in_flight', 'known_reject_supplier', 'known_reject_items',
    ]) {
      expect(REFUSAL_TEXT[code], code).toBeTruthy();
      expect(refusalText(code)).toBe(REFUSAL_TEXT[code]);
    }
    expect(refusalText(null)).toMatch(/Not sent/);
    expect(refusalText('brand_new_code')).toMatch(/Not sent/);
  });

  it('the two known-reject sentences name both causes and the sync lag, verbatim', () => {
    expect(REFUSAL_TEXT.known_reject_items).toBe(
      "Priority or Make would refuse it again: items on it are still not linked to Priority items. Link the items in Priority first. Priority's lists are copied here periodically, so after linking, try again after the next sync; if it still appears, tell Tonmoy.",
    );
    expect(REFUSAL_TEXT.known_reject_supplier).toBe(
      "Priority would refuse it again: the supplier is still not set up there. Open the supplier in Priority first. Priority's lists are copied here periodically, so after opening it, try again after the next sync; if it still appears, tell Tonmoy.",
    );
  });

  it('class 3 says the goods were scanned and are not in Priority', () => {
    expect(PROBLEM_INFO.orphan_class3.check).toBe(
      'Real goods were scanned but the delivery was never closed, so they are not in Priority. The receiver should finish it — never delete it.',
    );
  });

  it('every mark-found refusal code has its own sentence; the default never says "sent"', () => {
    for (const code of ['docno_invalid', 'not_markable_status', 'request_in_flight']) {
      expect(MARK_FOUND_REFUSAL_TEXT[code], code).toBeTruthy();
      expect(markFoundRefusalText(code)).toBe(MARK_FOUND_REFUSAL_TEXT[code]);
    }
    expect(markFoundRefusalText(null)).toMatch(/Nothing was changed/);
    expect(markFoundRefusalText('brand_new_code')).not.toMatch(/sent/i);
  });

  it('the unconfirmed title does not say Make "never" confirmed (it also covers a 5xx and a timeout)', () => {
    expect(PROBLEM_INFO.unconfirmed.title).toBe('Sent, but Make did not confirm it');
  });
});

describe('the empty-list sentence', () => {
  it('when the lines-to-fix view was read, only the not-yet-listed receipts are said to be missing', () => {
    const text = emptyStateText(true);
    expect(text).toBe(
      'No receipt is stuck on its way to Priority right now. Receipts the bot could not close are not listed here yet — the WhatsApp message has the details.',
    );
    expect(text).not.toMatch(/Lines to fix/);
  });

  it('when the view was unreadable, keep the old sentence naming both gaps', () => {
    expect(emptyStateText(false)).toBe(
      'Nothing is listed right now. Lines to fix inside a Priority draft, and receipts the bot could not close, are not listed here yet — the WhatsApp message has the details.',
    );
  });
});

describe('input parsing', () => {
  it('outbox ids: positive whole numbers, as number or digits', () => {
    expect(parseOutboxId(45)).toBe(45);
    expect(parseOutboxId('45')).toBe(45);
    expect(parseOutboxId(' 45 ')).toBe(45);
    for (const bad of [0, -1, 4.5, '4.5', '', 'x', null, undefined, {}, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseOutboxId(bad), String(bad)).toBeNull();
    }
  });

  it('document numbers: trimmed and upper-cased, the pattern priority_push_mark_found accepts; anything else refused', () => {
    expect(parseDocno(' gr26000049 ')).toBe('GR26000049');
    expect(parseDocno('GR26000049')).toBe('GR26000049');
    expect(parseDocno('test-07dfda25')).toBe('TEST-07DFDA25');
    expect(parseDocno('gr26/0049')).toBe('GR26/0049');
    // English: 'גר260' = Hebrew letters typed by mistake
    for (const bad of ['', 'GR', 'GR 26000049', 'GR_26000049', "GR1'; drop", 'גר260', 'G'.repeat(41), null, 26000049]) {
      expect(parseDocno(bad), String(bad)).toBeNull();
    }
  });

  it('Mark as found asks twice only when the typed number differs from the GR Priority already shows', () => {
    const known = { gr_docno: 'GR26000040' };
    // same number, however typed: one press is enough
    expect(markFoundNeedsConfirm(known, 'GR26000040')).toBe(false);
    expect(markFoundNeedsConfirm(known, ' gr26000040 ')).toBe(false);
    // a different number: confirm first
    expect(markFoundNeedsConfirm(known, 'GR26000041')).toBe(true);
    expect(markFoundNeedsConfirm(known, ' gr26000041 ')).toBe(true);
    // no known GR: nothing to compare with
    expect(markFoundNeedsConfirm({ gr_docno: null }, 'GR26000041')).toBe(false);
    expect(markFoundNeedsConfirm({}, 'GR26000041')).toBe(false);
    expect(markFoundNeedsConfirm({ gr_docno: '  ' }, 'GR26000041')).toBe(false);
    // typed text that is not a document number is the Mark as found button's own refusal, not a typo prompt
    for (const bad of ['', 'GR 1', null, undefined, 26000041]) {
      expect(markFoundNeedsConfirm(known, bad), String(bad)).toBe(false);
    }
  });

  it('the first press shows what Priority says and what was typed, normalised', () => {
    expect(markFoundConfirmText({ gr_docno: 'GR26000040' }, ' gr26000041 ')).toBe(
      "Priority's copy here says GR26000040. You typed GR26000041. Press Mark as found again to confirm.",
    );
    expect(markFoundConfirmText({ gr_docno: 'GR26000040' }, 'gr26000040')).toBeNull();
    expect(markFoundConfirmText({ gr_docno: null }, 'GR26000041')).toBeNull();
  });

  it('the card never shows the receiver chat id (a phone number): the nickname, else … and its last 4 digits', () => {
    expect(receiverLabel({ receiver_name: 'Dana', receiver_chat_id: 972528331573 })).toBe('Dana');
    expect(receiverLabel({ receiver_name: '  Dana  ', receiver_chat_id: 972528331573 })).toBe('Dana');
    expect(receiverLabel({ receiver_name: null, receiver_chat_id: 972528331573 })).toBe('…1573');
    expect(receiverLabel({ receiver_name: '   ', receiver_chat_id: '972528331573' })).toBe('…1573');
    expect(receiverLabel({ receiver_chat_id: '+972 52-833-1573' })).toBe('…1573');
    expect(receiverLabel({ receiver_chat_id: 123 })).toBe('…123');
    expect(receiverLabel({ receiver_chat_id: null })).toBeNull();
    expect(receiverLabel({ receiver_name: null, receiver_chat_id: '' })).toBeNull();
    expect(receiverLabel({ receiver_chat_id: 'n/a' })).toBeNull();
    // whatever the row carries, the full number never comes back
    expect(receiverLabel({ receiver_chat_id: 972528331573 })).not.toContain('97252');
  });

  it('times are shown in Israel time', () => {
    expect(formatIsraelTime('2026-10-05T08:00:00Z')).toBe('05 Oct, 11:00');
    expect(formatIsraelTime(null)).toBe('—');
    expect(formatIsraelTime('not a date')).toBe('—');
  });
});

// English: Hebrew test data: לחם = "bread"; אגמי = Agami (supplier); סופקה בחוסר = "supplied short"
// (the legacy per-delivery reason, stored before Task 17).
describe('lines to check in Priority (delivery_gaps_v)', () => {
  const gap = (over: Partial<GapLine> = {}): GapLine => ({
    delivery_id: 'd1', document_number: '241954682', supplier: 'אגמי', code: '1079', name: 'לחם', // English: Agami, bread
    invoice_qty: 525, received_qty: 20, unit: 'units', gap_reason: null, gap_note: null, rest_expected: null,
    count_source: 'counted', gr_docno: null, ...over,
  });

  it('groups lines per delivery in the order given, each delivery\'s lines by code', () => {
    const out = groupFixLines([
      gap({ delivery_id: 'd2', document_number: '2606611', code: 'B' }),
      gap({ code: '1079', gr_docno: 'GR26000045' }),
      gap({ delivery_id: 'd2', document_number: '2606611', code: 'A' }),
      gap({ code: '1003' }),
    ]);
    expect(out.map((d) => d.delivery_id)).toEqual(['d2', 'd1']);
    expect(out[0].lines.map((l) => l.code)).toEqual(['A', 'B']);
    expect(out[1].lines.map((l) => l.code)).toEqual(['1003', '1079']);
    expect(out[1].gr_docno).toBe('GR26000045');
    expect(groupFixLines([])).toEqual([]);
  });

  it('a line without an item code sorts after the coded ones', () => {
    const out = groupFixLines([gap({ code: null }), gap({ code: '2000' }), gap({ code: '1000' })]);
    expect(out[0].lines.map((l) => l.code)).toEqual(['1000', '2000', null]);
  });

  it('one line in plain English: quantities, reason, the rest, not counted, unit risk, unlinked item', () => {
    expect(fixLineText(gap({ gap_reason: 'supplier_short', rest_expected: 'wont_come', gap_note: 'driver said' }))).toBe(
      "1079 לחם: invoice 525 → received 20 units · reason: the supplier sent less · note: driver said · the rest won't come", // English: 1079 bread: …
    );
    expect(fixLineText(gap({ count_source: 'invoice_assumed', received_qty: 525 }))).toMatch(
      /received 525 units · not counted \(booked as invoiced\)$/,
    );
    expect(fixLineText(gap({ unit_risk: 'unit_unknown', item_not_linked: true, unit: 'unknown' }))).toBe(
      '1079 לחם: invoice 525 → received 20 (no unit on the note) · unit risk: the note printed no unit · item not linked to a Priority item', // English: 1079 bread: …
    );
    expect(fixLineText(gap({ gap_reason: 'סופקה בחוסר' }))).toMatch(/reason: סופקה בחוסר$/); // English: "supplied short"
    expect(fixLineText(gap({ rest_expected: 'will_come', received_qty: '19.5000' }))).toMatch(
      /received 19\.5 units · the rest will come later$/,
    );
  });
});
