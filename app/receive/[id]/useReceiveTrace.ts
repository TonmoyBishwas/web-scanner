'use client';

/**
 * The receive form's trace, wired to the page (2026-10-28). See
 * lib/receive-trace.ts for what is recorded and why; this hook owns the
 * browser side — the DOM listeners (focus / tap → which line, tab hidden,
 * scroll end, page hide), the debounce timer, and the sink that posts to
 * /api/receipt-form/{id}/events. Nothing it does is visible to the worker,
 * and every entry point swallows its own errors: tracing never breaks the form.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { initialDraft, type FormDraft, type FormLine, type LineDraft, type LineError } from '@/lib/receipt-form';
import {
  ReceiveTracker,
  areaOfId,
  changedLineCount,
  errorCounts,
  searchPayload,
  type Area,
  type ReceiveEvent,
  type ReceiveEventName,
} from '@/lib/receive-trace';
import { createReceiveTraceSink, type ReceiveTraceSink } from '@/lib/receive-trace-client';

const TICK_MS = 500;
const SEARCH_SETTLE_MS = 1000;
const SCROLL_SETTLE_MS = 1200;

function safe(fn: () => void): void {
  try { fn(); } catch { /* tracing must never break the form */ }
}

/** The form area an element belongs to: the nearest ancestor with a known id or role. */
function areaOf(target: EventTarget | null): Area | null {
  let el = target instanceof Element ? target : null;
  for (let depth = 0; el && depth < 30; depth += 1, el = el.parentElement) {
    const a = areaOfId(el.id);
    if (a !== null) return a;
    const role = el.getAttribute('role');
    if (role === 'search') return 'search';
    if (role === 'tablist') return 'tabs';
    if (el.tagName === 'FOOTER') return 'footer';
    if (el.tagName === 'MAIN') return 'other';
  }
  return null;
}

