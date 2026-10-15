/**
 * The owner's receipts board (app/priority/receipts): every delivery of the
 * last 14 days and where it stands in Priority — one status per delivery,
 * worked out from our priority_push_outbox row and the Priority goods
 * receipt (priority_goods_receipts) linked to it.
 *
 * Pure (no DB, no React): the API route builds rows with it and the page
 * filters them with it. Nothing here exposes a chat id / phone number: the
 * outbox's response_error can carry one ("skipped: Test user 9725…"), so it
 * is only ever pattern-matched, never passed on.
 */

/** Where one delivery stands. */
export type ReceiptState =
  /** ✅ a Priority goods receipt (draft) exists */
  | 'done'
  /** ⏳ queued / held / sent, no answer yet */
  | 'waiting'
  /** ⏳ the delivery is still being received (no outbox row yet) */
  | 'receiving'
  /** ⚠️ Priority refused it — no draft */
  | 'refused'
  /** 🔁 Priority refused it after creating the draft header — a part-built draft exists */
  | 'partial'
  /** ⚠️ sent, but Make never confirmed it */
  | 'unconfirmed'
  /** ⚠️ closed but not sent (held by hand, never queued) — or a test, which is muted */
  | 'not_sent';

/** Short reason codes; the page words them (lib/i18n receipts.reason.*). */
export type ReceiptReason =
  | 'supplier_missing'
  | 'item_missing'
  | 'unit_whole'
  | 'already_in_priority'
  | 'make_crash'
  | 'make_no_ok'
  | 'no_reply'
  | 'expired'
  | 'not_queued'
  | 'held'
  | 'test'
  | 'other';

export type ReceiptCategory = 'meat' | 'non_meat';

/** One delivery as the page shows it. */
export interface ReceiptRow {
  delivery_id: string;
  created_at: string | null;
  supplier: string | null;
  document_number: string | null;
  category: ReceiptCategory | null;
  /** The receiver's nickname; never a chat id. */
  worker: string | null;
  state: ReceiptState;
  reason: ReceiptReason | null;
  /** Priority's own (Hebrew) refusal text, refused / partial only, trimmed. */
  priority_error: string | null;
  gr_docno: string | null;
  /** Priority's status of the GR (e.g. טיוטא = draft). */
  gr_status: string | null;
  partial_docno: string | null;
  line_count: number;
  po_number: string | null;
  outbox_id: number | null;
  is_test: boolean;
  /** Worth opening on the needs-attention page. */
  attention: boolean;
}

/** The outbox columns the status needs (partial_docno may not exist yet → undefined). */
export interface OutboxInput {
  id: number;
  status: string | null;
  status_code: number | null;
  response_body: string | null;
  response_error: string | null;
  not_ready_reason: string | null;
  target: string | null;
  category?: string | null;
  partial_docno?: string | null;
}

export interface GrInput {
  docno: string | null;
  statdes: string | null;
}

export interface StateInput {
  delivery_status: string | null;
  outbox: OutboxInput | null;
  gr: GrInput | null;
}

export interface DerivedState {
  state: ReceiptState;
  reason: ReceiptReason | null;
  gr_docno: string | null;
  gr_status: string | null;
  partial_docno: string | null;
  priority_error: string | null;
  is_test: boolean;
}

const DOCNO = /\bGR\d{6,}\b/;

