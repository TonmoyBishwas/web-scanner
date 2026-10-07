/**
 * Priority push status — what the all-done card tells the worker about the
 * automatic goods-receipt push to Priority.
 *
 * There is no "send" step for the worker: when the last pallet's LPN is
 * booked the bot closes the delivery (deliveries.status → Complete / Has
 * Discrepancy), our trigger queues it in `priority_push_outbox`, and the
 * pg_cron dispatcher sends it to the client's Make scenario, which creates
 * the Priority draft and writes `priority_goods_receipts`. This module turns
 * those rows into one honest state; GET /api/priority-status reads them and
 * components/terminal/PriorityPushStatus.tsx shows it.
 *
 * Pure (no DB, no React) so it runs in vitest and in the browser bundle.
 *
 * Written against BOTH outbox schemas:
 *   - live today: statuses queued / sent / delivered / failed (+ skipped from
 *     the Test-user gate), no readiness columns, config = url + enabled only;
 *   - after docs/migrations/2026-10-01-priority-push-autofire.sql, whose full
 *     status set is queued, waiting, sent, delivered, failed, unconfirmed,
 *     skipped, already_in_priority, expired: it adds waiting / unconfirmed /
 *     already_in_priority / expired, the outbox columns not_ready_reason /
 *     unmapped_codes / released_at, and the config columns enabled_since /
 *     categories / category_since / po_grace_minutes. 'unconfirmed' = sent,
 *     but Make never confirmed it (its default "Accepted", a 5xx, a 120 s
 *     timeout, a lost reply): a draft MAY exist, nothing re-sends it, and it
 *     waits for a person to check in Priority.
 * A column that does not exist arrives as `undefined` (the route selects
 * `*`), and the check that needs it is skipped rather than guessed.
 *
 * A queued row's holds (hold_same_invoice — the bot forks deliveries for one
 * note — and the rest) come from the database's own
 * priority_push_explain(delivery_id), the function the bot reads too
 * (docs/migrations/2026-10-08-priority-push-02-outcomes-explain.sql). This
 * file no longer re-implements a hold that needs other rows. When explain
 * cannot be read (function missing, call failed) the column-only holds below
 * still apply and a same-note hold is simply not claimed.
 *
 * The office (TonmoyWP + Mevaser) is alerted by the database, not by this
 * card: our outcome trigger and priority_push_watch()
 * (2026-10-08-priority-push-02 / -03) post to the bot and stamp the outbox
 * row's alerted_at + alert_kind. The card says "the office has it" only when
 * that stamp is there — never as a promise.
 */

export type PriorityState =
  /** Before the first answer from the route. */
  | 'checking'
  /** The delivery is still In Progress; it is sent once the bot closes it. */
  | 'closing'
  /** Automatic sending is switched off (the client has not enabled it). */
  | 'off'
  /** Received by a Test user — never sent. */
  | 'test'
  /** Waiting for the purchase-order pick in WhatsApp (a few minutes' grace). */
  | 'waitingPo'
  /** Queued, but not sent by itself (category off, queued before the push was
   *  switched on, a local draft in flight, closed before autofire, or another
   *  delivery of the same supplier note is already in Priority). */
  | 'held'
  /** Priority cannot take it yet (unmapped items / supplier). Re-checked. */
  | 'waiting'
  | 'sending'
  /** Make accepted it a while ago; Priority has not confirmed yet. */
  | 'awaiting'
  /** Sent, but Make never confirmed it — a draft MAY exist. Not re-sent; the
   *  office checks in Priority. The scenario's write-back can still turn it
   *  into received, so this is not final. */
  | 'unconfirmed'
  /** Sent, Priority never wrote it back, and the office has been alerted
   *  (outbox alert_kind 'no_writeback', from priority_push_watch()). */
  | 'noWriteback'
  /** Priority has the goods receipt (`docno`). */
  | 'received'
  /** The Priority goods receipt was cancelled in Priority. */
  | 'cancelled'
  /** Priority already had it, so it was not sent again. */
  | 'already'
  | 'failed'
  /** Never became ready; the dispatcher gave up. */
  | 'expired'
  /** A status this code does not know, or rows that do not add up. */
  | 'unknown';

/** Why Priority cannot take it yet, in the worker's words. */
export type NotReadyReason = 'items' | 'supplier' | 'nothing' | 'other';

export interface PriorityStatus {
  state: PriorityState;
  /** Priority goods-receipt number (received / cancelled). */
  docno?: string;
  /** received: confirmed in Priority (סופית, "final") rather than a draft. */
  final?: boolean;
  /** waiting: why. */
  reason?: NotReadyReason;
  /** waiting with reason 'items': the item codes Priority cannot map. */
  codes?: string[];
  /** held / failed / unconfirmed / noWriteback / expired: the office has
   *  been alerted about this row (outbox alerted_at + a matching alert_kind). */
  office?: boolean;
}

