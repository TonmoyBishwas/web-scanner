'use client';

/**
 * Receive form v3, the status screen (states 20, 21; spec 8.3–8.5).
 *
 * With ERP: "שומר את הקליטה" → "שולח לפריוריטי" → "נקלט בפריוריטי" (+ the GR
 * line), animated circles and connectors; without ERP: "שומר את הקליטה" →
 * "נקלט במלאי". Then "תודה! חוזרים לוואטסאפ…" with the 3 s bar, and "סגרו".
 *
 * `useStatusFlow` owns the timings: each step at least 600 ms, 400 ms between
 * steps, the status endpoint polled every 3 s from step 2, a timeout 120 s
 * after step 2 started, and the final state 600 ms after step 3 starts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { V3, type V3Erp, type V3Outcome, type V3StatusResponse } from '@/lib/receive-v3';
import { EO, I, P, font } from './tokens';
import type { Tr } from './texts';
import css from './v3.module.css';

// ── The flow ─────────────────────────────────────────────────────────────

export interface StatusSx {
  /** The step that is active (when not final). */
  phase: number;
  /** The last step done (-1 = none). */
  done: number;
  final: boolean;
}

export type FinalOutcome = Exclude<V3Outcome, 'pending'>;

export interface StatusFlow {
  sx: StatusSx;
  outcome: FinalOutcome | null;
  docno: string | null;
  officeLines: number | null;
  /** Steps up to this index render in their final look without animation (a reopened form). */
  stillUpTo: number;
  /** The tap on "אישור ושליחה": step 1 active. */
  start: () => void;
  /** The save answered 200: step 1 done (≥ 600 ms after start), then the rest. */
  saved: () => void;
  /** A reopened done form (8.5): step 1 already done; one status read decides the rest. */
  resume: (submittedAt: string | null) => void;
}

