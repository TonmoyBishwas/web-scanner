/**
 * Scanner trace — a per-user, server-side trail of everything a worker does
 * on a scanner page, for replaying a bug report ("at 10:42 it got stuck")
 * without the worker having to remember what they scanned, deleted or
 * refreshed.
 *
 * What it records once switched on:
 *   lifecycle  page load (+ whether it was a reload / back-forward), tab
 *              hidden/visible, page hide, online/offline
 *   phase      every phase / pallet-number change (from the page's effect)
 *   ui         explicit worker actions the pages call `trace()` for: scan
 *              accepted / refused, manual capture, OCR result, delete, edit,
 *              count, single/mix decisions, confirm, undo, identical-labels…
 *   fetch      every same-origin `/api/*` call: request body, status,
 *              response body, duration (photos stripped — see the sanitiser)
 *   console    every console.log/warn/error line (via lib/debug-log)
 *   error      unhandled errors / rejections
 *
 * Who is traced: decided by the SERVER (`GET /api/trace`) from the session
 * token → chat_id → `users.trace_enabled` / `users.trace_until`. Until the
 * answer arrives events are held in memory (so the page load and the session
 * fetch are not lost); if the answer is "no" the buffer is dropped and the
 * module goes quiet for the life of the page. Untraced users pay one small
 * GET and nothing else.
 *
 * Delivery: batches every 2 s (or at 40 events), `keepalive` POSTs, and a
 * `sendBeacon` on pagehide so the last actions before a refresh survive.
 * Never throws, never blocks the UI — a failed flush just retries.
 */
import { installDebugLogCapture, onDebugLogEntry } from '@/lib/debug-log';
import { bodyForTrace, packEventData } from '@/lib/scanner-trace-sanitize';

export type TraceKind = 'lifecycle' | 'ui' | 'phase' | 'fetch' | 'console' | 'error';

interface TraceEvent {
  ts: number;
  seq: number;
  kind: TraceKind;
  event: string;
  data?: unknown;
}

type State = 'idle' | 'pending' | 'on' | 'off';

const PENDING_CAP = 400;   // events held before the server has answered
const QUEUE_CAP = 1500;    // events queued while the network is unhappy
const FLUSH_MS = 2000;
const FLUSH_AT = 40;
const BATCH_MAX = 150;

let state: State = 'idle';
let ctx: { token: string; page: string; loadId: string; w: string } | null = null;
let queue: TraceEvent[] = [];
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let failures = 0;
let fetchWrapped = false;
const listeners = new Set<(on: boolean) => void>();

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(state === 'on'); } catch { /* ignore */ }
  }
}

/** True once the server said this user is traced. */
export function isTracing(): boolean {
  return state === 'on';
}

export function subscribeTracing(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Record one event. Safe to call before `startScannerTrace` (dropped) and
 * after the server said "off" (dropped). `data` is sanitised: photos are
 * replaced by markers, long strings truncated.
 */
export function trace(kind: TraceKind, event: string, data?: unknown): void {
  if (state === 'off' || state === 'idle') return;
  try {
    const ev: TraceEvent = { ts: Date.now(), seq: seq++, kind, event, data: packEventData(data) };
    queue.push(ev);
    const cap = state === 'pending' ? PENDING_CAP : QUEUE_CAP;
    if (queue.length > cap) queue.splice(0, queue.length - cap);
    if (state === 'on') schedule(queue.length >= FLUSH_AT ? 0 : FLUSH_MS);
  } catch { /* never let tracing break the page */ }
}

function schedule(ms: number): void {
  if (timer) {
    if (ms > 0) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => { timer = null; void flush(); }, ms);
}

function payload(events: TraceEvent[]): string {
  return JSON.stringify({
    token: ctx!.token, page: ctx!.page, load_id: ctx!.loadId, w: ctx!.w || undefined, events,
  });
}

async function flush(): Promise<void> {
  if (state !== 'on' || !ctx || inFlight || queue.length === 0) return;
  const batch = queue.slice(0, BATCH_MAX);
  inFlight = true;
  try {
    const res = await originalFetch('/api/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload(batch),
      keepalive: true,
    });
    if (!res.ok) throw new Error(`trace POST ${res.status}`);
    // Drop exactly what was sent (events may have been appended meanwhile).
    queue = queue.slice(batch.length);
    failures = 0;
  } catch {
    failures = Math.min(failures + 1, 6);
  } finally {
    inFlight = false;
  }
  if (queue.length) schedule(failures ? FLUSH_MS * 2 ** failures : 0);
}