/** The parts of `priority_push_config` the status needs — never the URL. */
export interface PushConfigSummary {
  /** enabled AND a webhook URL is set. */
  on: boolean;
  /** `undefined` = the column does not exist (schema before the migration). */
  enabledSince?: string | null;
  categories?: string[] | null;
  categorySince?: Record<string, unknown> | null;
  poGraceMinutes?: number | null;
}

/** One `priority_goods_receipts` row (a read of the client's table). */
export interface PriorityReceiptRow {
  docno: string | null;
  origin: string | null;
  statdes: string | null;
  synced_at: string | null;
}

/** The part of priority_push_explain(delivery_id) the card needs. */
export interface PriorityExplain {
  /** What priority_push_plan() would decide for the row: 'send',
   *  'send_unready', 'hold_same_invoice', 'wait_po', … */
  decision: string;
}

export interface PriorityStatusInput {
  /** deliveries.status; null = no delivery row (or no receipt on the session). */
  deliveryStatus: string | null;
  /** The receiver is a Test user (users.env = 'Test'): never sent. */
  testUser: boolean;
  config: PushConfigSummary;
  /** The `priority_push_outbox` row (`select *`), or null when there is none. */
  outbox: Record<string, unknown> | null;
  receipts: PriorityReceiptRow[];
  /** A delivery_po_links row exists; null = not known. */
  hasPoLink: boolean | null;
  /**
   * priority_push_explain for a queued row; null / absent = not read (the
   * row is not queued, the function is missing, or the call failed).
   */
  explain?: PriorityExplain | null;
  now: Date;
}

/** Statuses Priority's goods receipts carry (priority_goods_receipts.statdes). */
const STATDES_FINAL = 'סופית'; // "final"
const STATDES_CANCELLED = 'מבוטלת'; // "cancelled"

/** origin of the client's local pre-push row; every other origin is Priority's. */
const LOCAL_DRAFT_ORIGIN = 'warehouse_bot';

const CLOSED_STATUSES = new Set(['Complete', 'Has Discrepancy']);

/** After this long in 'delivered' with no Priority receipt, stop saying
 *  "sending" and say "sent — waiting for Priority to confirm". The same
 *  5 minutes as priority_push_config.no_writeback_minutes, after which the
 *  watch job alerts the office. */
export const AWAIT_CONFIRM_MS = 5 * 60_000;

/** priority_push_mark_found()'s note on a row the office found by hand. */
const MARKED_FOUND = /^confirmed by hand: Priority draft (\S+)/;

/** priority_push_explain decisions → the state the worker sees. A decision
 *  not listed here falls back to the column-only holds in queued(). */
