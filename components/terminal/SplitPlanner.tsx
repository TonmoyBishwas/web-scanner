'use client';

/**
 * Manager split planner — /assign/[token] while `session.status === 'planning'`.
 *
 * Rendered by app/assign/[token]/page.tsx. `session.roster` at this point is
 * the FULL list of workers eligible for this job (set by the bot when it
 * created the planning session via POST /api/split-plan-session) — nobody is
 * ticked yet. The manager picks a subset, optionally gives each a quota, pins
 * or pools the loose boxes, and taps Send. That POST replaces `session.roster`
 * with only the ticked subset (carrying their quota) and flips the session to
 * `active` — see /api/split-plan's POST handler.
 *
 * Validation here mirrors that route's guards exactly (same order, same
 * codes) so a manager who can tap Send never gets a server rejection for a
 * reason the button already should have caught:
 *   - pallet_count >= 1
 *   - at least one ticked worker
 *   - Σ quota <= pallet_count (less than is fine — the remainder is the pool)
 *   - every assignment names someone on the roster (enforced by construction:
 *     `ticked` is filtered FROM `roster`, so this can't fail from this UI)
 *   - a pinned loose-box owner must be one of the ticked workers (enforced by
 *     the effect below, which un-pins on untick)
 *
 * Presentation follows components/terminal/SplitJobScreen.tsx (dark terminal
 * styling, Heebo, Material Icons via MI.tsx, RTL-aware through useT()).
 */

import { useEffect, useMemo, useState } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import type { MultiPalletSession } from '@/types';

interface Props {
  session: MultiPalletSession;
  /**
   * Called after any /api/split-plan POST whose result may have moved the
   * session off 'planning' server-side: a plain success, a committed-but-
   * unnotified `bot_unreachable` (the commit happened before the webhook
   * call — see the route's comment), or a race (`already_committed` /
   * `session_not_found`). The page re-fetches and swaps this component out
   * for the board (or the expired state) once that happens.
   */
  onSent: () => void;
}

type Problem = 'enterTotal' | 'pickSomeone' | 'quotasExceedTotal';

const PROBLEM_KEYS: Record<Problem, TranslationKey> = {
  enterTotal: 'split.plan.hint.enterTotal',
  pickSomeone: 'split.plan.hint.pickSomeone',
  quotasExceedTotal: 'split.plan.hint.quotasExceedTotal',
};

// Every error /api/split-plan's POST can return, mapped to manager-facing
// copy. A code not in this table falls back to the shared generic message —
// a raw error code must never reach the screen.
const SEND_ERROR_KEYS: Record<string, TranslationKey> = {
  invalid_plan: 'split.plan.error.invalidPlan',
  no_workers: 'split.plan.error.noWorkers',
  quotas_exceed_total: 'split.plan.error.quotasExceedTotal',
  unknown_workers: 'split.plan.error.unknownWorkers',
  loose_owner_not_on_this_job: 'split.plan.error.looseOwnerNotOnJob',
};

// These two mean the session state moved server-side even though this
// response isn't a plain success: 'already_committed' — someone else (or
// another tab) sent this plan first; 'session_not_found' — it's gone. Either
// way, re-fetching and re-routing beats leaving the manager on a dead form.
const NEEDS_REFRESH = new Set(['already_committed', 'session_not_found']);

function sendErrorKey(code: string | undefined): TranslationKey {
  if (code && Object.prototype.hasOwnProperty.call(SEND_ERROR_KEYS, code)) {
    return SEND_ERROR_KEYS[code];
  }
  return 'split.error.generic';
}

/** Keep only digits — a number input can still emit 'e', '-', '.', so this
 *  is what actually guarantees Number(...) later never sees anything weird. */
function digitsOnly(v: string): string {
  return v.replace(/[^\d]/g, '');
}

