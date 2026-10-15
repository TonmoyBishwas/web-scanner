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
 * Delivery: batches every 2 s (or at 40 events), cut by BYTES (≤ 60 KB,
 * lib/scanner-trace-batch.ts) and halved after a failed POST. Ordinary
 * flushes are plain POSTs; only the page-going-away flush (pagehide / tab
 * hidden) uses `sendBeacon` / `keepalive`, whose 64 KiB body limit the byte
 * cap respects. The unsent queue is kept in localStorage, so a reload or a
 * crash does not lose it: the next page load sends it under its original
 * load id (2026-10-15 — five minutes of David's work never arrived).
 * Never throws, never blocks the UI — a failed flush just retries.
 */
import { installDebugLogCapture, onDebugLogEntry } from '@/lib/debug-log';
import { bodyForTrace, packEventData } from '@/lib/scanner-trace-sanitize';
import {
  batchCount, growBudget, shrinkBudget, storedQueuesToDrop, utf8Bytes, TRACE_BATCH_MAX_BYTES,
} from '@/lib/scanner-trace-batch';

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
/** localStorage key prefix for a load's unsent events (one key per load). */
const STORE_PREFIX = 'scanner-trace:q:';
/** Never persist more than this (UTF-16 chars) — localStorage is ~5 MB, shared. */
const STORE_MAX_CHARS = 150_000;
const STORE_DEBOUNCE_MS = 1000;
/** A queue not closed by a pagehide and untouched this long is an orphan (crash). */
const STALE_MS = 120_000;

let state: State = 'idle';
interface Ctx { token: string; page: string; loadId: string; w: string }
let ctx: Ctx | null = null;
let queue: TraceEvent[] = [];
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let failures = 0;
let budget = TRACE_BATCH_MAX_BYTES;
let storeTimer: ReturnType<typeof setTimeout> | null = null;
let fetchWrapped = false;
/** Serialised size of each queued event, by object (computed once). */
const sizeCache = new WeakMap<TraceEvent, number>();
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
    if (state === 'on') {
      schedule(queue.length >= FLUSH_AT ? 0 : FLUSH_MS);
      persistSoon();
    }
  } catch { /* never let tracing break the page */ }
}

function schedule(ms: number): void {
  if (timer) {
    if (ms > 0) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => { timer = null; void flush(); }, ms);
}

function payloadFor(c: Ctx, events: TraceEvent[]): string {
  return JSON.stringify({
    token: c.token, page: c.page, load_id: c.loadId, w: c.w || undefined, events,
  });
}

function eventBytes(ev: TraceEvent): number {
  let n = sizeCache.get(ev);
  if (n === undefined) {
    try { n = utf8Bytes(JSON.stringify(ev)); } catch { n = 1000; }
    sizeCache.set(ev, n);
  }
  return n;
}

/** The head of the queue that fits in `limit` bytes (at least one event). */
function nextBatch(limit: number): TraceEvent[] {
  const sizes: number[] = [];
  let total = 0;
  for (const ev of queue) {
    const n = eventBytes(ev);
    sizes.push(n);
    total += n + 1;
    if (total > limit) break;
  }
  return queue.slice(0, batchCount(sizes, limit));
}

async function flush(): Promise<void> {
  if (state !== 'on' || !ctx || inFlight || queue.length === 0) return;
  const batch = nextBatch(budget);
  inFlight = true;
  try {
    const res = await originalFetch('/api/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadFor(ctx, batch),
    });
    if (!res.ok) throw new Error(`trace POST ${res.status}`);
    // Drop exactly what was sent (events may have been appended meanwhile).
    queue = queue.slice(batch.length);
    failures = 0;
    budget = growBudget(budget);
  } catch {
    failures = Math.min(failures + 1, 6);
    // A body the server or the browser refuses keeps being refused at the
    // same size: send less next time.
    budget = shrinkBudget(budget);
  } finally {
    inFlight = false;
  }
  persistSoon();
  if (queue.length) schedule(failures ? FLUSH_MS * 2 ** failures : 0);
}

/** Last-chance delivery when the page is going away (refresh, close, navigate). */
function flushBeacon(): void {
  if (state !== 'on' || !ctx || queue.length === 0) return;
  // Whatever does not make it rides to the next load from localStorage.
  persistNow(true);
  const batch = nextBatch(Math.min(budget, TRACE_BATCH_MAX_BYTES));
  const body = payloadFor(ctx, batch);
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/trace', blob)) {
      queue = queue.slice(batch.length);
      persistNow(true);
      return;
    }
  } catch { /* fall back below */ }
  // keepalive only here: the request has to outlive the page.
  try {
    void originalFetch('/api/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* stays persisted */ });
  } catch { /* stays persisted */ }
}

