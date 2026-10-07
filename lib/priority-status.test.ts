import { describe, it, expect } from 'vitest';
import {
  derivePriorityStatus,
  summarizeExplain,
  summarizePushConfig,
  isFinalPriorityState,
  shouldStopPolling,
  nextPollDelay,
  AWAIT_CONFIRM_MS,
  FAST_POLL_MS,
  SLOW_POLL_MS,
  type PriorityStatusInput,
  type PriorityReceiptRow,
} from './priority-status';
import { en, type TranslationKey } from './i18n/en';
import { he } from './i18n/he';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** A Prod close with the push switched on, on the LIVE schema (no new columns). */
function input(over: Partial<PriorityStatusInput> = {}): PriorityStatusInput {
  return {
    deliveryStatus: 'Complete',
    testUser: false,
    config: { on: true },
    outbox: null,
    receipts: [],
    hasPoLink: true,
    now: NOW,
    ...over,
  };
}

/** A live-schema outbox row: none of the migration's columns exist. */
function liveRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, delivery_id: 'd1', document_number: 'INV1', delivery_status: 'Complete',
    category: 'meat', status: 'queued', attempts: 0, request_id: null, status_code: null,
    response_error: null, queued_at: minutesAgo(1), sent_at: null, responded_at: null,
    ...over,
  };
}

const gr = (over: Partial<PriorityReceiptRow> = {}): PriorityReceiptRow => ({
  docno: 'GR26000040', origin: 'priority_push', statdes: 'טיוטא', synced_at: minutesAgo(2), ...over, // English: statdes 'טיוטא' = draft
});

describe('summarizePushConfig', () => {
  it('is off with no row', () => {
    expect(summarizePushConfig(null)).toEqual({ on: false });
  });

  it('is off today: url NULL, enabled false (live schema, no new columns)', () => {
    const s = summarizePushConfig({ id: 1, url: null, enabled: false, secret_name: 'x', max_attempts: 3 });
    expect(s).toEqual({ on: false });
    expect('enabledSince' in s).toBe(false);
  });

  it('needs BOTH enabled and a URL', () => {
    expect(summarizePushConfig({ url: 'https://hook.example/x', enabled: false }).on).toBe(false);
    expect(summarizePushConfig({ url: '  ', enabled: true }).on).toBe(false);
    expect(summarizePushConfig({ url: 'https://hook.example/x', enabled: true }).on).toBe(true);
  });

  it('never carries the webhook URL', () => {
    const s = summarizePushConfig({ url: 'https://hook.example/secret-path', enabled: true });
    expect(JSON.stringify(s)).not.toContain('hook.example');
  });

  it('reads the migration columns when they exist, keeping null distinct from absent', () => {
    const s = summarizePushConfig({
      url: null, enabled: false, enabled_since: null, categories: ['meat'],
      category_since: {}, po_grace_minutes: 5,
    });
    expect(s).toEqual({ on: false, enabledSince: null, categories: ['meat'], categorySince: {}, poGraceMinutes: 5 });
  });
});