export default function SplitPlanner({ session, onSent }: Props) {
  const tr = useT();
  const roster = useMemo(() => session.roster ?? [], [session.roster]);
  const items = session.ocr_data ?? [];

  const [palletCountInput, setPalletCountInput] = useState('');
  const [looseInput, setLooseInput] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // Raw STRING per worker, not a number. "" (never touched) and "0" (typed
  // zero) must stay distinguishable — a blank quota means pool-only (sent as
  // null); a typed zero is a real zero-reservation (sent as 0). Storing a
  // parsed number would collapse that distinction, since numeric 0 and
  // "absent" are both falsy.
  const [quotas, setQuotas] = useState<Record<string, string>>({});
  const [looseOwner, setLooseOwner] = useState('pool');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);

  const ticked = useMemo(() => roster.filter((r) => checked[r.chat_id]), [roster, checked]);

  // Coerced explicitly per entry with Number(), not summed as raw strings —
  // `+` between a number accumulator and a string operand concatenates
  // rather than adds (the exact bug /api/split-plan's own POST handler
  // coerces up front to avoid: quotas "1","2","3" would sum to "0123" → 123).
  const quotaSum = useMemo(
    () => ticked.reduce((s, r) => s + (quotas[r.chat_id] ? Number(quotas[r.chat_id]) : 0), 0),
    [ticked, quotas]
  );
  const total = Number(palletCountInput) || 0;
  const looseCount = Number(looseInput) || 0;
  const poolCount = Math.max(0, total - quotaSum);

  const problem: Problem | null =
    total < 1 ? 'enterTotal'
    : ticked.length === 0 ? 'pickSomeone'
    : quotaSum > total ? 'quotasExceedTotal' // remainder-to-pool is fine; over-allocation is not
    : null;
  const canSend = problem === null && !sending;

  // If the manager unticks whoever the loose-box owner was pinned to, fall
  // back to pool rather than silently submitting a stale chat_id — the
  // server rejects a pinned owner who isn't on the (ticked) roster anyway.
  useEffect(() => {
    if (looseOwner !== 'pool' && !ticked.some((r) => r.chat_id === looseOwner)) {
      setLooseOwner('pool');
    }
  }, [ticked, looseOwner]);

  function toggle(chatId: string) {
    setChecked((c) => ({ ...c, [chatId]: !c[chatId] }));
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/split-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.token,
          pallet_count: total,
          loose_box_count: looseCount,
          assignments: ticked.map((r) => ({
            chat_id: r.chat_id,
            quota: quotas[r.chat_id] ? Number(quotas[r.chat_id]) : null,
          })),
          loose_owner: looseOwner === 'pool' ? null : looseOwner,
        }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && data?.success) {
        onSent();
        return;
      }
      const code = data?.error;
      // bot_unreachable means the plan WAS committed — only the worker
      // notification failed. There's nothing to say from the planner itself;
      // the board (which onSent() swaps us into) carries a persistent
      // "resend" banner for exactly this state.
      if (code === 'bot_unreachable' || (code && NEEDS_REFRESH.has(code))) {
        onSent();
        return;
      }
      setError(sendErrorKey(code));
    } catch {
      setError('split.error.generic');
    } finally {
      setSending(false);
    }
  }

  const totalKg = items.reduce((s, i) => s + (Number(i.quantity_kg) || 0), 0);

  return (
    <div className="h-dvh flex flex-col bg-canvas overflow-hidden">
      <div className="flex-none px-4 pt-4 pb-3 border-b border-[#101821] bg-header safe-top">
        <div className="text-[15px] font-extrabold text-ink-inverse">{tr('split.plan.title')}</div>
        {session.document_number && (
          <div className="text-[11px] font-semibold text-ink-muted mt-[2px]" dir="ltr">
            {session.document_number}
          </div>
        )}
        {(session.category === 'non_meat' || items.length > 0) && (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {session.category === 'non_meat' && (
              <span className="px-2 py-[2px] rounded-full text-[9px] font-extrabold bg-[#243444] text-[#cbd5e1]">
                {tr('terminal.palletsTypeNonMeat')}
              </span>
            )}
            {items.length > 0 && (
              <span className="text-[11px] font-semibold text-ink-muted" dir="ltr">
                {tr('split.plan.invoiceSummary', {
                  items: items.length,
                  kg: (Math.round(totalKg * 10) / 10).toString(),
                })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        {error && (
          <div className="flex items-center gap-2 bg-danger-weak border border-danger/30 rounded-[11px] px-3 py-[10px] text-[12px] font-semibold text-danger-weak-ink">
            <MI name="report_problem" size={16} className="flex-none" />
            <span>{tr(error)}</span>
          </div>
        )}

        <div className="flex gap-3">
          <label className="flex-1 flex flex-col gap-1">
            <span className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.plan.totalPalletsLabel')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={palletCountInput}
              onChange={(e) => setPalletCountInput(digitsOnly(e.target.value))}
              placeholder={tr('split.plan.totalPalletsPlaceholder')}
              dir="ltr"
              className="bg-sunken border border-line rounded-[11px] px-3 h-[46px] text-[16px] font-black text-ink-inverse text-center tap-target"
            />
          </label>
          <label className="flex-1 flex flex-col gap-1">
            <span className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.plan.looseBoxesLabel')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={looseInput}
              onChange={(e) => setLooseInput(digitsOnly(e.target.value))}
              placeholder={tr('split.plan.looseBoxesPlaceholder')}
              dir="ltr"
              className="bg-sunken border border-line rounded-[11px] px-3 h-[46px] text-[16px] font-black text-ink-inverse text-center tap-target"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.plan.rosterHeader')}</div>
          {roster.length === 0 ? (
            <div className="flex flex-col items-center gap-2 bg-raised border border-line rounded-[13px] px-3 py-[18px] text-center">
              <MI name="groups" size={26} className="text-ink-muted" />
              <div className="text-[12px] font-semibold text-ink-muted">{tr('split.plan.noRoster')}</div>
            </div>
          ) : (
            roster.map((r) => {
              const isChecked = Boolean(checked[r.chat_id]);
              return (
                <div
                  key={r.chat_id}
                  className="flex items-center gap-3 bg-raised border border-line rounded-[13px] px-3 py-[11px]"
                >
                  <button
                    type="button"
                    onClick={() => toggle(r.chat_id)}
                    aria-pressed={isChecked}
                    className="flex-none w-7 h-7 rounded-[8px] border flex items-center justify-center tap-target"
                    style={
                      isChecked
                        ? { background: 'var(--brand)', borderColor: 'var(--brand)' }
                        : { borderColor: 'var(--border-strong)', background: 'transparent' }
                    }
                  >
                    {isChecked && <MI name="check" size={16} className="text-ink-inverse" />}
                  </button>
                  <span className="flex-1 min-w-0 text-[13px] font-bold text-ink-inverse truncate">
                    {r.nickname || r.chat_id}
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    disabled={!isChecked}
                    value={quotas[r.chat_id] ?? ''}
                    onChange={(e) => setQuotas((q) => ({ ...q, [r.chat_id]: digitsOnly(e.target.value) }))}
                    placeholder={tr('split.plan.quotaPlaceholder')}
                    dir="ltr"
                    className="flex-none w-[64px] bg-sunken border border-line rounded-[9px] px-2 h-[38px] text-[13px] font-bold text-ink-inverse text-center disabled:opacity-40"
                  />
                </div>
              );
            })
          )}
        </div>

        <div
          className="bg-sunken border border-line rounded-[11px] px-3 py-[10px] text-center text-[12px] font-bold text-ink-inverse"
          dir="ltr"
        >
          {tr('split.plan.assignedReadout', { assigned: quotaSum, total, pool: poolCount })}
        </div>
        {problem && (
          <div className="text-[11px] font-semibold text-ink-muted px-1 -mt-2 text-center">
            {tr(PROBLEM_KEYS[problem])}
          </div>
        )}

        {looseCount > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.plan.looseOwnerLabel')}</span>
            <select
              value={looseOwner}
              onChange={(e) => setLooseOwner(e.target.value)}
              className="bg-sunken border border-line rounded-[11px] px-3 h-[44px] text-[13px] font-bold text-ink-inverse tap-target"
            >
              <option value="pool">{tr('split.plan.looseOwnerPool')}</option>
              {ticked.map((r) => (
                <option key={r.chat_id} value={r.chat_id}>
                  {r.nickname || r.chat_id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex-none p-4 border-t border-[#101821] bg-header safe-bottom">
        <button
          onClick={() => void send()}
          disabled={!canSend}
          className="w-full py-[13px] rounded-[13px] font-extrabold text-[14px] bg-brand text-ink-inverse disabled:bg-sunken disabled:text-ink-muted flex items-center justify-center gap-2 tap-target"
        >
          {sending && <MI name="autorenew" size={18} className="animate-spin" />}
          {tr(sending ? 'split.plan.sending' : 'split.plan.send')}
        </button>
      </div>
    </div>
  );
}