/** Last-chance delivery when the page is going away (refresh, close, navigate). */
function flushBeacon(): void {
  if (state !== 'on' || !ctx || queue.length === 0) return;
  const batch = queue.slice(0, BATCH_MAX);
  try {
    const blob = new Blob([payload(batch)], { type: 'application/json' });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/trace', blob)) {
      queue = queue.slice(batch.length);
      return;
    }
  } catch { /* fall back below */ }
  void flush();
}

// Keep a handle to the real fetch: the wrapper must not trace its own POSTs.
const originalFetch: typeof fetch = typeof window !== 'undefined' ? window.fetch.bind(window) : fetch;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function shouldTraceUrl(url: string): boolean {
  return url.startsWith('/api/') && !url.startsWith('/api/trace');
}

function wrapFetch(): void {
  if (fetchWrapped || typeof window === 'undefined') return;
  fetchWrapped = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (state === 'off' || !shouldTraceUrl(url)) return originalFetch(input, init);
    const id = newId().slice(0, 8);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const started = performance.now();
    trace('fetch', 'request', { id, method, url, body: bodyForTrace(init?.body) });
    let res: Response;
    try {
      res = await originalFetch(input, init);
    } catch (e) {
      trace('fetch', 'network_error', {
        id, method, url, ms: Math.round(performance.now() - started),
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
      throw e;
    }
    // Read the body off a clone so the caller's stream is untouched.
    let body: unknown = undefined;
    try {
      const text = await res.clone().text();
      body = bodyForTrace(text);
    } catch {
      body = '<unreadable>';
    }
    trace('fetch', 'response', {
      id, method, url, status: res.status, ok: res.ok,
      ms: Math.round(performance.now() - started), body,
    });
    return res;
  };
}

function navigationType(): string {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav?.type || 'unknown';
  } catch {
    return 'unknown';
  }
}

function installLifecycle(): void {
  if (typeof window === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    trace('lifecycle', 'visibility', { state: document.visibilityState });
    if (document.visibilityState === 'hidden') flushBeacon();
  });
  window.addEventListener('pagehide', (e) => {
    trace('lifecycle', 'pagehide', { persisted: (e as PageTransitionEvent).persisted });
    flushBeacon();
  });
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) trace('lifecycle', 'pageshow_bfcache');
  });
  window.addEventListener('online', () => trace('lifecycle', 'online'));
  window.addEventListener('offline', () => trace('lifecycle', 'offline'));
  window.addEventListener('error', (e) => {
    trace('error', 'unhandled', { message: e.message, file: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    trace('error', 'unhandledrejection', {
      reason: r instanceof Error ? `${r.name}: ${r.message}` : String(r),
    });
  });
}

/**
 * Start tracing this page. Idempotent per page load. Call it as early as
 * possible in the page component (before the session fetch) so the load and
 * the first API call are captured.
 */
export function startScannerTrace(opts: { token: string; page: string; workerChatId?: string }): void {
  if (typeof window === 'undefined' || ctx) return;
  ctx = { token: opts.token, page: opts.page, loadId: newId(), w: opts.workerChatId || '' };
  state = 'pending';

  try {
    installDebugLogCapture();
    onDebugLogEntry((entry) => {
      if (entry.msg.startsWith('[debug-log]')) return;
      trace('console', entry.level, { msg: entry.msg });
    });
    wrapFetch();
    installLifecycle();
    trace('lifecycle', 'load', {
      url: window.location.pathname + window.location.search,
      navigation: navigationType(),
      ua: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      online: navigator.onLine,
      referrer: document.referrer || undefined,
    });
  } catch { /* tracing must never break the page */ }

  const q = new URLSearchParams({ token: opts.token });
  if (opts.workerChatId) q.set('w', opts.workerChatId);
  originalFetch(`/api/trace?${q.toString()}`)
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .then((j: { enabled?: boolean; nickname?: string }) => {
      if (j?.enabled) {
        state = 'on';
        trace('lifecycle', 'trace_on', { nickname: j.nickname });
        schedule(0);
      } else {
        state = 'off';
        queue = [];
      }
      notify();
    })
    .catch(() => {
      state = 'off';
      queue = [];
      notify();
    });
}
