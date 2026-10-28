/**
 * Receive-form trace — delivery to POST /api/receipt-form/{id}/events
 * (2026-10-28). The scanner pages' lib/scanner-trace.ts resolves the worker
 * from a scan-session token, which the receive form does not have; this sink
 * authenticates with the form's own signed link (exp + sig) instead.
 *
 * Batches every 3 s (or at 30 events), cut by bytes (lib/scanner-trace-batch),
 * halved after a failed POST with a growing back-off. The page-going-away
 * flush uses sendBeacon / keepalive. The server may answer `enabled: false`
 * (RECEIVE_TRACE_DISABLED): the sink then goes quiet for the page's life.
 * Never throws, never blocks the form.
 */
import type { ReceiveEvent } from '@/lib/receive-trace';
import { batchCount, growBudget, shrinkBudget, utf8Bytes, TRACE_BATCH_MAX_BYTES } from '@/lib/scanner-trace-batch';
import { packEventData } from '@/lib/scanner-trace-sanitize';

interface Queued {
  ts: number;
  seq: number;
  kind: ReceiveEvent['kind'];
  event: string;
  data?: unknown;
}

const FLUSH_MS = 3000;
const FLUSH_AT = 30;
const QUEUE_CAP = 600;

export interface ReceiveTraceSink {
  push(e: ReceiveEvent): void;
  /** Send what is queued now (plain POST). */
  flush(): void;
  /** Last-chance send when the page is going away. */
  beacon(): void;
  readonly loadId: string;
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createReceiveTraceSink(opts: { formId: string; exp: string; sig: string }): ReceiveTraceSink {
  const loadId = newId();
  const url = `/api/receipt-form/${encodeURIComponent(opts.formId)}/events`;
  let queue: Queued[] = [];
  let seq = 0;
  let off = false;
  let inFlight = false;
  let failures = 0;
  let budget = TRACE_BATCH_MAX_BYTES;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const body = (events: Queued[]) =>
    JSON.stringify({ exp: opts.exp, sig: opts.sig, load_id: loadId, events });

  const nextBatch = (limit: number): Queued[] => {
    const sizes = queue.map((e) => {
      try { return utf8Bytes(JSON.stringify(e)); } catch { return 1000; }
    });
    return queue.slice(0, batchCount(sizes, limit));
  };

  const schedule = (ms: number) => {
    if (off) return;
    if (timer) {
      if (ms > 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => { timer = null; void send(); }, ms);
  };

  async function send(): Promise<void> {
    if (off || inFlight || queue.length === 0) return;
    const batch = nextBatch(budget);
    inFlight = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body(batch),
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 404) {
        // A bad / dead link never becomes good: stop.
        off = true;
        queue = [];
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
      queue = queue.slice(batch.length);
      if (j && j.enabled === false) {
        off = true;
        queue = [];
        return;
      }
      failures = 0;
      budget = growBudget(budget);
    } catch {
      failures = Math.min(failures + 1, 5);
      budget = shrinkBudget(budget);
    } finally {
      inFlight = false;
    }
    if (queue.length) schedule(failures ? FLUSH_MS * 2 ** failures : 0);
  }

  return {
    loadId,
    push(e) {
      if (off) return;
      try {
        queue.push({ ts: Date.now(), seq: seq++, kind: e.kind, event: e.event, data: packEventData(e.data) });
        if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
        schedule(queue.length >= FLUSH_AT ? 0 : FLUSH_MS);
      } catch { /* never let tracing break the form */ }
    },
    flush() {
      schedule(0);
    },
    beacon() {
      if (off || queue.length === 0) return;
      try {
        const batch = nextBatch(Math.min(budget, TRACE_BATCH_MAX_BYTES));
        const b = body(batch);
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
          && navigator.sendBeacon(url, new Blob([b], { type: 'application/json' }))) {
          queue = queue.slice(batch.length);
          return;
        }
        void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b, keepalive: true })
          .then((r) => { if (r.ok) queue = queue.slice(batch.length); })
          .catch(() => { /* lost with the page */ });
      } catch { /* ignore */ }
    },
  };
}
