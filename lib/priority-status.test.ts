import { describe, it, expect } from 'vitest';
import {
  derivePriorityStatus,
  summarizePushConfig,
  isFinalPriorityState,
  nextPollDelay,
  AWAIT_CONFIRM_MS,
  FAST_POLL_MS,
  SLOW_POLL_MS,
  type PriorityStatusInput,
  type PriorityReceiptRow,
} from './priority-status';

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
  docno: 'GR26000040', origin: 'priority_push', statdes: 'טיוטא', synced_at: minutesAgo(2), ...over,
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
    expect(derivePriorityStatus(input({ receipts: [gr({ statdes: 'סופית' })] })))
      .toEqual({ state: 'received', docno: 'GR26000040', final: true });
  });

  it('a cancelled receipt is not reported as received', () => {
    expect(derivePriorityStatus(input({ receipts: [gr({ statdes: 'מבוטלת' })] })))
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

  it('delivered recently → sending; older than 15 minutes with no receipt → awaiting', () => {
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

describe('polling', () => {
  it('stops on states that cannot change by themselves', () => {
    for (const s of ['received', 'cancelled', 'already', 'failed', 'expired', 'test', 'off'] as const) {
      expect(isFinalPriorityState(s)).toBe(true);
    }
    // unconfirmed keeps polling: a late reply or the write-back can still confirm it.
    for (const s of ['checking', 'closing', 'sending', 'awaiting', 'unconfirmed', 'waiting', 'waitingPo', 'held', 'unknown'] as const) {
      expect(isFinalPriorityState(s)).toBe(false);
    }
  });

  it('every 4 s for 3 minutes, then every 30 s', () => {
    expect(nextPollDelay(0)).toBe(FAST_POLL_MS);
    expect(nextPollDelay(179_000)).toBe(FAST_POLL_MS);
    expect(nextPollDelay(180_000)).toBe(SLOW_POLL_MS);
  });
});
