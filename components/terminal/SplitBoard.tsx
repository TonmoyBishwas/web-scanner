'use client';

/**
 * Manager live board — /assign/[token] once `session.status !== 'planning'`.
 *
 * Polls GET /api/split-plan every 5s so the manager watches slots fill in
 * near-real-time without any push infrastructure. Release / Reassign POST to
 * /api/pallet-claim (Task 5); the roster editor and the total-pallets control
 * PATCH /api/split-plan (Task 6).
 *
 * Caller identity for Release/Reassign: /api/pallet-claim now recognises the
 * JOB OWNER (`worker_chat_id === session.owner_chat_id`) whether or not
 * they're on the roster — a manager who split the work without keeping any
 * pallets for themselves isn't a roster member at all. This board sends
 * `session.owner_chat_id` for both actions; `session` already carries it
 * (set by the bot when the planning session was created), so no `?w=` param
 * on the /assign link is needed. Reassign is owner-only server-side
 * (`owner_action_only`, 403) — a worker hands their own pallet back via
 * `release` from their own job screen (SplitJobScreen, which sends its own
 * `?w=` identity and is unaffected by this route change); moving someone
 * else's pallet is exclusively a manager action, which this board is.
 *
 * The stale marker (decision 6) is display-only — nothing here ever calls
 * release automatically. `nowMs` is a state value set together with each
 * poll response, never `Date.now()` read during render, so the very first
 * client render matches whatever the server rendered (both see `nowMs ===
 * null`, i.e. no stale glyphs) before the first poll lands.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import type { MultiPalletSession, PalletSlot } from '@/types';

interface Props {
  session: MultiPalletSession;
}

const POLL_MS = 5000;
const STALE_AFTER_MS = 20 * 60 * 1000;

function staleMinutes(slot: PalletSlot, nowMs: number | null): number | null {
  if (nowMs === null || slot.status !== 'claimed' || !slot.claimed_at) return null;
  const elapsed = nowMs - new Date(slot.claimed_at).getTime();
  return elapsed >= STALE_AFTER_MS ? Math.floor(elapsed / 60000) : null;
}

/** Keep only digits — same rationale as SplitPlanner's version. */
function digitsOnly(v: string): string {
  return v.replace(/[^\d]/g, '');
}

// /api/split-plan (resend-POST and PATCH) error codes reachable from this
// screen, mapped to manager-facing copy. Unmapped code → shared generic.
const PLAN_ERROR_KEYS: Record<string, TranslationKey> = {
  invalid_plan: 'split.plan.error.invalidPlan',
  no_workers: 'split.plan.error.noWorkers',
  quotas_exceed_total: 'split.plan.error.quotasExceedTotal',
  unknown_workers: 'split.plan.error.unknownWorkers',
  loose_owner_not_on_this_job: 'split.plan.error.looseOwnerNotOnJob',
  session_not_found: 'split.plan.error.sessionNotFound',
  already_committed: 'split.plan.error.alreadyCommitted',
  // Named precisely when we can (see removedStillHolding below); this is the
  // fallback for the rare race where the 409 still lands despite the
  // pre-submit check (someone claimed a slot between check and submit).
  worker_still_holds_a_pallet: 'split.board.error.stillHoldsPalletGeneric',
  // PATCH now checks worker_chat_id === session.owner_chat_id (I7). This
  // board always sends the owner's own chat_id, so hitting it would mean a
  // stale local `session.owner_chat_id` — worth its own copy since the
  // pallet-claim `owner_action_only` text below is reassign-specific and
  // PATCH covers roster/total edits instead.
  owner_action_only: 'split.board.error.ownerOnly',
};
function planErrorKey(code: string | undefined): TranslationKey {
  if (code && Object.prototype.hasOwnProperty.call(PLAN_ERROR_KEYS, code)) return PLAN_ERROR_KEYS[code];
  return 'split.error.generic';
}

