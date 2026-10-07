'use client';

/**
 * פריוריטי — the automatic Priority push, as a status row on the all-done card.
 *
 * Deliberately NOT a button: sending the goods receipt to Priority needs no
 * step from the worker (the bot closes the delivery at the last LPN, our DB
 * trigger queues it, the pg_cron dispatcher sends it). This row only says
 * where that stands, and changes by itself:
 *   - polls GET /api/priority-status every 4 s for 3 minutes, then every
 *     30 s; pauses while the tab is hidden and picks up again on return;
 *   - stops once the state cannot change by itself (received, test user,
 *     push switched off …; failed / expired only once the office alert is
 *     on record) or the session expires.
 *
 * Colour + icon per state (lib/priority-status.ts has the rules): green =
 * in Priority, blue = on its way, amber = needs attention, red = failed,
 * grey = nothing will happen by itself. The worker is never asked to do
 * anything about Priority: the database alerts the office, and the row says
 * "the office has it" only once that alert is stamped on the outbox row.
 */

import { useEffect, useState } from 'react';
import { MI } from './MI';
import { useT, type TranslationKey } from '@/lib/i18n';
import {
  nextPollDelay,
  shouldStopPolling,
  type PriorityState,
  type PriorityStatus,
} from '@/lib/priority-status';

type Tone = 'brand' | 'ok' | 'warn' | 'danger' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  brand: 'bg-brand-weak border-brand/30 text-brand-weak-ink',
  ok: 'bg-ok-weak border-ok/30 text-ok-weak-ink',
  warn: 'bg-warn-weak border-warn/30 text-warn-weak-ink',
  danger: 'bg-danger-weak border-danger/30 text-danger-weak-ink',
  muted: 'bg-sunken border-line text-ink-muted',
};

const LOOK: Record<PriorityState, { icon: string; tone: Tone; busy?: boolean }> = {
  checking: { icon: 'cloud_sync', tone: 'muted', busy: true },
  closing: { icon: 'cloud_sync', tone: 'brand', busy: true },
  sending: { icon: 'cloud_sync', tone: 'brand', busy: true },
  awaiting: { icon: 'schedule', tone: 'brand' },
  received: { icon: 'check_circle', tone: 'ok' },
  already: { icon: 'check_circle', tone: 'ok' },
  unconfirmed: { icon: 'sync_problem', tone: 'warn' },
  noWriteback: { icon: 'sync_problem', tone: 'warn' },
  waitingPo: { icon: 'receipt_long', tone: 'warn' },
  waiting: { icon: 'report_problem', tone: 'warn' },
  cancelled: { icon: 'report_problem', tone: 'warn' },
  failed: { icon: 'error', tone: 'danger' },
  expired: { icon: 'error', tone: 'danger' },
  held: { icon: 'pause_circle', tone: 'muted' },
  test: { icon: 'info', tone: 'muted' },
  off: { icon: 'cloud_off', tone: 'muted' },
  unknown: { icon: 'help_outline', tone: 'muted' },
};

const TEXT: Record<Exclude<PriorityState, 'received' | 'waiting'>, TranslationKey> = {
  checking: 'priority.checking',
  closing: 'priority.closing',
  sending: 'priority.sending',
  awaiting: 'priority.awaiting',
  unconfirmed: 'priority.unconfirmed',
  noWriteback: 'priority.noWriteback',
  already: 'priority.already',
  waitingPo: 'priority.waitingPo',
  cancelled: 'priority.cancelled',
  failed: 'priority.failed',
  expired: 'priority.expired',
  held: 'priority.held',
  test: 'priority.test',
  off: 'priority.off',
  unknown: 'priority.unknown',
};

const WAITING_TEXT: Record<NonNullable<PriorityStatus['reason']>, TranslationKey> = {
  items: 'priority.waitingItems',
  supplier: 'priority.waitingSupplier',
  nothing: 'priority.waitingNothing',
  other: 'priority.waitingOther',
};