describe('derivePriorityStatus — precedence', () => {
  it('a Priority receipt wins over everything, even a failed outbox row', () => {
    const r = derivePriorityStatus(input({ outbox: liveRow({ status: 'failed' }), receipts: [gr()] }));
    expect(r).toEqual({ state: 'received', docno: 'GR26000040' });
  });

  it('a receipt wins even while the push is switched off', () => {
    const r = derivePriorityStatus(input({ config: { on: false }, receipts: [gr({ origin: 'priority' })] }));
    expect(r.state).toBe('received');
  });

  it('a confirmed (final) receipt says so', () => {
    expect(derivePriorityStatus(input({ receipts: [gr({ statdes: 'סופית' })] }))) // English: statdes 'סופית' = final
      .toEqual({ state: 'received', docno: 'GR26000040', final: true });
  });

  it('a cancelled receipt is not reported as received', () => {
    expect(derivePriorityStatus(input({ receipts: [gr({ statdes: 'מבוטלת' })] }))) // English: statdes 'מבוטלת' = cancelled
      .toEqual({ state: 'cancelled', docno: 'GR26000040' });
  });

  it('the newest Priority receipt is the one shown', () => {
    const r = derivePriorityStatus(input({
      receipts: [gr({ docno: 'OLD', synced_at: minutesAgo(60) }), gr({ docno: 'NEW', synced_at: minutesAgo(1) })],
    }));
    expect(r.docno).toBe('NEW');
  });

  it('a local warehouse_bot draft is not "in Priority"', () => {
    const r = derivePriorityStatus(input({
      outbox: liveRow({ status: 'queued' }),
      receipts: [gr({ origin: 'warehouse_bot', docno: 'LOCAL1' })],
    }));
    expect(r.state).toBe('held');
  });

  it('already_in_priority with no receipt row found → already', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'already_in_priority' }) })).state).toBe('already');
  });

  it('skipped for a Test user → test (even with the push off)', () => {
    const r = derivePriorityStatus(input({
      config: { on: false },
      outbox: liveRow({ status: 'skipped', response_error: 'skipped: Test user 972528331573' }),
    }));
    expect(r.state).toBe('test');
  });

  it('skipped for another reason (closed before autofire) → held, not test', () => {
    const r = derivePriorityStatus(input({
      outbox: liveRow({ status: 'skipped', response_error: 'skipped: closed before autofire (marker …)' }),
    }));
    expect(r.state).toBe('held');
  });

  it('failed → failed, expired → expired', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'failed' }) })).state).toBe('failed');
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'expired' }) })).state).toBe('expired');
  });

  it('unconfirmed (Make answered "Accepted" / timed out / 5xx) → unconfirmed, not unknown', () => {
    const row = liveRow({
      status: 'unconfirmed', sent_at: minutesAgo(3), status_code: 200, response_body: 'Accepted',
    });
    expect(derivePriorityStatus(input({ outbox: row })).state).toBe('unconfirmed');
    // It was sent: switching the push off or the delivery moving on does not hide that.
    expect(derivePriorityStatus(input({ outbox: row, config: { on: false } })).state).toBe('unconfirmed');
    expect(derivePriorityStatus(input({ outbox: row, deliveryStatus: 'In Progress' })).state).toBe('unconfirmed');
  });

  it('unconfirmed, then the scenario\'s write-back lands → received', () => {
    const row = liveRow({ status: 'unconfirmed', sent_at: minutesAgo(20) });
    expect(derivePriorityStatus(input({ outbox: row, receipts: [gr()] })))
      .toEqual({ state: 'received', docno: 'GR26000040' });
  });

  it('waiting: unmapped items carry their codes', () => {
    const r = derivePriorityStatus(input({
      outbox: liveRow({ status: 'waiting', not_ready_reason: 'items_unmapped', unmapped_codes: ['819987', '880012'] }),
    }));
    expect(r).toEqual({ state: 'waiting', reason: 'items', codes: ['819987', '880012'] });
  });

  it('waiting: supplier / nothing received / anything else, in plain reasons', () => {
    const w = (reason: unknown) =>
      derivePriorityStatus(input({ outbox: liveRow({ status: 'waiting', not_ready_reason: reason }) }));
    expect(w('supplier_unmatched')).toEqual({ state: 'waiting', reason: 'supplier' });
    expect(w('nothing_received')).toEqual({ state: 'waiting', reason: 'nothing' });
    expect(w('error: function wb_gr_priority_body(uuid) is not unique')).toEqual({ state: 'waiting', reason: 'other' });
    expect(w(undefined)).toEqual({ state: 'waiting', reason: 'other' });
  });

  it('waiting: items with no codes listed drops the codes field', () => {
    const r = derivePriorityStatus(input({
      outbox: liveRow({ status: 'waiting', not_ready_reason: 'items_unmapped', unmapped_codes: null }),
    }));
    expect(r).toEqual({ state: 'waiting', reason: 'items' });
  });

  it('no outbox row and a Test user → test (the live enqueue never writes one)', () => {
    expect(derivePriorityStatus(input({ testUser: true, config: { on: false } })).state).toBe('test');
  });

  it('push switched off → off, on today\'s schema with no outbox row', () => {
    expect(derivePriorityStatus(input({ config: { on: false } })).state).toBe('off');
    expect(derivePriorityStatus(input({ config: { on: false }, deliveryStatus: 'In Progress' })).state).toBe('off');
  });

  it('off beats a queued row', () => {
    expect(derivePriorityStatus(input({ config: { on: false }, outbox: liveRow() })).state).toBe('off');
  });

  it('push on, delivery still In Progress → closing', () => {
    expect(derivePriorityStatus(input({ deliveryStatus: 'In Progress' })).state).toBe('closing');
  });

  it('push on, no delivery row → unknown', () => {
    expect(derivePriorityStatus(input({ deliveryStatus: null })).state).toBe('unknown');
  });

  it('push on, closed, but no outbox row (the enqueue did not run) → unknown', () => {
    expect(derivePriorityStatus(input({ outbox: null })).state).toBe('unknown');
  });

  it('an outbox status this code does not know → unknown', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'teleported' }) })).state).toBe('unknown');
  });
});

