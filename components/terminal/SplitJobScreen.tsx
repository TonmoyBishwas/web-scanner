'use client';

/**
 * Worker job screen — split-delivery entry point.
 *
 * Rendered by pallet-verify/[token]/page.tsx whenever a split session
 * (`isSplitSession(session)`) is NOT currently held by this worker (no
 * claimed slot of theirs). It replaces the numeric "pallet N of M" cursor a
 * single-scanner delivery uses: instead the worker sees what they've
 * finished, what's still in the pool, and picks their next action. Claiming
 * a pallet (or resuming one already claimed) hands off to the existing
 * 'scanning' phase completely unchanged — this screen only owns the
 * bookends (claim in, confirm out), never the scan itself.
 *
 * Presentation follows components/terminal/PalletsBrowser.tsx (dark
 * terminal styling, Heebo, Material Icons via MI.tsx, RTL-aware through
 * useT()/LanguageContext). The claim/refresh logic mirrors the exact shape
 * given in the Task 14 brief — every POST goes through /api/pallet-claim
 * (Task 5); the pure slot math it wraps lives in lib/pallet-slots.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import type { MultiPalletSession } from '@/types';

interface Props {
  session: MultiPalletSession;
  workerChatId: string;
  onClaimed: (slotN: number) => void;
  onRefresh: () => void | Promise<void>;
}

type ClaimAction = 'next' | 'release' | 'reassign' | 'add' | 'close_short' | 'take_loose';

// Every reason /api/pallet-claim (and the two split-aware completion routes
// it hands off to) can return, mapped to a safe, translated message. A code
// not in this table — or no code at all — falls back to a generic retry
// message. A raw reason string must never reach a warehouse worker.
const CLAIM_ERROR_KEYS: Record<string, TranslationKey> = {
  reserved_for_others: 'split.error.reservedForOthers',
  no_open_slots: 'split.error.noOpenSlots',
  not_on_this_job: 'split.error.notOnThisJob',
  pallet_still_claimed: 'split.error.palletStillClaimed',
  loose_unavailable: 'split.error.looseUnavailable',
  no_loose_task: 'split.error.noLooseTask',
  already_holding_a_pallet: 'split.error.alreadyHoldingAPallet',
  loose_not_claimed: 'split.error.looseNotClaimed',
  not_your_loose_task: 'split.error.notYourLooseTask',
  // Not returned by pallet-claim itself — surfaces from a confirm that lands
  // after the manager released/reassigned the slot mid-scan (see page.tsx's
  // 409 no_claimed_pallet handling). Same underlying situation, same copy.
  no_claimed_pallet: 'split.palletReleased',
  nothing_to_close: 'split.error.nothingToClose',
  target_not_on_this_job: 'split.error.targetNotOnThisJob',
  // The job already finished (a completing action — e.g. a teammate's
  // close_short — landed between this screen's last poll and the tap).
  // /api/pallet-claim now rejects every action once session.status is
  // 'completed' (C2 in the final review); this keeps that rejection from
  // ever surfacing as a raw code.
  session_already_completed: 'split.error.sessionAlreadyCompleted',
};

/** Exported so page.tsx can reuse the same table for errors that arrive via
 *  the completion routes rather than this screen's own /api/pallet-claim calls. */
export { CLAIM_ERROR_KEYS as SPLIT_CLAIM_ERROR_KEYS };

export function splitErrorKey(reason: string | null | undefined): TranslationKey {
  if (reason && Object.prototype.hasOwnProperty.call(CLAIM_ERROR_KEYS, reason)) {
    return CLAIM_ERROR_KEYS[reason];
  }
  return 'split.error.generic';
}