// ── Unsent queue in localStorage (survives a reload or a crash) ──

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function persistSoon(): void {
  if (storeTimer) return;
  storeTimer = setTimeout(() => { storeTimer = null; persistNow(); }, STORE_DEBOUNCE_MS);
}

/**
 * `closed`: written by the page-going-away flush. Another tab's live queue
 * is never `closed` and keeps being rewritten, so the next load leaves it
 * alone unless it is stale (the tab crashed) — see resendStored.
 */
function persistNow(closed = false): void {
  if (!ctx || state !== 'on') return;
  const ls = storage();
  if (!ls) return;
  const key = STORE_PREFIX + ctx.loadId;
  try {
    if (queue.length === 0) {
      ls.removeItem(key);
      return;
    }
    // Newest events win when the queue is too big to keep.
    let events = queue;
    const saved = Date.now();
    let json = JSON.stringify({ ctx, events, saved, closed });
    while (json.length > STORE_MAX_CHARS && events.length > 1) {
      events = events.slice(Math.ceil(events.length / 4));
      json = JSON.stringify({ ctx, events, saved, closed });
    }
    ls.setItem(key, json);
  } catch { /* full or blocked storage: the in-memory queue still sends */ }
}

/**
 * Send what earlier loads of any scanner page left unsent, each under its
 * own token / load id. The server re-checks who is traced. Best effort: a
 * failed send keeps the entry for the next load; an unreadable one is dropped.
 */
async function resendStored(currentLoadId: string): Promise<void> {
  const ls = storage();
  if (!ls) return;
  let keys: string[] = [];
  try {
    const sizes: { key: string; saved: number | null; chars: number }[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (!k || !k.startsWith(STORE_PREFIX)) continue;
      const raw = ls.getItem(k) || '';
      let saved: number | null = null;
      if (k === STORE_PREFIX + currentLoadId) saved = Date.now(); // ours: never pruned first
      else {
        try { const v = JSON.parse(raw)?.saved; saved = typeof v === 'number' ? v : null; } catch { saved = null; }
      }
      sizes.push({ key: k, saved, chars: raw.length });
    }
    // Bound what earlier loads left behind (age + total size) so the scan
    // list's own cache always has room.
    const drop = new Set(storedQueuesToDrop(sizes, Date.now()).filter((k) => k !== STORE_PREFIX + currentLoadId));
    for (const k of drop) { try { ls.removeItem(k); } catch { /* ignore */ } }
    keys = sizes.map((e) => e.key).filter((k) => k !== STORE_PREFIX + currentLoadId && !drop.has(k));
  } catch {
    return;
  }
  keys = keys.slice(0, 20);
  for (const key of keys) {
    let entry: { ctx?: Ctx; events?: TraceEvent[]; saved?: number; closed?: boolean } | null = null;
    try { entry = JSON.parse(ls.getItem(key) || 'null'); } catch { entry = null; }
    if (!entry?.ctx || !Array.isArray(entry.events) || entry.events.length === 0) {
      try { ls.removeItem(key); } catch { /* ignore */ }
      continue;
    }
    // Another tab still open: its own page sends it.
    if (!entry.closed && Date.now() - (entry.saved ?? 0) < STALE_MS) continue;
    let rest = entry.events;
    let limit = TRACE_BATCH_MAX_BYTES;
    let failed = 0;
    while (rest.length > 0 && failed < 3) {
      const sizes = rest.map((ev) => { try { return utf8Bytes(JSON.stringify(ev)); } catch { return 1000; } });
      const n = batchCount(sizes, limit);
      try {
        const res = await originalFetch('/api/trace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadFor(entry.ctx, rest.slice(0, n)),
        });
        if (!res.ok) throw new Error(String(res.status));
        rest = rest.slice(n);
      } catch {
        failed += 1;
        limit = shrinkBudget(limit);
      }
    }
    try {
      if (rest.length === 0) ls.removeItem(key);
      else ls.setItem(key, JSON.stringify({ ctx: entry.ctx, events: rest, saved: entry.saved, closed: true }));
    } catch { /* ignore */ }
  }
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
    else persistNow(false);
  });
  window.addEventListener('pagehide', (e) => {
    trace('lifecycle', 'pagehide', { persisted: (e as PageTransitionEvent).persisted });
    flushBeacon();
  });
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) {
      trace('lifecycle', 'pageshow_bfcache');
      persistNow(false); // alive again: this page sends its own queue
    }
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
  // Whatever an earlier load could not send (a reload mid-burst, a crash).
  setTimeout(() => { void resendStored(ctx!.loadId).catch(() => {}); }, 3000);

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