describe('derivePriorityStatus — sending', () => {
  it('queued on the live schema (no hold columns) → sending', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow(), hasPoLink: false })).state).toBe('sending');
  });

  it('sent → sending', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'sent', sent_at: minutesAgo(1) }) })).state)
      .toBe('sending');
  });

  it('delivered recently → sending; older than 5 minutes with no receipt → awaiting', () => {
    const fresh = liveRow({ status: 'delivered', sent_at: minutesAgo(2) });
    const old = liveRow({ status: 'delivered', sent_at: new Date(NOW.getTime() - AWAIT_CONFIRM_MS).toISOString() });
    expect(derivePriorityStatus(input({ outbox: fresh })).state).toBe('sending');
    expect(derivePriorityStatus(input({ outbox: old })).state).toBe('awaiting');
  });

  it('delivered without sent_at falls back to responded_at', () => {
    const r = liveRow({ status: 'delivered', sent_at: undefined, responded_at: minutesAgo(30) });
    expect(derivePriorityStatus(input({ outbox: r })).state).toBe('awaiting');
  });
});

describe('derivePriorityStatus — holds (migration schema)', () => {
  const on = (over: Record<string, unknown> = {}) => ({
    on: true,
    enabledSince: minutesAgo(60),
    categories: ['meat'],
    categorySince: { meat: minutesAgo(60) },
    poGraceMinutes: 5,
    ...over,
  });
  const row = (over: Record<string, unknown> = {}) =>
    liveRow({ released_at: null, not_ready_reason: null, unmapped_codes: null, next_check_at: null, ...over });

  it('queued after the switch-on, PO answered → sending', () => {
    expect(derivePriorityStatus(input({ config: on(), outbox: row() })).state).toBe('sending');
  });

  it('queued before the push was enabled → held', () => {
    expect(derivePriorityStatus(input({ config: on({ enabledSince: minutesAgo(0.5) }), outbox: row() })).state)
      .toBe('held');
  });

  it('on with enabled_since NULL (enabled before the migration) → held', () => {
    expect(derivePriorityStatus(input({ config: on({ enabledSince: null }), outbox: row() })).state).toBe('held');
  });

  it('released by hand → not held', () => {
    const r = row({ queued_at: minutesAgo(120), released_at: minutesAgo(1) });
    expect(derivePriorityStatus(input({ config: on(), outbox: r })).state).toBe('sending');
  });

  it('category not switched on (non_meat) → held', () => {
    expect(derivePriorityStatus(input({ config: on(), outbox: row({ category: 'non_meat' }) })).state).toBe('held');
  });

  it('queued before its category was switched on → held', () => {
    const cfg = on({ categories: ['meat', 'non_meat'], categorySince: { meat: minutesAgo(60), non_meat: minutesAgo(0.5) } });
    expect(derivePriorityStatus(input({ config: cfg, outbox: row({ category: 'non_meat' }) })).state).toBe('held');
  });

  it('an unknown category is not guessed into a hold', () => {
    expect(derivePriorityStatus(input({ config: on(), outbox: row({ category: null }) })).state).toBe('sending');
  });

  it('no PO answer yet, inside the grace → waitingPo; after it → sending', () => {
    expect(derivePriorityStatus(input({ config: on(), outbox: row({ queued_at: minutesAgo(2) }), hasPoLink: false })).state)
      .toBe('waitingPo');
    expect(derivePriorityStatus(input({ config: on(), outbox: row({ queued_at: minutesAgo(6) }), hasPoLink: false })).state)
      .toBe('sending');
  });

  it('PO link unknown (read failed) → no waitingPo claim', () => {
    expect(derivePriorityStatus(input({ config: on(), outbox: row({ queued_at: minutesAgo(1) }), hasPoLink: null })).state)
      .toBe('sending');
  });
});