export default function SplitJobScreen({ session, workerChatId, onClaimed, onRefresh }: Props) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots = session.pallets ?? [];
  const mine = slots.filter((p) => p.owner === workerChatId);
  const myDone = mine.filter((p) => p.status === 'done').length;
  const open = slots.filter((p) => p.status === 'open').length;
  const doneAll = slots.filter((p) => p.status === 'done').length;
  const iHoldOne = mine.some((p) => p.status === 'claimed');

  // Add-pallet only when the plan is exhausted and this worker is free —
  // otherwise a worker mid-pallet could silently inflate the delivery.
  const canAdd = open === 0 && !iHoldOne;
  // Close-short only when slots remain but this worker holds none. The API
  // rejects it outright if ANY worker still holds one.
  const canCloseShort = open > 0 && !iHoldOne;
  const looseOpen = session.loose?.status === 'open';

  async function act(action: ClaimAction) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/pallet-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token, worker_chat_id: workerChatId, action }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? 'internal');
        return;
      }
      if ((action === 'next' || action === 'add') && data.slot) {
        onClaimed(data.slot.n as number);
        return;
      }
      await onRefresh();
    } catch {
      // Dropped connection / non-JSON error page (502 etc.) — fetch or
      // res.json() threw before setError above ever ran. Without this, busy
      // resets and the button just looks like it did nothing on the exact
      // network conditions (warehouse Wi-Fi) where this is the common case,
      // not the rare one. 'network_error' isn't a key in CLAIM_ERROR_KEYS,
      // so splitErrorKey falls back to the generic retry message.
      setError('network_error');
    } finally {
      setBusy(false);
    }
  }

  // Manual + polled recovery from a stale session. reserved_for_others /
  // no_open_slots can leave the worker with NO tappable action (see
  // nextDisabled below) — the pool count they're looking at was correct only
  // at render time. Clearing `error` here is deliberate: once onRefresh()
  // lands a fresh session, `open`/`canAdd`/`canCloseShort` are recomputed
  // from real data, so the stale error code has nothing left to add — and if
  // the fresh pool is genuinely still empty, the "0 pallets available" pool
  // heading already says so.
  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRefresh();
    } catch {
      // Best-effort, same as the parent's reloadSession — keep showing the
      // last-known session rather than surface an error for a background poll.
    } finally {
      setBusy(false);
    }
  }, [busy, onRefresh]);

  // Modest poll so a worker who never notices they're stuck still recovers.
  // Re-created (and its interval reset) whenever `busy` flips — harmless,
  // since it also means the check below is never reading a stale value.
  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
    }, 12000);
    return () => clearInterval(id);
  }, [refresh]);

  // The claim API's own failure reasons already gate the next attempt (a
  // repeat tap after reserved_for_others/no_open_slots would just fail
  // again); open === 0 is the same fact known ahead of any click, so the
  // button is disabled before the worker ever wastes a round trip on it.
  // Tapping refresh (below) clears `error`, so this never strands the
  // worker — only a genuinely empty pool (open === 0) keeps it disabled.
  const nextDisabled =
    busy || open === 0 || error === 'reserved_for_others' || error === 'no_open_slots';

  const mineSorted = [...mine].sort((a, b) => a.n - b.n);

  return (
    <div className="h-dvh flex flex-col bg-canvas overflow-hidden">
      <div className="flex-none px-4 pt-4 pb-3 border-b border-[#101821] bg-header safe-top">
        <div className="text-[15px] font-extrabold text-ink-inverse">{tr('split.jobTitle')}</div>
        {session.document_number && (
          <div className="text-[11px] font-semibold text-ink-muted mt-[2px]" dir="ltr">
            {session.document_number}
          </div>
        )}
        <div className="flex items-center gap-3 mt-3">
          <div className="flex-1 bg-sunken border border-line rounded-[11px] px-3 py-[10px] text-center">
            <div className="text-[16px] font-black text-ink-inverse" dir="ltr">
              {doneAll}/{slots.length}
            </div>
            <div className="text-[9px] font-bold text-ink-muted mt-[2px]">{tr('split.deliveryProgress')}</div>
          </div>
          <div className="flex-1 bg-sunken border border-line rounded-[11px] px-3 py-[10px] text-center">
            <div className="text-[16px] font-black text-ink-inverse" dir="ltr">
              {myDone}
            </div>
            <div className="text-[9px] font-bold text-ink-muted mt-[2px]">{tr('split.yoursDone')}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        {error && (
          <div className="flex items-center gap-2 bg-danger-weak border border-danger/30 rounded-[11px] px-3 py-[10px] text-[12px] font-semibold text-danger-weak-ink">
            <MI name="report_problem" size={16} className="flex-none" />
            <span>{tr(splitErrorKey(error))}</span>
          </div>
        )}

        {/* Own pallets */}
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-extrabold text-ink-muted px-1">{tr('split.yourPallets')}</div>
          {mineSorted.length === 0 ? (
            <div className="flex flex-col items-center gap-2 bg-raised border border-line rounded-[13px] px-3 py-[18px] text-center">
              <MI name="pallet" size={26} className="text-ink-muted" />
              <div className="text-[12px] font-semibold text-ink-muted">{tr('split.noOwnPallets')}</div>
            </div>
          ) : (
            mineSorted.map((p) => (
              <div
                key={p.n}
                className="flex items-center gap-3 bg-raised border border-line rounded-[13px] px-3 py-[11px]"
              >
                <span className="flex-none w-8 h-8 rounded-[9px] bg-tile border border-line flex items-center justify-center font-mono font-black text-[13px] text-[#e8eef2]">
                  {p.n}
                </span>
                <div className="flex-1 min-w-0">
                  {p.status === 'done' && p.lpn ? (
                    <span className="font-mono text-[12px] font-bold text-ink-inverse block truncate" dir="ltr">
                      {p.lpn}
                    </span>
                  ) : (
                    <span className="text-[12px] font-bold text-ink-inverse">{tr('split.palletInProgress')}</span>
                  )}
                </div>
                <span
                  className="flex-none px-2 py-[3px] rounded-full text-[10px] font-extrabold whitespace-nowrap"
                  style={
                    p.status === 'done'
                      ? { background: 'var(--ok-weak)', color: 'var(--ok-weak-ink)' }
                      : { background: 'var(--brand-weak)', color: 'var(--brand-weak-ink)' }
                  }
                >
                  {tr(p.status === 'done' ? 'split.palletDone' : 'split.palletInProgress')}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Pool + actions */}
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-extrabold text-ink-muted px-1">
            {tr('split.poolAvailable', { count: open })}
          </div>

          <button
            onClick={() => act('next')}
            disabled={nextDisabled}
            className="w-full py-[13px] rounded-[13px] font-extrabold text-[14px] bg-brand text-ink-inverse disabled:bg-sunken disabled:text-ink-muted flex items-center justify-center gap-2 tap-target"
          >
            {busy && <MI name="autorenew" size={18} className="animate-spin" />}
            {tr('split.takeNext')}
          </button>

          {/* Always rendered — the one action guaranteed to be tappable even
              when reserved_for_others/no_open_slots (or a teammate holding
              the last slot) leaves every other button above disabled. */}
          <button
            onClick={() => void refresh()}
            disabled={busy}
            className="w-full py-[13px] rounded-[13px] font-extrabold text-[13px] border border-line text-ink-muted disabled:opacity-50 flex items-center justify-center gap-2 tap-target"
          >
            <MI name="refresh" size={16} className={busy ? 'animate-spin' : undefined} />
            {tr('split.refresh')}
          </button>

          {looseOpen && (
            <button
              onClick={() => act('take_loose')}
              disabled={busy}
              className="w-full py-[13px] rounded-[13px] font-extrabold text-[14px] border border-line bg-tile text-ink-inverse disabled:opacity-50 flex items-center justify-center gap-2 tap-target"
            >
              <MI name="inventory_2" size={18} />
              {tr('split.takeLoose', { count: session.loose?.count ?? 0 })}
            </button>
          )}

          {canAdd && (
            <button
              onClick={() => act('add')}
              disabled={busy}
              className="w-full py-[13px] rounded-[13px] font-extrabold text-[14px] border border-line bg-tile text-ink-inverse disabled:opacity-50 flex items-center justify-center gap-2 tap-target"
            >
              <MI name="add" size={18} />
              {tr('split.addPallet')}
            </button>
          )}

          {canCloseShort && (
            <button
              onClick={() => act('close_short')}
              disabled={busy}
              className="w-full py-[13px] rounded-[13px] font-extrabold text-[13px] border border-line text-ink-muted disabled:opacity-50 tap-target"
            >
              {tr('split.closeShort')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