const EXPLAIN_STATE: Readonly<Record<string, PriorityState>> = {
  send: 'sending',
  send_unready: 'sending',
  wait_po: 'waitingPo',
  hold_same_invoice: 'held',
  hold_category: 'held',
  hold_pre_enable: 'held',
  hold_pre_category: 'held',
  hold_local_draft: 'held',
  hold_not_closed: 'closing',
  already_in_priority: 'already',
  skipped_test: 'test',
  disabled: 'off',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function time(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reduce a `priority_push_config` row (`select *`) to what the status needs.
 * The webhook URL becomes a boolean here and goes no further.
 */
export function summarizePushConfig(row: Record<string, unknown> | null): PushConfigSummary {
  if (!row) return { on: false };
  const summary: PushConfigSummary = {
    on: row.enabled === true && str(row.url) !== null,
  };
  if ('enabled_since' in row) summary.enabledSince = str(row.enabled_since);
  if ('categories' in row) {
    summary.categories = Array.isArray(row.categories)
      ? row.categories.filter((c): c is string => typeof c === 'string')
      : null;
  }
  if ('category_since' in row) {
    const cs = row.category_since;
    summary.categorySince = cs && typeof cs === 'object' && !Array.isArray(cs)
      ? (cs as Record<string, unknown>)
      : null;
  }
  if ('po_grace_minutes' in row) {
    const n = Number(row.po_grace_minutes);
    summary.poGraceMinutes = row.po_grace_minutes != null && Number.isFinite(n) ? n : null;
  }
  return summary;
}

/**
 * Reduce priority_push_explain's jsonb to the decision. Lines, supplier and
 * unit-risk details are for the office and the bot; they stay on the server.
 */
export function summarizeExplain(raw: unknown): PriorityExplain | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const decision = str((raw as Record<string, unknown>).decision);
  return decision ? { decision } : null;
}

/** The newest receipt Priority itself holds (not the local pre-push draft). */
function priorityReceipt(receipts: PriorityReceiptRow[]): PriorityReceiptRow | null {
  let best: PriorityReceiptRow | null = null;
  for (const r of receipts) {
    if (!str(r.docno) || r.origin === LOCAL_DRAFT_ORIGIN) continue;
    if (!best || (time(r.synced_at) ?? 0) > (time(best.synced_at) ?? 0)) best = r;
  }
  return best;
}

/** The office was alerted about this row as one of `kinds` (alerted_at +
 *  alert_kind, stamped by our outcome trigger / priority_push_watch()). */
function alertedAs(outbox: Record<string, unknown>, ...kinds: string[]): boolean {
  const kind = str(outbox.alert_kind);
  return str(outbox.alerted_at) !== null && kind !== null && kinds.includes(kind);
}

/** The HTTP status Make answered with was a server error (500-599) — the
 *  scenario crashed. Only then does the bot message the office at
 *  'unconfirmed'; a bare 200 "Accepted" or a timeout is told to the office at
 *  the later 'no_writeback' (5 minutes). */
function makeCrashed(outbox: Record<string, unknown>): boolean {
  const code = Number(outbox.status_code);
  return Number.isInteger(code) && code >= 500 && code <= 599;
}

/** `state`, plus office: true when the office was alerted as `kinds`. */
function withOffice(state: PriorityState, outbox: Record<string, unknown>, ...kinds: string[]): PriorityStatus {
  return alertedAs(outbox, ...kinds) ? { state, office: true } : { state };
}

/**
 * The Priority draft a 'delivered' row already names, before (or without)
 * the client's write-back: the office's "Mark as found"
 * (priority_push_mark_found), or Make's own {"ok":true,"docno":…} reply.
 */
function deliveredDocno(outbox: Record<string, unknown>): string | null {
  const marked = MARKED_FOUND.exec(str(outbox.not_ready_reason) ?? '');
  if (marked) return marked[1];
  let body: unknown = outbox.response_body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null; // "Accepted" and other plain-text replies
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  return reply.ok === true ? str(reply.docno) : null;
}

function notReady(outbox: Record<string, unknown>): PriorityStatus {
  const raw = str(outbox.not_ready_reason);
  const reason: NotReadyReason =
    raw === 'items_unmapped' ? 'items'
    : raw === 'supplier_unmatched' ? 'supplier'
    : raw === 'nothing_received' ? 'nothing'
    : 'other';
  if (reason !== 'items') return { state: 'waiting', reason };
  const codes = Array.isArray(outbox.unmapped_codes)
    ? outbox.unmapped_codes.filter((c): c is string => typeof c === 'string' && c !== '')
    : [];
  return codes.length > 0 ? { state: 'waiting', reason, codes } : { state: 'waiting', reason };
}

/**
 * A 'queued' row is sent on the dispatcher's next run unless one of its
 * holds applies. The database says which (priority_push_explain); without
 * it, only the holds this row's own columns can show are checked, in
 * plan()'s order.
 */
function queued(input: PriorityStatusInput, outbox: Record<string, unknown>): PriorityStatus {
  const decided = input.explain ? EXPLAIN_STATE[input.explain.decision] : undefined;
  if (decided === 'held') return withOffice('held', outbox, 'held');
  if (decided) return { state: decided };

  const { config, now } = input;
  const queuedAt = time(outbox.queued_at);
  const releasedAt = time(outbox.released_at);

  // A local warehouse_bot draft: a push by hand may be in flight.
  if (input.receipts.some((r) => r.origin === LOCAL_DRAFT_ORIGIN)) return withOffice('held', outbox, 'held');

  // Queued while the push was off: never sent by itself.
  if (config.enabledSince !== undefined && releasedAt === null) {
    const since = time(config.enabledSince);
    if (since === null || queuedAt === null || queuedAt < since) return withOffice('held', outbox, 'held');
  }

  // Category not switched on (default: meat only), or switched on after this
  // row was queued. An unknown category is not guessed at.
  const category = str(outbox.category);
  if (category && Array.isArray(config.categories)) {
    if (!config.categories.includes(category)) return withOffice('held', outbox, 'held');
    if (config.categorySince && releasedAt === null) {
      const since = time(config.categorySince[category]);
      if (since === null || queuedAt === null || queuedAt < since) return withOffice('held', outbox, 'held');
    }
  }

  // A few minutes for the purchase-order pick before it is sent anyway.
  if (config.poGraceMinutes != null && input.hasPoLink === false && queuedAt !== null
      && now.getTime() - queuedAt < config.poGraceMinutes * 60_000) {
    return { state: 'waitingPo' };
  }

  return { state: 'sending' };
}

/**
 * The one state to show. First match wins:
 *   1. Priority has a receipt for it (beats any outbox status, even failed).
 *   2. Outbox states that stand whatever the config or delivery now say:
 *      already_in_priority, skipped (Test user, else held), failed,
 *      unconfirmed (noWriteback once the office was alerted so; office only
 *      after a Make crash, HTTP 5xx), expired,
 *      waiting, delivered naming its draft (Make's ok:true reply or the
 *      office's Mark as found), sent with a no_writeback alert.
 *   3. No outbox row and a Test user → test.
 *   4. Push switched off → off.
 *   5. No delivery row → unknown; still In Progress → closing.
 *   6. Closed with no outbox row (the enqueue did not run) → unknown.
 *   7. queued → priority_push_explain's decision, else the column holds;
 *      sent → sending; delivered → sending, or awaiting once older than
 *      5 minutes; anything else → unknown.
 */
export function derivePriorityStatus(input: PriorityStatusInput): PriorityStatus {
  const { outbox, config } = input;

  const gr = priorityReceipt(input.receipts);
  if (gr) {
    const docno = String(gr.docno);
    if (gr.statdes === STATDES_CANCELLED) return { state: 'cancelled', docno };
    return gr.statdes === STATDES_FINAL
      ? { state: 'received', docno, final: true }
      : { state: 'received', docno };
  }

  const status = outbox ? str(outbox.status) : null;
  if (outbox) {
    switch (status) {
      case 'already_in_priority':
        return { state: 'already' };
      case 'skipped':
        return input.testUser || /^skipped: Test user/i.test(str(outbox.response_error) ?? '')
          ? { state: 'test' }
          : { state: 'held' };
      case 'failed':
        return withOffice('failed', outbox, 'failed');
      case 'unconfirmed':
        if (alertedAs(outbox, 'no_writeback')) return { state: 'noWriteback', office: true };
        // The 'unconfirmed' stamp means "the office was told" only after a Make
        // crash (5xx); otherwise only the 'no_writeback' stamp above does.
        return makeCrashed(outbox) ? withOffice('unconfirmed', outbox, 'unconfirmed') : { state: 'unconfirmed' };
      case 'expired':
        return withOffice('expired', outbox, 'expired');
      case 'waiting':
        return notReady(outbox);
      case 'delivered': {
        const docno = deliveredDocno(outbox);
        if (docno) return { state: 'received', docno };
        break;
      }
      case 'sent':
        if (alertedAs(outbox, 'no_writeback')) return { state: 'noWriteback', office: true };
        break;
    }
  }

  if (!outbox && input.testUser) return { state: 'test' };
  if (!config.on) return { state: 'off' };
  if (input.deliveryStatus === null) return { state: 'unknown' };
  if (!CLOSED_STATUSES.has(input.deliveryStatus)) return { state: 'closing' };
  if (!outbox) return { state: 'unknown' };

  switch (status) {
    case 'queued':
      return queued(input, outbox);
    case 'sent':
      return { state: 'sending' };
    case 'delivered': {
      const at = time(outbox.sent_at) ?? time(outbox.responded_at) ?? time(outbox.queued_at);
      return at !== null && input.now.getTime() - at >= AWAIT_CONFIRM_MS
        ? { state: 'awaiting' }
        : { state: 'sending' };
    }
    default:
      return { state: 'unknown' };
  }
}

/** States that cannot change by themselves any more. */
const FINAL_STATES: ReadonlySet<PriorityState> = new Set<PriorityState>([
  'received', 'cancelled', 'already', 'failed', 'expired', 'test', 'off',
]);

export function isFinalPriorityState(state: PriorityState): boolean {
  return FINAL_STATES.has(state);
}

/**
 * Stop polling once nothing can change by itself — except that a failure or
 * an expiry keeps polling until the office alert is on record (the watch job
 * stamps it within a minute), so the card can then say "the office has it".
 */
export function shouldStopPolling(status: PriorityStatus): boolean {
  if (!isFinalPriorityState(status.state)) return false;
  if ((status.state === 'failed' || status.state === 'expired') && status.office !== true) return false;
  return true;
}

/** Poll every 4 s for the first 3 minutes after the card opens, then every 30 s. */
export const FAST_POLL_MS = 4_000;
export const SLOW_POLL_MS = 30_000;
export const FAST_POLL_WINDOW_MS = 3 * 60_000;

export function nextPollDelay(elapsedMs: number): number {
  return elapsedMs < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}
