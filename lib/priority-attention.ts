/**
 * The Priority "needs attention" page (app/priority/attention): the rows of
 * our priority_push_attention_v view, what each problem means in plain
 * English, what to check before acting, and which of the two actions —
 * Send again (priority_push_resend) and Mark as found
 * (priority_push_mark_found) — a row offers. There is no bulk action.
 *
 * Also the "lines to check in Priority" section: rows of delivery_gaps_v
 * (M5) grouped per delivery and worded in plain English.
 *
 * Pure (no DB, no React): the page and the API routes share it.
 */

/** One row of priority_push_attention_v (one row per problem). */
export interface AttentionRow {
  outbox_id: number | null;
  delivery_id: string | null;
  document_number: string | null;
  supplier: string | null;
  category: string | null;
  problem: string;
  reason_text: string | null;
  status_code: number | null;
  error_class: string | null;
  sent_at: string | null;
  created_at: string | null;
  receiver_chat_id: number | string | null;
  /** M4's additive trailing columns (absent on an older view → undefined). */
  /** 'make' | 'test' (the fake Make of the Test-user harness); null for rows without an outbox row. */
  target?: string | null;
  /** The outbox row's own status (failed / expired / unconfirmed / sent / queued / waiting). */
  outbox_status?: string | null;
  /** A Priority GR already linked to this delivery (origin ≠ warehouse_bot). */
  gr_docno?: string | null;
}

export interface ProblemInfo {
  /** The problem in a few words. */
  title: string;
  /** What to check before doing anything. */
  check: string;
}

/** Each problem the view can list. */
export const PROBLEM_INFO: Readonly<Record<string, ProblemInfo>> = {
  failed: {
    title: 'Priority refused it',
    check:
      'Read the reason. A supplier refusal creates no draft; an item refusal or a crash may leave a draft header, so search Priority for the note number (BOOKNUM) in any status, including draft (טיוטא), before any Send again. An expired row was never sent and has no Send again — tell Tonmoy.',
  },
  unconfirmed: {
    title: 'Sent, but Make never confirmed it',
    check:
      'A draft may already exist. Search Priority for the note number (BOOKNUM) in any status, including draft (טיוטא), and check the Make history before any re-send.',
  },
  no_writeback: {
    title: 'Sent, but no receipt came back from Priority',
    check:
      'Make took it but nothing was written back. Check the Make history and search Priority for the note number (BOOKNUM) in any status, including draft (טיוטא). If it is there, use Mark as found. Send again is offered only once the row is failed or unconfirmed.',
  },
  held: {
    title: 'Held — not sent by itself',
    check: 'Read the reason. If this note is already in Priority, use Mark as found with that GR number.',
  },
  not_queued: {
    title: 'Closed, but never queued for Priority',
    check: 'The delivery closed without a Priority outbox row. Nothing can be sent from this page — tell Tonmoy.',
  },
  bot_unreachable: {
    title: 'The WhatsApp alert never arrived',
    check:
      'The bot did not take the office alert for this note after 4 tries (it was restarting or down), so nobody was told on WhatsApp. Deal with the note on its own card in this list. If this keeps appearing, tell Tonmoy.',
  },
  orphan_class1: {
    title: 'Leftover empty delivery',
    check: 'Empty and replaced by a newer delivery of the same note. Tonmoy clears these with the clean-up script.',
  },
  orphan_class2: {
    title: 'Delivery opened but never received',
    check: 'No goods were booked on it. Confirm with the receiver; Tonmoy clears it after that.',
  },
  orphan_class3: {
    title: 'Goods scanned but never finished',
    check: 'Real goods are booked but the delivery was never closed. The receiver should finish it — never delete it.',
  },
};

/** error_class from priority_push_notify_bot, with the Hebrew Priority text glossed. */
export const ERROR_CLASS_TEXT: Readonly<Record<string, string>> = {
  supplier_missing: 'Supplier not set up in Priority. Priority said: חסר מס\' ספק ("missing supplier number").',
  item_missing: 'An item is not in Priority. Priority said: חסר מק"ט ("missing item code").',
  already_in_priority: 'Priority says this document already exists. Priority said: הכנסה לקובץ נכשלה ("insert into file failed").',
  make_crash: 'Make crashed (HTTP 5xx). A draft header may already exist.',
  make_no_ok: 'Make answered without ok:true (for example "Accepted"). A draft may be part-built.',
  no_reply: 'No reply from Make.',
  other: 'Another error — see the reason.',
};