// /api/pallet-claim error codes reachable from Release / Reassign only (this
// screen never sends 'next' | 'add' | 'close_short' | 'take_loose').
const CLAIM_ERROR_KEYS: Record<string, TranslationKey> = {
  session_not_found: 'split.plan.error.sessionNotFound',
  not_claimed: 'split.board.error.notClaimed',
  target_not_on_this_job: 'split.board.error.targetNotOnJob',
  not_on_this_job: 'split.board.error.staleAction',
  not_a_split_session: 'split.board.error.staleAction',
  no_such_slot: 'split.board.error.staleAction',
  unknown_action: 'split.board.error.staleAction',
  missing_to_chat_id: 'split.board.error.staleAction',
  missing_fields: 'split.board.error.staleAction',
  // The job finished (including via close_short) between this board's last
  // poll and the tap — same "nothing left to do here" situation as any other
  // stale action.
  session_already_completed: 'split.board.error.staleAction',
  // Reassign is owner-only server-side. This board always sends the owner's
  // own chat_id, so hitting this would mean local `session.owner_chat_id` is
  // stale — worth its own copy rather than the generic "stale action" bucket
  // since it points at a more specific "refresh" fix.
  owner_action_only: 'split.board.error.ownerActionOnly',
};
function claimErrorKey(code: string | undefined): TranslationKey {
  if (code && Object.prototype.hasOwnProperty.call(CLAIM_ERROR_KEYS, code)) return CLAIM_ERROR_KEYS[code];
  return 'split.error.generic';
}