describe('summarizeExplain', () => {
  it('keeps only the decision; lines, supplier and unit risk stay on the server', () => {
    const r = summarizeExplain({
      decision: 'hold_same_invoice', hold_reason: 'same note already in Priority', ready: true,
      supplier_resolved: true, supplier_supname: 'S100', lines: [{ code: '14104' }], unit_risk_lines: [],
      unmapped_codes: [], not_ready_reason: null, is_test: false,
    });
    expect(r).toEqual({ decision: 'hold_same_invoice' });
    // Newer explain keys: lines_error (null normally) and unit_risk_lines
    // (null = unknown) are never read, so a null cannot break the card.
    expect(summarizeExplain({ decision: 'send', lines_error: null, unit_risk_lines: null })).toEqual({ decision: 'send' });
    expect(summarizeExplain({ decision: 'send', lines_error: 'boom', unit_risk_lines: null })).toEqual({ decision: 'send' });
  });

  it('anything without a decision → null (not read)', () => {
    expect(summarizeExplain(null)).toBeNull();
    expect(summarizeExplain([])).toBeNull();
    expect(summarizeExplain('send')).toBeNull();
    expect(summarizeExplain({ decision: '' })).toBeNull();
    expect(summarizeExplain({ ready: true })).toBeNull();
  });
});

describe('derivePriorityStatus — priority_push_explain (queued rows)', () => {
  const on = { on: true, enabledSince: minutesAgo(60), categories: ['meat'], categorySince: { meat: minutesAgo(60) }, poGraceMinutes: 5 };
  const row = (over: Record<string, unknown> = {}) =>
    liveRow({ released_at: null, not_ready_reason: null, unmapped_codes: null, next_check_at: null, alerted_at: null, alert_kind: null, ...over });
  const withDecision = (decision: string, over: Partial<PriorityStatusInput> = {}) =>
    derivePriorityStatus(input({ config: on, outbox: row(), explain: { decision }, ...over }));

  it('maps every decision the database can give', () => {
    expect(withDecision('send').state).toBe('sending');
    expect(withDecision('send_unready').state).toBe('sending');
    expect(withDecision('wait_po').state).toBe('waitingPo');
    for (const d of ['hold_same_invoice', 'hold_category', 'hold_pre_enable', 'hold_pre_category', 'hold_local_draft']) {
      expect(withDecision(d)).toEqual({ state: 'held' });
    }
    expect(withDecision('hold_not_closed').state).toBe('closing');
    expect(withDecision('already_in_priority').state).toBe('already');
    expect(withDecision('skipped_test').state).toBe('test');
    expect(withDecision('disabled').state).toBe('off');
  });

  it('the database decides, not the columns: a same-note hold the row cannot show', () => {
    // Nothing in this row or the config holds it; only explain knows that
    // another delivery of the same note is already in Priority.
    expect(withDecision('hold_same_invoice').state).toBe('held');
  });

  it('the database decides, not the columns: a release the columns would miss', () => {
    // Queued before enabled_since → the column check would say held; explain says send.
    const early = row({ queued_at: minutesAgo(120) });
    expect(derivePriorityStatus(input({ config: on, outbox: early, explain: { decision: 'send' } })).state).toBe('sending');
  });

  it('held after the office was alerted about it → office: true', () => {
    const alerted = row({ alerted_at: minutesAgo(1), alert_kind: 'held' });
    expect(derivePriorityStatus(input({ config: on, outbox: alerted, explain: { decision: 'hold_same_invoice' } })))
      .toEqual({ state: 'held', office: true });
  });

  it('a decision this code does not know falls back to the column holds', () => {
    expect(withDecision('not_ready').state).toBe('sending');
    expect(withDecision('not_ready', { outbox: row({ category: 'non_meat' }) }).state).toBe('held');
  });

  it('explain not read (null) → column holds only; a same-note hold is not claimed', () => {
    expect(derivePriorityStatus(input({ config: on, outbox: row(), explain: null })).state).toBe('sending');
    expect(derivePriorityStatus(input({ config: on, outbox: row({ category: 'non_meat' }), explain: null })).state).toBe('held');
  });

  it('explain only speaks for queued rows', () => {
    const sent = row({ status: 'sent', sent_at: minutesAgo(1) });
    expect(derivePriorityStatus(input({ config: on, outbox: sent, explain: { decision: 'hold_same_invoice' } })).state)
      .toBe('sending');
  });

  it('the push switched off still answers off before any decision', () => {
    expect(withDecision('send', { config: { on: false } }).state).toBe('off');
  });
});