/** One row of delivery_gaps_v (M5, Task 14b): a line of a closed delivery to check in Priority. */
export interface GapLine {
  delivery_id: string;
  document_number: string | null;
  supplier: string | null;
  code: string | null;
  name: string | null;
  invoice_qty: number | string | null;
  received_qty: number | string | null;
  unit: string | null;
  /** supplier_short | supplier_over | other (Task 17), or the legacy Hebrew per-delivery reason. */
  gap_reason: string | null;
  gap_note: string | null;
  /** will_come | wont_come */
  rest_expected: string | null;
  /** counted | invoice_assumed */
  count_source: string | null;
  gr_docno: string | null;
  created_at?: string | null;
  /** priority_push_explain's unit_risk for this line at send time. */
  unit_risk?: string | null;
  /** The client's builder found no Priority item for the code. */
  item_not_linked?: boolean | null;
}

/** The lines of one delivery, for the "lines to check in Priority" section. */
export interface FixDelivery {
  delivery_id: string;
  document_number: string | null;
  supplier: string | null;
  gr_docno: string | null;
  created_at: string | null;
  lines: GapLine[];
}

/** Task 17's per-line reasons. */
export const GAP_REASON_TEXT: Readonly<Record<string, string>> = {
  supplier_short: 'the supplier sent less',
  supplier_over: 'the supplier sent more',
  other: 'another reason',
};

const REST_TEXT: Readonly<Record<string, string>> = {
  will_come: 'the rest will come later',
  wont_come: "the rest won't come",
};

/** priority_push_explain's unit_risk codes (M2). */
export const UNIT_RISK_TEXT: Readonly<Record<string, string>> = {
  no_item_defaults_kg: 'no Priority item, so Priority books it as kg',
  unit_unknown: 'the note printed no unit',
  count_to_kg_item: 'counted, but the Priority item is in kg',
  kg_to_unit_item: 'weighed in kg, but the Priority item counts units',
  packs_not_units: 'counted in cartons or packs, not single units',
};

/** priority_push_resend refusal codes, in plain English. */
export const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  not_resendable_status: 'Only a failed or unconfirmed row can be sent again (this one is not, or never became ready). Refresh the list.',
  already_in_priority:
    'Priority already has a receipt for this delivery, so nothing was sent. Use Mark as found if it is still listed.',
  request_in_flight: 'The previous send is still waiting for an answer. Wait a minute, then refresh.',
  checks_not_confirmed: 'Both checks must be ticked before sending again.',
  sibling_in_flight:
    'Another delivery with the same note number is already in Priority or on its way, so nothing was sent (it would make a duplicate draft). If this really is a second delivery, tell Tonmoy.',
  known_reject_supplier:
    'Priority would refuse it again: the supplier is still not set up there. Open the supplier in Priority first; if it is open and this still appears, tell Tonmoy.',
  known_reject_items:
    'Make would fail again: items are still not linked to Priority items. Link the items first; if they are linked and this still appears, tell Tonmoy.',
};

/** priority_push_mark_found refusal codes, in plain English. */
export const MARK_FOUND_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  docno_invalid: 'That is not a Priority document number. Type it as Priority shows it, for example GR26000049.',
  not_markable_status: 'This row is already delivered or no longer open. Refresh the list.',
  request_in_flight: 'A send is still waiting for an answer from Make. Wait a minute, then refresh.',
};

/** priority_push_resend accepts only these outbox statuses (M4, step 1 of its checks). */
const RESENDABLE_STATUS = new Set(['failed', 'unconfirmed']);
/** Used only when the view has no outbox_status column. 'no_writeback' is a 'sent' row: never resendable. */
const RESENDABLE_PROBLEM = new Set(['failed', 'unconfirmed']);
const FINDABLE = new Set(['failed', 'unconfirmed', 'no_writeback', 'held']);

/** Plain words for a problem; an unknown one is shown as is. */
export function problemInfo(problem: string): ProblemInfo {
  return PROBLEM_INFO[problem] ?? { title: problem, check: 'Tell Tonmoy.' };
}