export default function SplitBoard({ session: initialSession }: Props) {
  const tr = useT();
  const [session, setSession] = useState(initialSession);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingRoster, setEditingRoster] = useState(false);
  const [rosterChecked, setRosterChecked] = useState<Record<string, boolean>>({});
  const [totalEditInput, setTotalEditInput] = useState('');

  // Every request that can end in `setSession` — the poll AND every write
  // action below — takes a ticket from this counter before it fires and only
  // applies its result if it's still the highest ticket issued when the
  // response lands. Without this, a poll in flight when the manager taps
  // Release can resolve with its stale pre-action snapshot AFTER Release's
  // own response, silently reverting the just-applied change until the next
  // cycle papers over it (mirrors the `requestSeq` pattern already used in
  // PalletsBrowser.tsx for the same reason).
  const seqRef = useRef(0);
  // Mirrors `busyKey` for poll() to read without needing it in its own
  // dependency array (which would tear down/rebuild the interval on every
  // busy/idle flip). Assigned during render, not in an effect — a plain
  // ref write is safe here since nothing reads it for this render's output.
  const busyKeyRef = useRef<string | null>(busyKey);
  busyKeyRef.current = busyKey;
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    // Skip entirely while a write is in flight — both to avoid a wasted
    // request and, more importantly, so this poll never takes a ticket that
    // could supersede the write's own (still-pending) response.
    if (busyKeyRef.current !== null) return;
    const seq = ++seqRef.current;
    try {
      const res = await fetch(`/api/split-plan?token=${encodeURIComponent(initialSession.token)}`);
      if (res.status === 404) {
        if (seq !== seqRef.current) return; // superseded while this was in flight
        setExpired(true);
        // Stop hitting the API forever once the session is confirmed gone —
        // nothing will ever un-404 a session past its TTL.
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        return;
      }
      if (!res.ok) return; // best-effort background poll — keep the last-known board
      const data = (await res.json()) as MultiPalletSession;
      if (seq !== seqRef.current) return; // a newer poll or write already landed — drop this one
      setSession(data);
      setNowMs(Date.now());
    } catch {
      // transient network blip — try again next tick, keep showing what we have
    }
  }, [initialSession.token]);

  useEffect(() => {
    void poll();
    pollIntervalRef.current = setInterval(() => void poll(), POLL_MS);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    };
  }, [poll]);

  // Own useMemo (not a plain `?? []`) so useCallback/useMemo hooks below that
  // depend on `roster` don't see a fresh array identity — and re-run — on
  // every render.
  const roster = useMemo(() => session.roster ?? [], [session.roster]);
  const pallets = useMemo(() => [...(session.pallets ?? [])].sort((a, b) => a.n - b.n), [session.pallets]);
  const nickOf = useCallback(
    (chatId: string | null): string | null => {
      if (!chatId) return null;
      return roster.find((r) => r.chat_id === chatId)?.nickname || chatId;
    },
    [roster]
  );
  const doneCount = pallets.filter((p) => p.status === 'done').length;
  const notNotified = session.status === 'active' && session.handoff_ok !== true;

  async function doClaimAction(body: Record<string, unknown>, key: string) {
    const seq = ++seqRef.current;
    setBusyKey(key);
    setError(null);
    try {
      const res = await fetch('/api/pallet-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token, ...body }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; session?: MultiPalletSession }
        | null;
      if (seq !== seqRef.current) return; // superseded — don't clobber whatever landed after us
      if (!res.ok || !data?.success) {
        setError(claimErrorKey(data?.error));
        return;
      }
      if (data.session) {
        setSession(data.session);
        setNowMs(Date.now());
      }
    } catch {
      if (seq === seqRef.current) setError('split.error.generic');
    } finally {
      if (seq === seqRef.current) setBusyKey(null);
    }
  }

  function release(slot: PalletSlot) {
    if (!session.owner_chat_id) {
      setError('split.board.error.staleAction');
      return;
    }
    void doClaimAction(
      { worker_chat_id: session.owner_chat_id, action: 'release', pallet_n: slot.n },
      `release-${slot.n}`
    );
  }

  function reassign(slot: PalletSlot, toChatId: string) {
    if (!session.owner_chat_id || !toChatId) {
      setError('split.board.error.staleAction');
      return;
    }
    void doClaimAction(
      { worker_chat_id: session.owner_chat_id, action: 'reassign', pallet_n: slot.n, to_chat_id: toChatId },
      `reassign-${slot.n}`
    );
  }

  async function resend() {
    const seq = ++seqRef.current;
    setBusyKey('resend');
    setError(null);
    try {
      const res = await fetch('/api/split-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.token,
          // Ignored server-side once status is already 'active' — a resend
          // re-fires the webhook off the ALREADY-committed session data. But
          // the route's top-of-function guard (pallet_count >= 1, at least
          // one assignment) runs before that branch is even reached, so it
          // still needs a shape that passes those checks.
          pallet_count: pallets.length || session.pallet_count || 0,
          loose_box_count: session.loose_box_count ?? 0,
          assignments: roster.map((r) => ({ chat_id: r.chat_id, quota: r.quota })),
          loose_owner: session.loose?.owner ?? null,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; session?: MultiPalletSession }
        | null;
      if (seq !== seqRef.current) return; // superseded — don't clobber whatever landed after us
      if (res.ok && data?.success) {
        if (data.session) {
          setSession(data.session);
          setNowMs(Date.now());
        }
        // else: defensive only — the route always includes `session` on a
        // 200 (checked against the live handler), so this branch should be
        // unreachable. Deliberately NOT calling poll() from here: poll()
        // runs synchronously up to its own `await fetch`, so it would take a
        // ticket and advance `seqRef` past this function's `seq` BEFORE this
        // function's `finally` runs — making `seq !== seqRef.current` true
        // there and permanently skipping `setBusyKey(null)`. `busyKeyRef`
        // then resyncs to the stale 'resend' value on the next render, and
        // poll()'s own busy-skip disables every action forever (only a page
        // reload would recover). Just falling through to `finally` below
        // clears `busyKey` normally; the next scheduled 5s poll refreshes
        // the board on its own if this branch is ever actually hit.
        return;
      }
      setError(data?.error === 'bot_unreachable' ? 'split.board.error.stillNotNotified' : planErrorKey(data?.error));
    } catch {
      if (seq === seqRef.current) setError('split.error.generic');
    } finally {
      if (seq === seqRef.current) setBusyKey(null);
    }
  }

  function openRosterEditor() {
    const seeded: Record<string, boolean> = {};
    roster.forEach((r) => {
      seeded[r.chat_id] = true;
    });
    setRosterChecked(seeded);
    setEditingRoster(true);
    setError(null);
  }

  function toggleRosterEntry(chatId: string) {
    setRosterChecked((c) => ({ ...c, [chatId]: !c[chatId] }));
  }

  // Computed proactively so the manager sees WHO is blocking the removal
  // before ever submitting — mirrors the server's own 409 guard
  // (`worker_still_holds_a_pallet`) instead of round-tripping to discover it.
  const removedStillHolding = useMemo(
    () =>
      editingRoster
        ? roster.filter(
            (r) => !rosterChecked[r.chat_id] && pallets.some((p) => p.owner === r.chat_id && p.status === 'claimed')
          )
        : [],
    [editingRoster, roster, rosterChecked, pallets]
  );
  const rosterKeptCount = roster.filter((r) => rosterChecked[r.chat_id]).length;
  const canSaveRoster = editingRoster && removedStillHolding.length === 0 && rosterKeptCount > 0 && busyKey === null;

  async function saveRoster() {
    if (!canSaveRoster) return;
    const seq = ++seqRef.current;
    setBusyKey('roster-save');
    setError(null);
    try {
      const assignments = roster
        .filter((r) => rosterChecked[r.chat_id])
        .map((r) => ({ chat_id: r.chat_id, quota: r.quota }));
      const res = await fetch('/api/split-plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token, worker_chat_id: session.owner_chat_id, assignments }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; session?: MultiPalletSession }
        | null;
      if (seq !== seqRef.current) return; // superseded — don't clobber whatever landed after us
      if (!res.ok || !data?.success) {
        setError(planErrorKey(data?.error));
        return;
      }
      if (data.session) {
        setSession(data.session);
        setNowMs(Date.now());
      }
      setEditingRoster(false);
    } catch {
      if (seq === seqRef.current) setError('split.error.generic');
    } finally {
      if (seq === seqRef.current) setBusyKey(null);
    }
  }

  const totalEditNumber = Number(totalEditInput);
  const canUpdateTotal =
    totalEditInput !== '' &&
    Number.isFinite(totalEditNumber) &&
    totalEditNumber >= 1 &&
    totalEditNumber !== pallets.length &&
    busyKey === null;

  async function updateTotal() {
    if (!canUpdateTotal) return;
    const seq = ++seqRef.current;
    setBusyKey('total');
    setError(null);
    try {
      const res = await fetch('/api/split-plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // MUST be a number — the route's guard is `typeof pallet_count ===
        // 'number'`, so a string silently no-ops: no error, nothing changes.
        body: JSON.stringify({
          token: session.token,
          worker_chat_id: session.owner_chat_id,
          pallet_count: totalEditNumber,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; session?: MultiPalletSession }
        | null;
      if (seq !== seqRef.current) return; // superseded — don't clobber whatever landed after us
      if (!res.ok || !data?.success) {
        setError(planErrorKey(data?.error));
        return;
      }
      if (data.session) {
        setSession(data.session);
        setNowMs(Date.now());
      }
      setTotalEditInput('');
    } catch {
      if (seq === seqRef.current) setError('split.error.generic');
    } finally {
      if (seq === seqRef.current) setBusyKey(null);
    }
  }

  if (expired) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center gap-3 bg-canvas text-center px-6">
        <MI name="schedule" size={34} className="text-ink-muted" />
        <div className="text-[14px] font-extrabold text-ink-inverse">{tr('split.page.expiredTitle')}</div>
        <div className="text-[12px] font-semibold text-ink-muted">{tr('split.page.expiredBody')}</div>
      </div>
    );
  }

  return (
    <div className="h-dvh flex flex-col bg-canvas overflow-hidden">
      <div className="flex-none px-4 pt-4 pb-3 border-b border-[#101821] bg-header safe-top">
        <div className="text-[15px] font-extrabold text-ink-inverse">{tr('split.board.title')}</div>
        {session.document_number && (
          <div className="text-[11px] font-semibold text-ink-muted mt-[2px]" dir="ltr">
            {session.document_number}
          </div>
        )}
        <div className="flex items-center gap-3 mt-3">
          <div className="flex-1 bg-sunken border border-line rounded-[11px] px-3 py-[10px] text-center">
            <div className="text-[16px] font-black text-ink-inverse" dir="ltr">
              {doneCount}/{pallets.length}
            </div>
            <div className="text-[9px] font-bold text-ink-muted mt-[2px]">{tr('split.board.progress')}</div>
          </div>
          <button
            onClick={editingRoster ? () => setEditingRoster(false) : openRosterEditor}
            className="flex-1 h-full rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse flex items-center justify-center gap-2 tap-target"
          >
            <MI name={editingRoster ? 'close' : 'edit'} size={16} />
            {tr(editingRoster ? 'common.close' : 'split.board.editRoster')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        {error && (
          <div className="flex items-center gap-2 bg-danger-weak border border-danger/30 rounded-[11px] px-3 py-[10px] text-[12px] font-semibold text-danger-weak-ink">
            <MI name="report_problem" size={16} className="flex-none" />
            <span>{tr(error)}</span>
          </div>
        )}

        {notNotified && (
          <div className="flex flex-col gap-2 bg-amber-card border border-warn/30 rounded-[11px] px-3 py-[10px]">
            <div className="flex items-center gap-2 text-[12px] font-semibold" style={{ color: 'var(--warn-weak-ink)' }}>
              <MI name="report_problem" size={16} className="flex-none" />
              <span>{tr('split.board.notNotifiedBanner')}</span>
            </div>
            <button
              onClick={() => void resend()}
              disabled={busyKey !== null}
              className="self-start px-3 py-[8px] rounded-[9px] text-[11px] font-extrabold bg-brand text-ink-inverse disabled:opacity-50 flex items-center gap-2 tap-target"
            >
              {busyKey === 'resend' && <MI name="autorenew" size={14} className="animate-spin" />}
              {tr(busyKey === 'resend' ? 'split.board.resending' : 'split.board.resend')}
            </button>
          </div>
        )}

        {session.status === 'completed' && (
          <div className="flex items-center gap-2 bg-ok-weak border border-ok/30 rounded-[11px] px-3 py-[10px] text-[12px] font-semibold text-ok-weak-ink">
            <MI name="check_circle" size={16} className="flex-none" />
            <span>{tr('split.board.completeBanner')}</span>
          </div>
        )}

        {editingRoster ? (
          <div className="flex flex-col gap-3">
            <div className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.board.rosterEditHint')}</div>
            <div className="flex flex-col gap-2">
              {roster.map((r) => {
                const isChecked = Boolean(rosterChecked[r.chat_id]);
                const blocked = removedStillHolding.some((x) => x.chat_id === r.chat_id);
                return (
                  <div
                    key={r.chat_id}
                    className="flex items-center gap-3 bg-raised border border-line rounded-[13px] px-3 py-[11px]"
                  >
                    <button
                      type="button"
                      onClick={() => toggleRosterEntry(r.chat_id)}
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
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-bold text-ink-inverse truncate">{r.nickname || r.chat_id}</div>
                      <div className="text-[10px] font-semibold text-ink-muted">
                        {r.quota === null
                          ? tr('split.plan.looseOwnerPool')
                          : tr('split.board.quotaLabel', { quota: r.quota })}
                      </div>
                    </div>
                    {blocked && <MI name="report_problem" size={16} style={{ color: 'var(--warn-weak-ink)' }} />}
                  </div>
                );
              })}
            </div>
            {removedStillHolding.length > 0 && (
              <div className="text-[11px] font-semibold px-1" style={{ color: 'var(--warn-weak-ink)' }}>
                {tr('split.board.error.stillHoldsPallet', {
                  names: removedStillHolding.map((r) => r.nickname || r.chat_id).join(', '),
                })}
              </div>
            )}
            {rosterKeptCount === 0 && (
              <div className="text-[11px] font-semibold text-ink-muted px-1">{tr('split.board.error.noWorkersLeft')}</div>
            )}
            <button
              onClick={() => void saveRoster()}
              disabled={!canSaveRoster}
              className="w-full py-[12px] rounded-[12px] font-extrabold text-[13px] bg-brand text-ink-inverse disabled:bg-sunken disabled:text-ink-muted flex items-center justify-center gap-2 tap-target"
            >
              {busyKey === 'roster-save' && <MI name="autorenew" size={16} className="animate-spin" />}
              {tr(busyKey === 'roster-save' ? 'split.board.saving' : 'split.board.save')}
            </button>

            <div className="flex flex-col gap-2 pt-2 border-t border-line">
              <div className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.board.totalPalletsLabel')}</div>
              <div className="flex gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={totalEditInput}
                  onChange={(e) => setTotalEditInput(digitsOnly(e.target.value))}
                  placeholder={String(pallets.length)}
                  dir="ltr"
                  className="flex-1 bg-sunken border border-line rounded-[11px] px-3 h-[44px] text-[15px] font-black text-ink-inverse text-center tap-target"
                />
                <button
                  onClick={() => void updateTotal()}
                  disabled={!canUpdateTotal}
                  className="flex-1 rounded-[11px] font-extrabold text-[13px] border border-line bg-tile text-ink-inverse disabled:opacity-40 flex items-center justify-center gap-2 tap-target"
                >
                  {busyKey === 'total' && <MI name="autorenew" size={16} className="animate-spin" />}
                  {tr('split.board.updateTotal')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {pallets.map((p) => {
                const stale = staleMinutes(p, nowMs);
                return (
                  <div key={p.n} className="flex flex-col gap-2 bg-raised border border-line rounded-[13px] px-3 py-[11px]">
                    <div className="flex items-center gap-3">
                      <span
                        className="flex-none w-9 h-9 rounded-[9px] bg-tile border border-line flex items-center justify-center font-mono font-black text-[13px] text-[#e8eef2]"
                        dir="ltr"
                      >
                        P{p.n}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-bold text-ink-inverse truncate">
                          {p.owner ? nickOf(p.owner) : tr('split.board.slotOpen')}
                        </div>
                        {p.status === 'done' && p.lpn && (
                          <div className="font-mono text-[11px] font-semibold text-ink-muted truncate" dir="ltr">
                            {p.lpn}
                          </div>
                        )}
                      </div>
                      <MI
                        name={
                          p.status === 'done' ? 'check_circle' : p.status === 'claimed' ? 'schedule' : 'radio_button_unchecked'
                        }
                        size={18}
                        className={
                          p.status === 'done'
                            ? 'text-[#7ee2a8]'
                            : p.status === 'claimed'
                              ? 'text-[#7cc9f2]'
                              : 'text-ink-muted'
                        }
                      />
                    </div>

                    {stale !== null && (
                      <div
                        className="flex items-center gap-1 text-[10px] font-bold"
                        style={{ color: 'var(--warn-weak-ink)' }}
                      >
                        <MI name="report_problem" size={13} />
                        {tr('split.board.stale', { minutes: stale })}
                      </div>
                    )}

                    {p.status === 'claimed' && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => release(p)}
                          disabled={busyKey !== null}
                          className="flex-1 py-[9px] rounded-[10px] text-[11px] font-extrabold border border-line text-ink-muted disabled:opacity-50 tap-target"
                        >
                          {tr('split.board.release')}
                        </button>
                        <select
                          key={`reassign-${p.n}-${p.owner ?? 'none'}`}
                          defaultValue=""
                          disabled={busyKey !== null || roster.length < 2}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v) reassign(p, v);
                          }}
                          className="flex-1 bg-sunken border border-line rounded-[10px] px-2 py-[9px] text-[11px] font-extrabold text-ink-inverse disabled:opacity-50"
                        >
                          <option value="">{tr('split.board.reassignTo')}</option>
                          {roster
                            .filter((r) => r.chat_id !== p.owner)
                            .map((r) => (
                              <option key={r.chat_id} value={r.chat_id}>
                                {r.nickname || r.chat_id}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
              {pallets.length === 0 && (
                <div className="flex flex-col items-center gap-2 bg-raised border border-line rounded-[13px] px-3 py-[18px] text-center">
                  <MI name="pallet" size={26} className="text-ink-muted" />
                  <div className="text-[12px] font-semibold text-ink-muted">{tr('split.board.noPallets')}</div>
                </div>
              )}
            </div>

            {session.loose && (
              <div className="flex items-center gap-3 bg-raised border border-line rounded-[13px] px-3 py-[11px]">
                <span className="flex-none w-9 h-9 rounded-[9px] bg-tile border border-line flex items-center justify-center">
                  <MI name="inventory_2" size={18} className="text-ink-muted" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold text-ink-inverse truncate">
                    {tr('split.board.looseTaskLabel', { count: session.loose.count })}
                  </div>
                  <div className="text-[11px] font-semibold text-ink-muted truncate">
                    {session.loose.owner ? nickOf(session.loose.owner) : tr('split.plan.looseOwnerPool')}
                  </div>
                </div>
                <MI
                  name={
                    session.loose.status === 'done'
                      ? 'check_circle'
                      : session.loose.status === 'claimed'
                        ? 'schedule'
                        : 'radio_button_unchecked'
                  }
                  size={18}
                  className={
                    session.loose.status === 'done'
                      ? 'text-[#7ee2a8]'
                      : session.loose.status === 'claimed'
                        ? 'text-[#7cc9f2]'
                        : 'text-ink-muted'
                  }
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
