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
 * The worker is never asked to do anything about Priority: the database
 * alerts the office, and the row says "the office has it" only once that
 * alert is stamped on the outbox row.
 *
 * Mevaser 21/10 (text sweep, table E): the worker's line is calm and
 * "done first". In Hebrew every state reads "✅ תעודה {document_number}
 * נקלטה. תודה! אפשר להמשיך." (note received, thanks, carry on), and the
 * office-on-record states "… המשרד ישלים את השאר …" (the office will
 * complete the rest). No system name, no heading, no item codes, no red or
 * amber: green while all is well, grey when the office has something to do.
 * The English lines keep the detailed Priority states.
 */

import { useEffect, useState } from 'react';
import { useT, type TranslationKey } from '@/lib/i18n';
import {
  nextPollDelay,
  shouldStopPolling,
  type PriorityState,
  type PriorityStatus,
} from '@/lib/priority-status';

type Tone = 'brand' | 'ok' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  brand: 'bg-brand-weak border-brand/30 text-brand-weak-ink',
  ok: 'bg-ok-weak border-ok/30 text-ok-weak-ink',
  muted: 'bg-sunken border-line text-ink-muted',
};

/** Calm on purpose (Mevaser 21/10, rule 4): never red or amber on the worker's
 *  card. Grey = the office has something to complete or check. */
const LOOK: Record<PriorityState, { tone: Tone }> = {
  checking: { tone: 'ok' },
  closing: { tone: 'ok' },
  sending: { tone: 'ok' },
  awaiting: { tone: 'ok' },
  received: { tone: 'ok' },
  already: { tone: 'ok' },
  unconfirmed: { tone: 'muted' },
  noWriteback: { tone: 'muted' },
  waitingPo: { tone: 'brand' },
  waiting: { tone: 'muted' },
  cancelled: { tone: 'muted' },
  failed: { tone: 'muted' },
  expired: { tone: 'muted' },
  held: { tone: 'muted' },
  test: { tone: 'ok' },
  off: { tone: 'ok' },
  unknown: { tone: 'ok' },
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

export function PriorityPushStatus({ token, documentNumber }: { token: string; documentNumber?: string }) {
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
  // Empty in Hebrew: the worker never reads the system's name.
  const heading = tr('priority.heading');

  return (
    <div className="mt-4" role="status" aria-live="polite">
      {heading && (
        <div className="text-[9px] font-extrabold text-[#cbd5e1] tracking-[2px] mb-2">
          {heading}
        </div>
      )}
      <div className={`border rounded-[11px] px-3 py-[10px] ${TONE_CLASS[look.tone]}`}>
        <div className="min-w-0 text-[12px] font-semibold leading-[1.4] break-words">
          {tr(messageKey(status), { docno: status.docno ?? '', document_number: documentNumber || '—' })}
        </div>
      </div>
    </div>
  );
}