/** Make's JSON reply, or null. */
function replyJson(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The SQL priority_push_error_class, ported, plus a "unit needs a whole
 * number" class (ליחידה … ציין רק ערך שלם) — the 14/10 refusal.
 */
export function errorClass(
  status: string | null,
  statusCode: number | null,
  body: string | null,
  error: string | null,
): ReceiptReason | null {
  if (status === 'delivered') return null;
  if (statusCode == null && !body && !error && status !== 'sent' && status !== 'unconfirmed') return null;
  const txt = `${str(replyJson(body)?.error) ?? ''} ${body ?? ''} ${error ?? ''}`;
  if (/חסר\s*(מס\\?['׳’`]?|מספר)\s*ספק/.test(txt)) return 'supplier_missing';
  if (/חסר\s*מק\\?["״”'׳]?ט/.test(txt)) return 'item_missing';
  if (/ציין\s*רק\s*ערך\s*שלם/.test(txt)) return 'unit_whole';
  if (/הכנסה\s*לקובץ\s*נכשלה/.test(txt)) return 'already_in_priority';
  if (statusCode != null && statusCode >= 500 && statusCode <= 599) return 'make_crash';
  if (statusCode != null && statusCode >= 200 && statusCode <= 299) return 'make_no_ok';
  if (statusCode == null && (status === 'sent' || status === 'unconfirmed' || /time[d ]?\s*out|no reply/i.test(error ?? ''))) {
    return 'no_reply';
  }
  return 'other';
}

/** Priority's refusal text from Make's reply ("[400] שורה 2- …" → "שורה 2- …"), at most 160 chars. */
export function priorityErrorText(body: string | null): string | null {
  const raw = str(replyJson(body)?.error);
  if (!raw) return null;
  const clean = raw.replace(/^\s*\[\d{3}\]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

/** Make's reply stage at which the draft header already exists in Priority. */
const AFTER_HEADER = new Set(['deepInsert', 'rollbackFailed']);

/** One delivery's status in Priority. */
export function deriveReceiptState({ delivery_status, outbox, gr }: StateInput): DerivedState {
  const base = {
    reason: null as ReceiptReason | null,
    gr_docno: str(gr?.docno),
    gr_status: str(gr?.statdes),
    partial_docno: null as string | null,
    priority_error: null as string | null,
    is_test: outbox?.target === 'test',
  };

  if (!outbox) {
    if (base.gr_docno) return { ...base, state: 'done' };
    if (delivery_status === 'In Progress') return { ...base, state: 'receiving' };
    return { ...base, state: 'not_sent', reason: 'not_queued' };
  }

  const reply = replyJson(outbox.response_body);
  const partial = str(outbox.partial_docno) ?? str(reply?.partial_docno);
  const status = outbox.status ?? '';
  // "confirmed by hand: Priority draft GR…" / "Priority already has GR GR…"
  const textDocno = `${outbox.not_ready_reason ?? ''} ${outbox.response_error ?? ''}`.match(DOCNO)?.[0] ?? null;

  if (status === 'skipped') {
    const test = base.is_test || /test user|test scan/i.test(outbox.response_error ?? '');
    if (base.gr_docno) return { ...base, state: 'done', is_test: test };
    return { ...base, state: 'not_sent', reason: test ? 'test' : 'held', is_test: test };
  }
  // A goods receipt in Priority settles it, whatever the outbox says.
  if (base.gr_docno) return { ...base, state: 'done', partial_docno: partial };
  if (status === 'delivered') return { ...base, state: 'done', gr_docno: textDocno };
  if (status === 'already_in_priority') {
    return { ...base, state: 'done', gr_docno: textDocno, reason: 'already_in_priority' };
  }

  if (status === 'failed' || status === 'expired') {
    const priority_error = priorityErrorText(outbox.response_body);
    const reason =
      status === 'expired' && outbox.status_code == null
        ? 'expired'
        : errorClass(status, outbox.status_code, outbox.response_body, outbox.response_error) ?? 'other';
    const stage = str(reply?.stage);
    if (partial || (stage && AFTER_HEADER.has(stage))) {
      return { ...base, state: 'partial', reason, partial_docno: partial, priority_error };
    }
    return { ...base, state: 'refused', reason, priority_error };
  }

  if (status === 'unconfirmed') {
    return { ...base, state: 'unconfirmed', reason: errorClass(status, outbox.status_code, outbox.response_body, outbox.response_error) };
  }

  // queued / waiting / sent, and anything new: not settled yet
  return { ...base, state: 'waiting' };
}

/** States that have a card on the needs-attention page (a test is never one). */
export function needsAttention(state: ReceiptState, isTest: boolean): boolean {
  if (isTest) return false;
  return state === 'refused' || state === 'partial' || state === 'unconfirmed' || state === 'not_sent';
}

/** 'meat' | 'non_meat' | null from the outbox / pallets / invoice OCR text. */
export function normalizeCategory(v: unknown): ReceiptCategory | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (/non[\s_-]?meat/.test(s)) return 'non_meat';
  if (s === 'meat') return 'meat';
  return null;
}

export type WindowFilter = 'today' | '3d' | '14d';
export type CategoryFilter = 'all' | ReceiptCategory;

export const WINDOW_DAYS = 14;

/** YYYY-MM-DD of an instant in Israel time. */
export function israelDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/**
 * Rows in the window and category. "today" = the Israel calendar day of
 * `now`; 3 / 14 days = the last 3 / 14 × 24 h.
 */
export function filterReceipts(
  rows: readonly ReceiptRow[],
  windowFilter: WindowFilter,
  category: CategoryFilter,
  now: Date = new Date(),
): ReceiptRow[] {
  const today = israelDay(now);
  const days = windowFilter === '3d' ? 3 : WINDOW_DAYS;
  const since = now.getTime() - days * 24 * 3600 * 1000;
  return rows.filter((r) => {
    if (category !== 'all' && r.category !== category) return false;
    if (!r.created_at) return windowFilter === '14d';
    const at = new Date(r.created_at);
    if (Number.isNaN(at.getTime())) return windowFilter === '14d';
    if (windowFilter === 'today') return israelDay(at) === today;
    return at.getTime() >= since;
  });
}

/** Count per state, for the summary strip. */
export function countByState(rows: readonly ReceiptRow[]): Record<ReceiptState, number> {
  const out: Record<ReceiptState, number> = {
    done: 0,
    waiting: 0,
    receiving: 0,
    refused: 0,
    partial: 0,
    unconfirmed: 0,
    not_sent: 0,
  };
  for (const r of rows) out[r.state] += 1;
  return out;
}

/** "15/10 14:05" in Israel time; '—' when there is no time. */
export function formatReceiptTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}