/** The first note line whose card is (at least partly) below the top of the screen. */
function topLine(): number | null {
  const cards = document.querySelectorAll<HTMLElement>('section[id^="line-"]');
  for (const c of cards) {
    if (c.getBoundingClientRect().bottom > 0) {
      const n = Number(c.id.slice(5));
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function navigationType(): string {
  try {
    return (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type || 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface ReceiveTraceApi {
  lineEdit(index: number, patch: Partial<LineDraft>): void;
  palletsEdit(value: string): void;
  extraEdit(key: string, patch: { name?: string; quantity?: string; unit?: string }): void;
  /** Any other `receive_*` event (tab, bulk tool, next, lines added, outcome, step...). */
  event(event: ReceiveEventName, data?: Record<string, unknown>): void;
  /** Before a save: the pending field change goes first. Returns the start time for saveDone. */
  saveAttempt(data: Record<string, unknown>): number;
  saveDone(started: number, ok: boolean, data: Record<string, unknown>): void;
}

export function useReceiveTrace(opts: {
  formId: string;
  exp: string;
  sig: string;
  lines: FormLine[];
  draft: FormDraft;
  /** Validation errors by line index (the form's live check). */
  lineErrors: Record<number, LineError[]>;
  formErrors: readonly string[];
  /** Draft restored (or not) — line completion is baselined after it. */
  restored: boolean;
  query: string;
  search: { active: boolean; fuzzy?: boolean; lines: readonly Pick<FormLine, 'index'>[] };
}): ReceiveTraceApi {
  const { formId, exp, sig, lines, draft, lineErrors, formErrors, restored, query, search } = opts;
  // The latest render's values for the handlers and timers below (updated
  // after commit, before any event handler runs).
  const linesRef = useRef(lines);
  const draftRef = useRef(draft);
  const errorsRef = useRef(lineErrors);
  const formErrorsRef = useRef(formErrors);
  const searchRef = useRef(search);
  const linkRef = useRef({ formId, exp, sig });
  useLayoutEffect(() => {
    linesRef.current = lines;
    draftRef.current = draft;
    errorsRef.current = lineErrors;
    formErrorsRef.current = formErrors;
    searchRef.current = search;
  });

  const sinkRef = useRef<ReceiveTraceSink | null>(null);
  const trackerRef = useRef<ReceiveTracker | null>(null);

  const api = useMemo<ReceiveTraceApi>(() => {
    const t = () => trackerRef.current;
    const push = (e: ReceiveEvent) => safe(() => sinkRef.current?.push(e));
    return {
      lineEdit(index, patch) {
        safe(() => {
          const before = draftRef.current.lines.find((l) => l.index === index);
          t()?.lineEdit(index, before, patch, Date.now());
        });
      },
      palletsEdit(value) {
        safe(() => t()?.formEdit('pallets', 'pallets', draftRef.current.pallets, value, Date.now()));
      },
      extraEdit(key, patch) {
        safe(() => {
          const x = draftRef.current.extras.find((e) => e.key === key);
          const now = Date.now();
          if (patch.name !== undefined) t()?.formEdit(`extra:${key}`, 'extra_name', x?.name ?? '', patch.name, now);
          if (patch.quantity !== undefined) t()?.formEdit(`extra:${key}`, 'extra_qty', x?.quantity ?? '', patch.quantity, now);
          if (patch.unit !== undefined) t()?.formEdit(`extra:${key}`, 'extra_unit', x?.unit ?? '', patch.unit, now);
        });
      },
      event(event, data) {
        push({ kind: 'ui', event, data });
      },
      saveAttempt(data) {
        const now = Date.now();
        safe(() => {
          const tr = t();
          tr?.cut();
          const d = draftRef.current;
          push({
            kind: 'ui',
            event: 'receive_save_attempt',
            data: {
              lines: linesRef.current.length,
              // Lines whose answer differs from what the note pre-filled.
              lines_changed: changedLineCount(initialDraft(linesRef.current), d),
              extras: d.extras.length,
              pallets: d.pallets.trim() || null,
              ...(tr ? tr.summary(now) : {}),
              ...data,
            },
          });
          sinkRef.current?.flush();
        });
        return now;
      },
      saveDone(started, ok, data) {
        safe(() => {
          push({
            kind: 'ui',
            event: ok ? 'receive_save_ok' : 'receive_save_error',
            data: { ms: Date.now() - started, ...data },
          });
          if (data.error === 'invalid') {
            push({
              kind: 'ui',
              event: 'receive_validation_error',
              data: { at: 'server', form: [...formErrorsRef.current], by_code: errorCounts(errorsRef.current) },
            });
          }
          sinkRef.current?.flush();
        });
      },
    };
  }, []);

  // Sink + tracker, the page load, and the DOM listeners — once. The refs
  // survive a dev StrictMode re-mount, so the load is recorded once.
  useEffect(() => {
    if (!trackerRef.current) {
      safe(() => {
        const s = createReceiveTraceSink(linkRef.current);
        sinkRef.current = s;
        trackerRef.current = new ReceiveTracker({
          start: Date.now(),
          lineOf: (i) => linesRef.current.find((l) => l.index === i),
          errorsOf: (i) => errorsRef.current[i] ?? [],
          emit: (e: ReceiveEvent) => s.push(e),
        });
        const ls = linesRef.current;
        s.push({
          kind: 'lifecycle',
          event: 'receive_load',
          data: {
            load_id: s.loadId,
            lines: ls.length,
            needs_expiry: ls.filter((l) => l.needs_expiry).length,
            navigation: navigationType(),
            viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
            online: navigator.onLine,
          },
        });
      });
    }
    const tracker = trackerRef.current;
    const sink = sinkRef.current;
    if (!tracker || !sink) return;
    let scrollTimer: number | null = null;
    let lastScrollY = window.scrollY;

    const onInteract = (e: Event) => safe(() => {
      const a = areaOf(e.target);
      if (a !== null) tracker.focus(a, Date.now());
    });
    const onVisibility = () => safe(() => {
      const visible = document.visibilityState === 'visible';
      tracker.visibility(visible, Date.now());
      if (!visible) sink.beacon();
    });
    const onPageHide = () => safe(() => {
      const now = Date.now();
      tracker.cut();
      tracker.leave(now);
      sink.push({ kind: 'lifecycle', event: 'receive_pagehide', data: tracker.summary(now) });
      sink.beacon();
    });
    const onScroll = () => {
      if (scrollTimer !== null) window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => safe(() => {
        scrollTimer = null;
        const y = window.scrollY;
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        sink.push({
          kind: 'ui',
          event: 'receive_scroll',
          data: { y_pct: Math.round((y / max) * 100), dir: y >= lastScrollY ? 'down' : 'up', top_line: topLine() },
        });
        lastScrollY = y;
      }), SCROLL_SETTLE_MS);
    };
    const tick = window.setInterval(() => safe(() => {
      if (tracker.hasPending()) tracker.tick(Date.now());
    }), TICK_MS);

    document.addEventListener('focusin', onInteract, true);
    // A tap (not a scroll — no click fires for one): buttons do not take focus on iOS.
    document.addEventListener('click', onInteract, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearInterval(tick);
      if (scrollTimer !== null) window.clearTimeout(scrollTimer);
      document.removeEventListener('focusin', onInteract, true);
      document.removeEventListener('click', onInteract, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Lines becoming complete (the first call, after the stored draft is restored, is the baseline).
  useEffect(() => {
    if (!restored) return;
    safe(() => {
      const ready = new Set(lines.filter((l) => !(lineErrors[l.index]?.length)).map((l) => l.index));
      trackerRef.current?.readyLines(ready, Date.now(), lines.length);
    });
  }, [restored, lines, lineErrors]);

  // The search, once the typing settles (a clear is recorded at once).
  const lastQuery = useRef('');
  useEffect(() => {
    const q = query.trim();
    if (q === lastQuery.current) return;
    const id = window.setTimeout(() => safe(() => {
      lastQuery.current = q;
      sinkRef.current?.push({
        kind: 'ui',
        event: 'receive_search',
        data: q ? searchPayload(q, searchRef.current, linesRef.current.length) : { cleared: true },
      });
    }), q ? SEARCH_SETTLE_MS : 0);
    return () => window.clearTimeout(id);
  }, [query]);

  return api;
}