describe('derivePriorityStatus — the office alert on record', () => {
  const alerted = (kind: string, over: Record<string, unknown> = {}) =>
    liveRow({ alerted_at: minutesAgo(1), alert_kind: kind, sent_at: minutesAgo(8), ...over });

  it('failed: office only once the failed alert is stamped', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'failed' }) }))).toEqual({ state: 'failed' });
    expect(derivePriorityStatus(input({ outbox: alerted('failed', { status: 'failed' }) })))
      .toEqual({ state: 'failed', office: true });
  });

  it('an alert of another kind, or a kind without alerted_at (cleared for a retry), is not the office knowing', () => {
    expect(derivePriorityStatus(input({ outbox: alerted('unconfirmed', { status: 'failed' }) })))
      .toEqual({ state: 'failed' });
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'failed', alerted_at: null, alert_kind: 'failed' }) })))
      .toEqual({ state: 'failed' });
  });

  it('unconfirmed: soft line, office once alerted; noWriteback once the watch alerted so', () => {
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'unconfirmed' }) }))).toEqual({ state: 'unconfirmed' });
    expect(derivePriorityStatus(input({ outbox: alerted('unconfirmed', { status: 'unconfirmed' }) })))
      .toEqual({ state: 'unconfirmed', office: true });
    expect(derivePriorityStatus(input({ outbox: alerted('no_writeback', { status: 'unconfirmed' }) })))
      .toEqual({ state: 'noWriteback', office: true });
  });

  it('sent with a no_writeback alert → noWriteback; without one → sending', () => {
    expect(derivePriorityStatus(input({ outbox: alerted('no_writeback', { status: 'sent' }) })))
      .toEqual({ state: 'noWriteback', office: true });
    expect(derivePriorityStatus(input({ outbox: liveRow({ status: 'sent', sent_at: minutesAgo(8) }) })).state)
      .toBe('sending');
  });

  it('expired: office once alerted', () => {
    expect(derivePriorityStatus(input({ outbox: alerted('expired', { status: 'expired' }) })))
      .toEqual({ state: 'expired', office: true });
  });

  it('a Priority receipt still beats any alert', () => {
    expect(derivePriorityStatus(input({ outbox: alerted('no_writeback', { status: 'unconfirmed' }), receipts: [gr()] })))
      .toEqual({ state: 'received', docno: 'GR26000040' });
  });
});

describe('derivePriorityStatus — a delivered row that names its draft', () => {
  it("Make's own ok:true reply names the draft before the write-back lands", () => {
    const row = liveRow({
      status: 'delivered', sent_at: minutesAgo(1), status_code: 200,
      response_body: '{"ok":true,"reason":"created_draft","docno":"GR26000048","lineCount":3,"statdes":"טיוטא"}', // English: statdes "טיוטא" = draft
    });
    expect(derivePriorityStatus(input({ outbox: row }))).toEqual({ state: 'received', docno: 'GR26000048' });
  });

  it("the fake Make's TEST- draft shows the same way (the Test-user run)", () => {
    const row = liveRow({ status: 'delivered', target: 'test', response_body: '{"ok":true,"reason":"created_draft","docno":"TEST-07dfda25"}' });
    expect(derivePriorityStatus(input({ outbox: row }))).toEqual({ state: 'received', docno: 'TEST-07dfda25' });
  });

  it('the office marked it found by hand → received with that number', () => {
    const row = liveRow({ status: 'delivered', not_ready_reason: 'confirmed by hand: Priority draft GR26000049 (admin:972528331573)' });
    expect(derivePriorityStatus(input({ outbox: row }))).toEqual({ state: 'received', docno: 'GR26000049' });
  });

  it('a reply without ok:true or without a docno claims nothing', () => {
    for (const body of ['Accepted', '{"ok":false,"docno":"GR1"}', '{"ok":true}', '[1]', null]) {
      const row = liveRow({ status: 'delivered', sent_at: minutesAgo(1), response_body: body });
      expect(derivePriorityStatus(input({ outbox: row })).state).toBe('sending');
    }
  });

  it('the client write-back still wins (it carries the final status)', () => {
    const row = liveRow({ status: 'delivered', response_body: '{"ok":true,"docno":"GR26000048"}' });
    expect(derivePriorityStatus(input({ outbox: row, receipts: [gr({ docno: 'GR26000048', statdes: 'סופית' })] }))) // English: statdes 'סופית' = final
      .toEqual({ state: 'received', docno: 'GR26000048', final: true });
  });
});

