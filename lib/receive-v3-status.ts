/**
 * The receive form v3 status screen's outcome (flag receive_form_v3): where a
 * saved form stands, from the form's status, the tenant's ERP setting and
 * the Priority push status (lib/priority-status.ts derivePriorityStatus, the
 * same logic as GET /api/priority-status). Pure: no DB, no React.
 *
 *   erp 'none' and the form done            → success (no Priority read)
 *   form failed                             → failed
 *   form not done (open/submitted/…)        → pending
 *   received                                → success; partial when the outbox
 *                                             row lists unmapped item codes
 *                                             (the office completes those lines)
 *   already                                 → success (docno when known)
 *   failed / expired / cancelled            → failed
 *   held / test / off / unconfirmed /
 *   noWriteback                             → timeout ("the office was told")
 *   anything else (checking, closing,
 *   waitingPo, waiting, sending, awaiting,
 *   unknown)                                → pending, or timeout once
 *                                             submitted_at is > 150 s ago
 */
import type { PriorityStatus } from './priority-status';
import type { V3Erp, V3Outcome } from './receive-v3';

/** After this long since the save, a still-moving Priority state reads as timeout. */
export const V3_STATUS_TIMEOUT_MS = 150_000;

export interface V3OutcomeInput {
  erp: V3Erp;
  formStatus: string;
  /** null when Priority was not read (no ERP, or the form is not done). */
  priority: PriorityStatus | null;
  /** The priority_push_outbox row (`select *`), or null. */
  outbox: Record<string, unknown> | null;
  submittedAt: string | null;
  now: Date;
}

export interface V3OutcomeResult {
  outcome: V3Outcome;
  docno: string | null;
  office_lines: number | null;
}

/** tenants.erp → 'priority' | 'none'. Any non-empty value but 'none' is Priority. */
export function erpOf(raw: unknown): V3Erp {
  if (raw === null || raw === undefined) return 'none';
  const v = String(raw).trim().toLowerCase();
  return v === '' || v === 'none' ? 'none' : 'priority';
}

/** The outbox row's unmapped item codes (non-empty strings). */
export function unmappedCodes(outbox: Record<string, unknown> | null): string[] {
  const codes = outbox?.unmapped_codes;
  return Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [];
}

const TIMEOUT_STATES = new Set(['held', 'test', 'off', 'unconfirmed', 'noWriteback']);
const FAILED_STATES = new Set(['failed', 'expired', 'cancelled']);

export function v3Outcome(input: V3OutcomeInput): V3OutcomeResult {
  const none: V3OutcomeResult = { outcome: 'pending', docno: null, office_lines: null };
  if (input.formStatus === 'failed') return { ...none, outcome: 'failed' };
  if (input.formStatus !== 'done') return none;
  if (input.erp === 'none') return { ...none, outcome: 'success' };

  const p = input.priority;
  if (!p) return timedOut(input) ? { ...none, outcome: 'timeout' } : none;
  const docno = typeof p.docno === 'string' && p.docno ? p.docno : null;
  if (p.state === 'received') {
    const n = unmappedCodes(input.outbox).length;
    return n > 0 ? { outcome: 'partial', docno, office_lines: n } : { outcome: 'success', docno, office_lines: null };
  }
  if (p.state === 'already') return { outcome: 'success', docno, office_lines: null };
  if (FAILED_STATES.has(p.state)) return { ...none, outcome: 'failed' };
  if (TIMEOUT_STATES.has(p.state)) return { ...none, outcome: 'timeout' };
  return timedOut(input) ? { ...none, outcome: 'timeout' } : none;
}

function timedOut(input: V3OutcomeInput): boolean {
  const at = input.submittedAt ? Date.parse(input.submittedAt) : NaN;
  return Number.isFinite(at) && input.now.getTime() - at > V3_STATUS_TIMEOUT_MS;
}