export function errorClassText(errorClass: string | null | undefined): string | null {
  return errorClass ? ERROR_CLASS_TEXT[errorClass] ?? null : null;
}

export function refusalText(code: string | null | undefined): string {
  return (code && REFUSAL_TEXT[code]) || 'Not sent. Refresh the list; if it stays, tell Tonmoy.';
}

export function markFoundRefusalText(code: string | null | undefined): string {
  return (code && MARK_FOUND_REFUSAL_TEXT[code]) || 'Nothing was changed. Refresh the list; if it stays, tell Tonmoy.';
}

/**
 * Send again: only where priority_push_resend could accept it — an outbox row
 * whose own status is failed or unconfirmed (an expired row shows as problem
 * 'failed' but is refused; a no_writeback row is still 'sent'), and Priority
 * has no GR for the delivery yet (that is a Mark as found).
 */
export function canSendAgain(row: AttentionRow): boolean {
  if (row.outbox_id == null || row.gr_docno) return false;
  return row.outbox_status != null
    ? RESENDABLE_STATUS.has(row.outbox_status)
    : RESENDABLE_PROBLEM.has(row.problem);
}

/** Mark as found: the office found the draft in Priority by hand. */
export function canMarkFound(row: AttentionRow): boolean {
  return row.outbox_id != null && FINDABLE.has(row.problem);
}

/** A positive whole outbox id from a JSON body, else null. */
export function parseOutboxId(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A Priority document number as typed (e.g. "gr26000049 " → "GR26000049"), else null.
 * Pattern ^[A-Z0-9][A-Z0-9/-]{2,39}$; priority_push_mark_found (M4) accepts all of
 * these (its own pattern also allows "_"). A space inside the number is refused here
 * rather than silently removed.
 */
export function parseDocno(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const docno = v.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9/-]{2,39}$/.test(docno) ? docno : null;
}

/** "07 Oct, 14:05" in Israel time; '—' when there is no time. */
export function formatIsraelTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * delivery_gaps_v rows → one entry per delivery, in the order given (the API
 * reads newest first), each delivery's lines sorted by item code.
 */
export function groupFixLines(lines: readonly GapLine[]): FixDelivery[] {
  const byId = new Map<string, FixDelivery>();
  for (const line of lines) {
    let d = byId.get(line.delivery_id);
    if (!d) {
      d = {
        delivery_id: line.delivery_id,
        document_number: line.document_number,
        supplier: line.supplier,
        gr_docno: line.gr_docno,
        created_at: line.created_at ?? null,
        lines: [],
      };
      byId.set(line.delivery_id, d);
    }
    if (!d.gr_docno && line.gr_docno) d.gr_docno = line.gr_docno;
    d.lines.push(line);
  }
  const out = [...byId.values()];
  for (const d of out) d.lines.sort((a, b) => (a.code ?? '￿').localeCompare(b.code ?? '￿'));
  return out;
}

function qty(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
}

/**
 * One line to check in Priority, in plain English: invoice vs received, then
 * whatever applies — not counted, the worker's reason and note, whether the
 * rest will come, the unit risk, an item not linked. A legacy Hebrew reason is
 * shown as stored.
 */
export function fixLineText(line: GapLine): string {
  const unit = !line.unit ? '' : line.unit === 'unknown' ? ' (no unit on the note)' : ` ${line.unit}`;
  const head =
    `${line.code ?? '—'}${line.name ? ` ${line.name}` : ''}: ` +
    `invoice ${qty(line.invoice_qty)} → received ${qty(line.received_qty)}${unit}`;
  const notes: string[] = [];
  if (line.count_source === 'invoice_assumed') notes.push('not counted (booked as invoiced)');
  if (line.gap_reason) notes.push(`reason: ${GAP_REASON_TEXT[line.gap_reason] ?? line.gap_reason}`);
  if (line.gap_note) notes.push(`note: ${line.gap_note}`);
  if (line.rest_expected) notes.push(REST_TEXT[line.rest_expected] ?? line.rest_expected);
  if (line.unit_risk) notes.push(`unit risk: ${UNIT_RISK_TEXT[line.unit_risk] ?? line.unit_risk}`);
  if (line.item_not_linked) notes.push('item not linked to a Priority item');
  return [head, ...notes].join(' · ');
}