export function useStatusFlow({
  erp,
  fetchStatus,
  onFinal,
}: {
  erp: V3Erp;
  fetchStatus: () => Promise<V3StatusResponse | null>;
  /** The final state is on screen (resumed = a reopened form, shown at once). */
  onFinal: (outcome: FinalOutcome, resumed: boolean) => void;
}): StatusFlow {
  const [sx, setSx] = useState<StatusSx>({ phase: 0, done: -1, final: false });
  const [outcome, setOutcome] = useState<FinalOutcome | null>(null);
  const [docno, setDocno] = useState<string | null>(null);
  const [officeLines, setOfficeLines] = useState<number | null>(null);
  const [stillUpTo, setStillUpTo] = useState(-1);
  const timers = useRef<number[]>([]);
  const alive = useRef(true);
  const t0 = useRef(0);
  const step2At = useRef(0);
  const fetchRef = useRef(fetchStatus);
  const finalRef = useRef(onFinal);
  useEffect(() => {
    fetchRef.current = fetchStatus;
    finalRef.current = onFinal;
  });

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(() => alive.current && fn(), Math.max(0, ms)));
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clear();
    };
  }, []);

  const showFinal = useCallback((o: FinalOutcome, res: V3StatusResponse | null, resumed: boolean) => {
    const ok = o === 'success' || o === 'partial';
    setOutcome(o);
    setDocno(ok ? (res?.docno ?? null) : null);
    setOfficeLines(o === 'partial' ? (res?.office_lines ?? null) : null);
    setSx({ phase: 2, done: ok ? 2 : 1, final: true });
    finalRef.current(o, resumed);
  }, []);

  /** Step 2 ended with `o`: done (≥ 600 ms), 400 ms, step 3 active, 600 ms, final. */
  const endStep2 = useCallback(
    (o: FinalOutcome, res: V3StatusResponse | null) => {
      const wait = V3.MIN_STEP_MS - (Date.now() - step2At.current);
      later(wait, () => {
        setSx({ phase: 1, done: 1, final: false });
        later(V3.STEP_GAP_MS, () => {
          setSx({ phase: 2, done: 1, final: false });
          later(V3.MIN_STEP_MS, () => showFinal(o, res, false));
        });
      });
    },
     
    [showFinal],
  );

  /** Poll the status every 3 s until an outcome, or the 120 s timeout. */
  const pollFrom = useCallback(
    (resumed: boolean) => {
      const tick = async () => {
        let res: V3StatusResponse | null = null;
        try {
          res = await fetchRef.current();
        } catch {
          res = null;
        }
        if (!alive.current) return;
        if (res && res.outcome !== 'pending') {
          if (resumed) showFinal(res.outcome, res, false);
          else endStep2(res.outcome, res);
          return;
        }
        if (Date.now() - step2At.current >= V3.PRIORITY_TIMEOUT_MS) {
          if (resumed) showFinal('timeout', null, false);
          else endStep2('timeout', null);
          return;
        }
        later(V3.STATUS_POLL_MS, () => void tick());
      };
      void tick();
    },
     
    [endStep2, showFinal],
  );

  const start = useCallback(() => {
    clear();
    t0.current = Date.now();
    setStillUpTo(-1);
    setOutcome(null);
    setDocno(null);
    setOfficeLines(null);
    setSx({ phase: 0, done: -1, final: false });
  }, []);

  const saved = useCallback(() => {
    const wait = V3.MIN_STEP_MS - (Date.now() - t0.current);
    later(wait, () => {
      setSx({ phase: 0, done: 0, final: false });
      later(V3.STEP_GAP_MS, () => {
        setSx({ phase: 1, done: 0, final: false });
        step2At.current = Date.now();
        if (erp === 'none') {
          later(V3.MIN_STEP_MS, () => {
            setOutcome('success');
            setSx({ phase: 1, done: 1, final: true });
            finalRef.current('success', false);
          });
          return;
        }
        pollFrom(false);
      });
    });
     
  }, [erp, pollFrom]);

  const resume = useCallback(
    (submittedAt: string | null) => {
      clear();
      if (erp === 'none') {
        setStillUpTo(1);
        setOutcome('success');
        setSx({ phase: 1, done: 1, final: true });
        finalRef.current('success', true);
        return;
      }
      setStillUpTo(0);
      setSx({ phase: 1, done: 0, final: false });
      const at = submittedAt ? Date.parse(submittedAt) : NaN;
      step2At.current = Number.isFinite(at) ? at : Date.now();
      void (async () => {
        let res: V3StatusResponse | null = null;
        try {
          res = await fetchRef.current();
        } catch {
          res = null;
        }
        if (!alive.current) return;
        // The 120 s timeout counts from the save; the first read says when that was.
        if (!Number.isFinite(at) && res?.submitted_at) {
          const a2 = Date.parse(res.submitted_at);
          if (Number.isFinite(a2)) step2At.current = a2;
        }
        if (res && res.outcome !== 'pending') {
          setStillUpTo(2);
          showFinal(res.outcome, res, true);
          return;
        }
        if (Date.now() - step2At.current >= V3.PRIORITY_TIMEOUT_MS) {
          setStillUpTo(2);
          showFinal('timeout', null, true);
          return;
        }
        later(V3.STATUS_POLL_MS, () => pollFrom(true));
      })();
    },
     
    [erp, pollFrom, showFinal],
  );

  return { sx, outcome, docno, officeLines, stillUpTo, start, saved, resume };
}

// ── The redirect block (shared with the notices) ─────────────────────────

export function RedirectBlock({ redirectKey, rtl, tr }: { redirectKey: number; rtl: boolean; tr: Tr }) {
  return (
    <div data-anim="redirect" className={css.fadeIn200} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ font: font(500, 17), color: P.ink }}>{tr('receive.v3.returning')}</div>
      <div style={{ height: 3, borderRadius: 2, background: P.line, overflow: 'hidden' }}>
        <div
          key={redirectKey}
          className={css.countdown}
          style={{ height: '100%', background: P.ink, transformOrigin: rtl ? 'right center' : 'left center' }}
        />
      </div>
    </div>
  );
}