describe('polling', () => {
  it('stops on states that cannot change by themselves', () => {
    for (const s of ['received', 'cancelled', 'already', 'failed', 'expired', 'test', 'off'] as const) {
      expect(isFinalPriorityState(s)).toBe(true);
    }
    // unconfirmed keeps polling: a late reply or the write-back can still confirm it.
    for (const s of ['checking', 'closing', 'sending', 'awaiting', 'unconfirmed', 'noWriteback', 'waiting', 'waitingPo', 'held', 'unknown'] as const) {
      expect(isFinalPriorityState(s)).toBe(false);
    }
  });

  it('a failure or expiry keeps polling until the office alert is on record', () => {
    expect(shouldStopPolling({ state: 'failed' })).toBe(false);
    expect(shouldStopPolling({ state: 'failed', office: true })).toBe(true);
    expect(shouldStopPolling({ state: 'expired' })).toBe(false);
    expect(shouldStopPolling({ state: 'expired', office: true })).toBe(true);
    expect(shouldStopPolling({ state: 'received', docno: 'GR1' })).toBe(true);
    expect(shouldStopPolling({ state: 'test' })).toBe(true);
    // Not final: the write-back can still land.
    expect(shouldStopPolling({ state: 'noWriteback', office: true })).toBe(false);
    expect(shouldStopPolling({ state: 'unconfirmed', office: true })).toBe(false);
    expect(shouldStopPolling({ state: 'held', office: true })).toBe(false);
  });

  it('"awaiting" starts at the same 5 minutes as the no_writeback alert', () => {
    expect(AWAIT_CONFIRM_MS).toBe(5 * 60_000);
  });

  it('every 4 s for 3 minutes, then every 30 s', () => {
    expect(nextPollDelay(0)).toBe(FAST_POLL_MS);
    expect(nextPollDelay(179_000)).toBe(FAST_POLL_MS);
    expect(nextPollDelay(180_000)).toBe(SLOW_POLL_MS);
  });
});

describe('the worker\'s Priority lines are honest', () => {
  const keys = (Object.keys(en) as TranslationKey[]).filter((k) => k.startsWith('priority.'));
  /** The lines shown only once the office alert is stamped on the outbox row. */
  const OFFICE_ON_RECORD = new Set<TranslationKey>([
    'priority.failedOffice', 'priority.unconfirmedOffice', 'priority.noWriteback',
    'priority.heldOffice', 'priority.expiredOffice',
  ]);

  it('never asks the worker to tell the office, nor claims the office was notified', () => {
    for (const k of keys) {
      expect(en[k], k).not.toMatch(/tell the office|ask the office|office was notified/i);
      expect(he[k], k).not.toMatch(/נא לעדכן את המשרד|לבקש מהמשרד|המשרד עודכן/); // English: "please update the office" | "ask the office" | "the office was updated"
    }
  });

  it('mentions the office only in the lines shown once the alert is on record', () => {
    for (const k of keys) {
      if (!OFFICE_ON_RECORD.has(k)) expect(en[k], k).not.toMatch(/office/i);
      if (!OFFICE_ON_RECORD.has(k)) expect(he[k], k).not.toMatch(/המשרד/); // English: "the office"
    }
    for (const k of OFFICE_ON_RECORD) expect(en[k], k).toMatch(/office/i);
  });
});