/** The line once the office alert is on record (status.office). */
const OFFICE_TEXT: Partial<Record<PriorityState, TranslationKey>> = {
  failed: 'priority.failedOffice',
  unconfirmed: 'priority.unconfirmedOffice',
  expired: 'priority.expiredOffice',
  held: 'priority.heldOffice',
};

/** At most this many unmapped item codes are listed; the rest are counted. */
const MAX_CODES = 6;

function messageKey(status: PriorityStatus): TranslationKey {
  switch (status.state) {
    case 'received':
      return status.final ? 'priority.receivedFinal' : 'priority.received';
    case 'waiting':
      return WAITING_TEXT[status.reason ?? 'other'] ?? WAITING_TEXT.other;
    default:
      return (status.office ? OFFICE_TEXT[status.state] : undefined) ?? TEXT[status.state] ?? TEXT.unknown;
  }
}

export function PriorityPushStatus({ token }: { token: string }) {
  const tr = useT();
  const [status, setStatus] = useState<PriorityStatus>({ state: 'checking' });

  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const openedAt = Date.now();

    const schedule = () => {
      if (cancelled || stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, nextPollDelay(Date.now() - openedAt));
    };

    async function poll() {
      timer = null;
      if (cancelled || stopped || inFlight) return;
      // Hidden tab: no timer; the visibilitychange listener resumes it.
      if (document.hidden) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/priority-status?token=${encodeURIComponent(token)}`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (res.status === 401) {
          // Session expired: nothing more can be learned from this page.
          stopped = true;
          setStatus((prev) => (prev.state === 'checking' ? { state: 'unknown' } : prev));
          return;
        }
        if (!res.ok) return; // transient — try again on the next tick
        const data = await res.json();
        if (cancelled || !data?.success || typeof data.state !== 'string') return;
        const next: PriorityStatus = {
          state: data.state in LOOK ? (data.state as PriorityState) : 'unknown',
          docno: typeof data.docno === 'string' ? data.docno : undefined,
          final: data.final === true,
          reason: data.reason,
          codes: Array.isArray(data.codes)
            ? data.codes.filter((c: unknown): c is string => typeof c === 'string')
            : undefined,
          office: data.office === true,
        };
        setStatus(next);
        if (shouldStopPolling(next)) stopped = true;
      } catch {
        // Network blip — the next tick tries again.
      } finally {
        inFlight = false;
        schedule();
      }
    }

    const onVisibility = () => {
      if (document.hidden || cancelled || stopped) return;
      if (timer) clearTimeout(timer);
      void poll();
    };

    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token]);

  const look = LOOK[status.state] ?? LOOK.unknown;
  const codes = status.state === 'waiting' && status.reason === 'items' ? status.codes ?? [] : [];
  const shownCodes = codes.slice(0, MAX_CODES);
  const moreCodes = codes.length - shownCodes.length;

  return (
    <div className="mt-4" role="status" aria-live="polite">
      <div className="text-[9px] font-extrabold text-[#cbd5e1] tracking-[2px] mb-2">
        {tr('priority.heading')}
      </div>
      <div className={`flex items-start gap-2 border rounded-[11px] px-3 py-[10px] ${TONE_CLASS[look.tone]}`}>
        <MI
          name={look.icon}
          size={18}
          className={`flex-none mt-[1px] ${look.busy ? 'motion-safe:animate-pulse' : ''}`}
        />
        <div className="flex-1 min-w-0 text-[12px] font-semibold leading-[1.4] break-words">
          {tr(messageKey(status), { docno: status.docno ?? '' })}
          {shownCodes.length > 0 && (
            <div className="mt-[6px] flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-bold opacity-80">{tr('priority.codesLabel')}:</span>
              {shownCodes.map((code) => (
                <span
                  key={code}
                  dir="ltr"
                  className="font-mono text-[10px] font-bold bg-[rgba(0,0,0,.25)] rounded-[5px] px-[5px] py-[1px] break-all"
                >
                  {code}
                </span>
              ))}
              {moreCodes > 0 && (
                <span dir="ltr" className="font-mono text-[10px] font-bold">+{moreCodes}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