// ── The screen ───────────────────────────────────────────────────────────

type StepLook = 'done' | 'active' | 'wait' | 'timeout' | 'failed';

function Circle({ look, still }: { look: StepLook; still: boolean }) {
  if (look === 'done') {
    return (
      <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
        <circle cx={12} cy={12} r={12} fill={P.okFill} className={still ? undefined : css.fadeIn120} />
        <path
          d="M7 12.4l3.3 3.3L17 9"
          fill="none"
          stroke={P.okInk}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={16}
          strokeDashoffset={still ? 0 : 16}
          className={still ? undefined : css.draw}
        />
      </svg>
    );
  }
  if (look === 'active') {
    return (
      <div style={{ position: 'relative', width: 24, height: 24, flex: 'none' }}>
        <div data-halo="" className={css.halo} style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: P.ink2, opacity: 0 }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${P.ink2}`, background: P.bg }} />
        <div style={{ position: 'absolute', left: 8, top: 8, width: 8, height: 8, borderRadius: '50%', background: P.ink2 }} />
      </div>
    );
  }
  if (look === 'failed') {
    return <div className={still ? undefined : css.fadeIn200} style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', background: P.errFill }} />;
  }
  if (look === 'timeout') {
    return (
      <div
        className={still ? undefined : css.fadeIn200}
        style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', border: `2px solid ${P.ink}` }}
      />
    );
  }
  return <div style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', border: `2px solid ${P.line}` }} />;
}

function Connector({ look, still }: { look: 'done' | 'active' | 'wait'; still: boolean }) {
  const fill =
    look === 'done'
      ? { height: '100%', className: still ? undefined : css.lineDone }
      : look === 'active'
        ? { height: '50%', className: css.grow }
        : { height: 0, className: undefined };
  return (
    <div style={{ flex: 1, width: 2, minHeight: 34, margin: '4px 0', borderRadius: 1, background: P.line, position: 'relative', overflow: 'hidden' }}>
      <div key={look} className={fill.className} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: fill.height, background: P.ink2 }} />
    </div>
  );
}

/**
 * "סגרו" (to the bot's chat), marked up as the prototype's button
 * (`data-action="open-bot-chat" data-href="https://wa.me/…" data-fallback="window.close()"`).
 * With a bot number it is a real link to the chat, so it works even before
 * the page's script runs; the tap is still handled by `onClose` (the trace,
 * then wa.me, then the window.close() fallback).
 */
export function BotCloseButton({ href, label, onClose }: { href: string | null; label: string; onClose: () => void }) {
  const style = {
    height: 56,
    flex: 'none',
    border: 'none',
    borderRadius: 6,
    background: P.acc,
    color: P.accInk,
    font: font(600, 18),
  } as const;
  if (!href) {
    return (
      <button type="button" onClick={onClose} data-action="open-bot-chat" data-fallback="window.close()" style={style}>
        {label}
      </button>
    );
  }
  return (
    <a
      href={href}
      role="button"
      onClick={(e) => {
        e.preventDefault();
        onClose();
      }}
      data-action="open-bot-chat"
      data-href={href}
      data-fallback="window.close()"
      style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
    >
      {label}
    </a>
  );
}

export interface StatusScreenProps {
  supplier: string;
  invoiceNumber: string;
  erp: V3Erp;
  flow: Pick<StatusFlow, 'sx' | 'outcome' | 'docno' | 'officeLines' | 'stillUpTo'>;
  redirecting: boolean;
  redirectKey: number;
  rtl: boolean;
  tr: Tr;
  /** `https://wa.me/{n}` (botChatHref), or null: "סגרו" then only closes the tab. */
  botHref?: string | null;
  onClose: () => void;
}

export function StatusScreen(p: StatusScreenProps) {
  const { tr, erp } = p;
  const { sx, outcome, docno, officeLines, stillUpTo } = p.flow;
  const withErp = erp !== 'none';
  const labels = withErp
    ? [tr('receive.v3.stepSaving'), tr('receive.v3.erp.stepSending'), tr('receive.v3.erp.stepReceived')]
    : [tr('receive.v3.stepSaving'), tr('receive.v3.stepStock')];
  const N = labels.length;
  const finalBad = sx.final && (outcome === 'timeout' || outcome === 'failed');
  if (sx.final && withErp) {
    if (outcome === 'partial') labels[2] = tr('receive.v3.erp.partial', { n: I(officeLines ?? 0) });
    else if (outcome === 'timeout') labels[2] = tr('receive.v3.erp.timeout');
    else if (outcome === 'failed') labels[2] = tr('receive.v3.erp.failed');
  }
  // "קליטה {docno}": the GR number goes in a <bdi>, weight 500.
  const [grBefore, grAfter = ''] = tr('receive.v3.erp.grLine', { docno: '\u0000' }).split('\u0000');
  const lookOf = (i: number): StepLook =>
    i <= sx.done ? 'done' : i === N - 1 && finalBad ? (outcome as 'timeout' | 'failed') : i === sx.phase && !sx.final ? 'active' : 'wait';
  const lineLook = (i: number): 'done' | 'active' | 'wait' => (i <= sx.done ? 'done' : i === sx.phase && !sx.final ? 'active' : 'wait');

  return (
    <div data-screen="status" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingTop: 20, paddingInline: 20, paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
      <div style={{ font: font(400, 15), color: P.ink2 }}>{tr('receive.v3.statusHead', { supplier: p.supplier, n: I(p.invoiceNumber) })}</div>
      {sx.done >= 0 && (
        <div data-anim="title" className={stillUpTo >= 0 ? undefined : css.fadeIn300} style={{ marginTop: 6, font: font(600, 22, 1.35), color: P.ink, textWrap: 'pretty' }}>
          {tr('receive.v3.savedTitle')}
        </div>
      )}
      <div style={{ marginTop: 28 }}>
        <div
          data-anim="status-steps"
          key={sx.final ? 'final' : 'run'}
          role="status"
          aria-live="polite"
          className={sx.final && stillUpTo < N - 1 ? css.settle : undefined}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          {labels.map((label, i) => {
            const look = lookOf(i);
            const still = i <= stillUpTo;
            const waiting = look === 'wait';
            const showGR = withErp && i === N - 1 && sx.final && (outcome === 'success' || outcome === 'partial') && !!docno;
            return (
              <div key={i} data-step={i} data-look={look} style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
                <div style={{ width: 24, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <Circle key={`${i}${look}`} look={look} still={still} />
                  {i < N - 1 && <Connector look={lineLook(i)} still={still} />}
                </div>
                <div style={{ flex: 1, minWidth: 0, paddingBottom: i < N - 1 ? 18 : 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span
                    style={{
                      font: font(waiting ? 400 : 500, 17, 1.4),
                      color: waiting ? P.line2 : look === 'failed' ? P.errText : P.ink,
                      transition: `color 250ms ${EO}`,
                      textWrap: 'pretty',
                    }}
                  >
                    {label}
                  </span>
                  {showGR && (
                    <span className={still ? undefined : css.rise} style={{ font: font(400, 17, 1.4), color: P.ink }}>
                      {grBefore}
                      <bdi style={{ fontWeight: 500 }}>{docno}</bdi>
                      {grAfter}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 24 }}>{p.redirecting && <RedirectBlock redirectKey={p.redirectKey} rtl={p.rtl} tr={tr} />}</div>
      <div style={{ flex: 1 }} />
      <BotCloseButton href={p.botHref ?? null} label={tr('receive.v3.closeLink')} onClose={p.onClose} />
    </div>
  );
}
