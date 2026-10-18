/**
 * Server copy of every carton on an in-progress pallet / loose-box list.
 *
 * 18/10 Glatt 261059464: a pallet's scanned list lived only in the browser
 * until the pallet was confirmed, and two tabs on one link wiped 31 scanned
 * cartons. Client (18/10): every scan saved server-side as it happens,
 * restored from the server after a reload, two open instances merged —
 * never overwritten.
 *
 * Model (docs/migrations/2026-10-18-scan-cartons-ledger.sql): one record per
 * carton per list — (token, pallet, key = the row's barcode on the list;
 * pallet 0 = the loose list). Every change carries a version from the tab
 * that made it; the server keeps the highest version PER CARTON and keeps a
 * removal as a tombstone. So two tabs or two phones adding different cartons
 * simply add up, a carton edited in two places keeps the later edit, and a
 * stale copy can never bring back a carton that was removed after it.
 *
 * The page never builds operations itself: `observe()` diffs each new list
 * against the last state it knows and queues what changed. The queue (the
 * outbox) is written to localStorage synchronously, per tab, before any
 * network call, and is sent in batches and retried until the server takes
 * it — so a scan made offline, or just before the browser is killed, is sent
 * by the next page load.
 */

export const LEDGER_PREFIX = 'pv';
const OUTBOX_PART = 'outbox';

/** A carton row as the page holds it (only `barcode` is relied on here). */
export type LedgerRow = { barcode: string } & Record<string, unknown>;

/** One carton as the server holds it. */
export interface ServerCarton {
  pallet: number;
  key: string;
  row: LedgerRow | null;
  deleted: boolean;
  ver: number;
}

/** One queued change. */
export interface LedgerOp {
  pallet: number;
  key: string;
  row: LedgerRow | null;
  deleted: boolean;
  ver: number;
  tab: string;
  /** 'user' = the worker scanned / edited / removed it on this page; 'sync' =
   *  re-sent because a merge found the server lacking it. Only a 'user'
   *  scan wins over a removal it raced with (a carton is never lost). */
  origin?: 'user' | 'sync';
}

/** Fields that never go to the server: the photo bytes (megabytes; the
 *  photo itself is archived separately) and the upload-in-flight marker. */
const TRANSIENT = new Set(['image_data', 'photo_pending']);

export function ledgerRow<T extends { barcode: string }>(row: T): LedgerRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (TRANSIENT.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out as LedgerRow;
}

/** Stable signature of a row (key order independent). */
export function rowSig(row: { barcode: string }): string {
  const r = ledgerRow(row) as Record<string, unknown>;
  return JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
}

/** Versions: wall clock × 1000 + a counter, strictly increasing per tab. */
export function makeVersioner(now: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    const v = Math.max(now() * 1000, last + 1);
    last = v;
    return v;
  };
}

export function outboxKey(token: string, tab: string): string {
  return `${LEDGER_PREFIX}:${token}:${OUTBOX_PART}:${tab}`;
}

export function opKey(pallet: number, key: string): string {
  return `${pallet}|${key}`;
}

/** What changed between the last known state of a list and the new one. */
export function diffList(
  known: Map<string, string>,
  list: ReadonlyArray<{ barcode: string }>,
): { upserts: LedgerRow[]; removed: string[] } {
  const upserts: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const key = row.barcode;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (known.get(key) !== rowSig(row)) upserts.push(ledgerRow(row));
  }
  const removed: string[] = [];
  for (const key of known.keys()) if (!seen.has(key)) removed.push(key);
  return { upserts, removed };
}

/**
 * Bring the server's records into a local list. Per carton the higher
 * version wins: `vers` holds the version of each carton's local state (0 or
 * absent = unknown, i.e. never changed here since the page loaded — then the
 * server's copy is taken). Cartons the server does not know at all stay and
 * are returned in `push` (they still have to reach the server); cartons the
 * local side changed more recently than the server are returned in `push`
 * too. A carton the server removed with a newer version is removed here.
 * Rows only on the server are appended in scan order. Local transient
 * fields (the photo bytes) are kept when the server's copy replaces a row.
 */
export function mergeServer<T extends { barcode: string }>(
  list: ReadonlyArray<T>,
  vers: ReadonlyMap<string, number>,
  server: ReadonlyArray<ServerCarton>,
): { list: T[]; vers: Map<string, number>; push: string[]; taken: string[]; changed: boolean } {
  const out: T[] = [...list];
  const taken = new Set<string>();
  const nextVers = new Map(vers);
  const push = new Set<string>();
  let changed = false;
  const index = new Map<string, number>();
  out.forEach((r, i) => { if (!index.has(r.barcode)) index.set(r.barcode, i); });
  const serverKeys = new Set<string>();
  const removeKeys = new Set<string>();
  const appended: T[] = [];

  for (const rec of server) {
    serverKeys.add(rec.key);
    const localVer = nextVers.get(rec.key) ?? 0;
    if (rec.ver < localVer) { push.add(rec.key); continue; }
    if (rec.ver === localVer) continue;
    nextVers.set(rec.key, rec.ver);
    taken.add(rec.key);
    const at = index.get(rec.key);
    if (rec.deleted || !rec.row) {
      if (at !== undefined) { removeKeys.add(rec.key); changed = true; }
      continue;
    }
    if (at !== undefined) {
      const cur = out[at] as unknown as Record<string, unknown>;
      if (rowSig(cur as unknown as T) !== rowSig(rec.row)) {
        const keep: Record<string, unknown> = {};
        for (const k of TRANSIENT) if (cur[k] !== undefined) keep[k] = cur[k];
        out[at] = { ...(rec.row as Record<string, unknown>), ...keep } as unknown as T;
        changed = true;
      }
    } else {
      appended.push(rec.row as unknown as T);
      changed = true;
    }
  }
  for (const r of out) if (!serverKeys.has(r.barcode)) push.add(r.barcode);

  const scanTime = (r: T) => String((r as unknown as { scanned_at?: unknown }).scanned_at ?? '');
  appended.sort((a, b) => (scanTime(a) < scanTime(b) ? -1 : scanTime(a) > scanTime(b) ? 1 : 0));
  const merged = out.filter((r) => !removeKeys.has(r.barcode)).concat(appended);
  return { list: merged, vers: nextVers, push: [...push], taken: [...taken], changed };
}

export interface LedgerStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface LedgerStatus {
  /** Changes not yet confirmed by the server. */
  pending: number;
  /** The last send failed (offline / server error); it is being retried. */
  failing: boolean;
  /** The server has answered at least once on this page load. */
  everSynced: boolean;
  /** The server copy is not deployed (no table yet): the page works as before
   *  and the changes wait on the phone. */
  unavailable?: boolean;
}

/** What the server says about one change it was sent. */
export interface LedgerAck {
  pallet: number;
  key: string;
  /** The version the server now holds for this carton. */
  ver: number;
  /** This change was the one stored (false: the server holds a newer one). */
  applied?: boolean;
  /** The server's copy of the carton is a removal. */
  deleted?: boolean;
  /** The server refused the change itself (malformed); never resent. */
  rejected?: string;
}

export interface LedgerTransport {
  push(token: string, ops: LedgerOp[]): Promise<LedgerAck[]>;
  pull(token: string, pallet: number): Promise<ServerCarton[]>;
}

/** The server copy is not deployed (503 ledger_unavailable). */
export class LedgerUnavailableError extends Error {
  constructor() { super('ledger_unavailable'); }
}

const FETCH_TIMEOUT_MS = 8000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  if (res.status === 503) {
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'ledger_unavailable') return new LedgerUnavailableError();
    } catch { /* fall through */ }
  }
  return new Error(`${what} ${res.status}`);
}

/** Same-origin JSON transport to /api/scan-ledger. */
export const httpTransport: LedgerTransport = {
  async push(token, ops) {
    const body = JSON.stringify({ token, ops });
    const res = await timedFetch('/api/scan-ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60000,
    });
    if (!res.ok) throw await failure(res, 'push');
    const data = (await res.json()) as { acks?: LedgerAck[] };
    return Array.isArray(data.acks) ? data.acks : [];
  },
  async pull(token, pallet) {
    const res = await timedFetch(`/api/scan-ledger?token=${encodeURIComponent(token)}&pallet=${pallet}`, {
      cache: 'no-store',
    });
    if (!res.ok) throw await failure(res, 'pull');
    const data = (await res.json()) as { cartons?: ServerCarton[] };
    return Array.isArray(data.cartons) ? data.cartons : [];
  },
};

const MAX_BATCH = 200;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const UNAVAILABLE_RETRY_MS = 60000;

export type LedgerEvent =
  | { kind: 'dropped'; pallet: number; key: string; reason: string }
  | { kind: 'requeued'; pallet: number; key: string; serverVer: number };

/**
 * The per-page sync engine. One instance per page load (tab). Lists are
 * addressed by pallet number (0 = loose).
 *
 * Versions: the device clock, but never below what this page has seen from
 * the server (`floor`) — a phone whose clock is behind still makes each new
 * change newer than the copy it saw, so its re-scan of a removed carton is
 * not thrown away as "older".
 */
export class ScanLedger {
  private known = new Map<number, Map<string, string>>();
  private vers = new Map<number, Map<string, number>>();
  private closed = new Set<number>();
  private outbox = new Map<string, LedgerOp>();
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private floor = 0;
  private status: LedgerStatus = { pending: 0, failing: false, everSynced: false };
  private readonly clockVer: () => number;

  constructor(
    private readonly token: string,
    private readonly tab: string,
    private readonly store: LedgerStore | null,
    private readonly transport: LedgerTransport = httpTransport,
    private readonly onStatus: (s: LedgerStatus) => void = () => {},
    now: () => number = Date.now,
    private readonly onEvent: (e: LedgerEvent) => void = () => {},
  ) {
    this.clockVer = makeVersioner(now);
    this.adoptStoredOutboxes();
  }

  getStatus(): LedgerStatus { return { ...this.status }; }

  /** Versions of the local state of one list (for mergeServer). */
  versionsOf(pallet: number): Map<string, number> {
    const v = new Map(this.vers.get(pallet) ?? []);
    for (const op of this.outbox.values()) {
      if (op.pallet === pallet && op.ver > (v.get(op.key) ?? 0)) v.set(op.key, op.ver);
    }
    return v;
  }

  /** Pending removals of a list (cartons removed here, not yet on the server). */
  pendingRemovals(pallet: number): Set<string> {
    const s = new Set<string>();
    for (const op of this.outbox.values()) if (op.pallet === pallet && op.deleted) s.add(op.key);
    return s;
  }

  /** The list as restored at load (from this phone): the baseline that later
   *  changes are diffed against. Nothing is queued for it here — `adopt()`
   *  after a server pull decides what still has to be sent. */
  baseline(pallet: number, list: ReadonlyArray<{ barcode: string }>): void {
    this.closed.delete(pallet);
    const m = new Map<string, string>();
    for (const r of list) if (r.barcode) m.set(r.barcode, rowSig(r));
    this.known.set(pallet, m);
  }

  /**
   * Called with every new state of a list: queues what changed. The FIRST
   * state seen for a list is its baseline (what the page restored from this
   * phone, or an empty new pallet) and queues nothing: a restored copy may be
   * older than the server's, so only a server pull (`adopt`) decides which of
   * its cartons still have to be sent. Everything after that is the worker's
   * own doing and is sent.
   */
  observe(pallet: number, list: ReadonlyArray<{ barcode: string }>): void {
    if (this.closed.has(pallet)) return;
    const known = this.known.get(pallet);
    if (!known) { this.baseline(pallet, list); return; }
    const { upserts, removed } = diffList(known, list);
    if (!upserts.length && !removed.length) return;
    for (const row of upserts) {
      known.set(row.barcode, rowSig(row));
      this.enqueue({ pallet, key: row.barcode, row, deleted: false, ver: this.newVer(pallet, row.barcode), tab: this.tab, origin: 'user' });
    }
    for (const key of removed) {
      known.delete(key);
      this.enqueue({ pallet, key, row: null, deleted: true, ver: this.newVer(pallet, key), tab: this.tab, origin: 'user' });
    }
    this.persist();
    this.schedule(0);
  }

  /**
   * After a server pull was merged into the list: the cartons the merge took
   * from the server (`taken`) are recorded as known in their merged state, so
   * they are not sent back; the cartons the merge said the server lacks or
   * holds older (`push`) are queued — with the version their local state
   * already has, so a late re-send can never beat a newer change made
   * elsewhere (only cartons with no known version get a new one). Every
   * other carton keeps its known state, so a change the page made in the
   * same moment is still seen by the next `observe()` and sent.
   */
  adopt(
    pallet: number,
    merged: ReadonlyArray<{ barcode: string }>,
    vers: ReadonlyMap<string, number>,
    push: ReadonlyArray<string>,
    taken: ReadonlyArray<string> = [],
  ): void {
    let known = this.known.get(pallet);
    if (!known) { known = new Map(); this.known.set(pallet, known); }
    const byKey = new Map(merged.map((r) => [r.barcode, r]));
    for (const key of taken) {
      const row = byKey.get(key);
      if (row) known.set(key, rowSig(row));
      else known.delete(key);
    }
    const v = new Map(this.vers.get(pallet) ?? []);
    for (const [k, n] of vers) {
      if (n > (v.get(k) ?? 0)) v.set(k, n);
      if (n > this.floor) this.floor = n;
    }
    this.vers.set(pallet, v);
    let queued = false;
    for (const key of push) {
      if (this.outbox.has(opKey(pallet, key))) continue; // already queued with its own (newer) version
      const row = byKey.get(key);
      if (!row) continue;
      if (known.get(key) !== undefined && known.get(key) !== rowSig(row)) continue; // unobserved change: observe() sends it
      known.set(key, rowSig(row));
      const have = v.get(key) ?? 0;
      this.enqueue({ pallet, key, row: ledgerRow(row), deleted: false, ver: have > 0 ? have : this.newVer(pallet, key), tab: this.tab, origin: 'sync' });
      queued = true;
    }
    if (queued) { this.persist(); this.schedule(0); }
  }

  /** The pallet was confirmed (or the list handed back): later states of
   *  that list (the page clears it for the next pallet) are not removals. */
  close(pallet: number): void {
    this.closed.add(pallet);
  }

  /** The worker is on this list again (a pallet re-claimed after it was
   *  closed here): start from a fresh baseline. No-op for an open list. */
  reopen(pallet: number): void {
    if (!this.closed.has(pallet)) return;
    this.closed.delete(pallet);
    this.known.delete(pallet);
    this.vers.delete(pallet);
  }

  async pull(pallet: number): Promise<ServerCarton[]> {
    let rows: ServerCarton[];
    try {
      rows = await this.transport.pull(this.token, pallet);
    } catch (e) {
      if (e instanceof LedgerUnavailableError) this.markUnavailable();
      throw e;
    }
    for (const r of rows) if (r.ver > this.floor) this.floor = r.ver;
    this.status = { ...this.status, everSynced: true, unavailable: false };
    this.emit();
    return rows;
  }

  /** Send everything queued now; resolves true when the outbox is empty. */
  async flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (let i = 0; this.inflight && i < 400; i += 1) {
      await new Promise((r) => setTimeout(r, 50)); // the running send (≤ 8 s)
    }
    if (this.inflight) return false;
    while (this.outbox.size > 0) {
      const before = this.outbox.size;
      const ok = await this.sendBatch();
      if (!ok || this.outbox.size >= before) return this.outbox.size === 0;
    }
    return true;
  }

  /** Kick a send now (after `online`, on focus), cutting any backoff wait. */
  poke(): void {
    this.attempt = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.schedule(0);
  }

  pendingCount(): number { return this.outbox.size; }

  private newVer(pallet: number, key: string): number {
    const local = this.vers.get(pallet)?.get(key) ?? 0;
    return Math.max(this.clockVer(), this.floor + 1, local + 1);
  }

  private enqueue(op: LedgerOp): void {
    const k = opKey(op.pallet, op.key);
    const cur = this.outbox.get(k);
    if (cur && cur.ver >= op.ver) return;
    this.outbox.set(k, op);
    const v = this.vers.get(op.pallet) ?? new Map<string, number>();
    if (op.ver > (v.get(op.key) ?? 0)) v.set(op.key, op.ver);
    this.vers.set(op.pallet, v);
    this.status.pending = this.outbox.size;
    this.emit();
  }

  private schedule(ms: number): void {
    if (this.timer || this.inflight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sendBatch().then((ok) => {
        if (ok && this.outbox.size > 0) this.schedule(0);
      });
    }, ms);
  }

  private markUnavailable(): void {
    this.status = { ...this.status, pending: this.outbox.size, failing: false, unavailable: true };
    this.emit();
  }

  private async sendBatch(): Promise<boolean> {
    if (this.inflight) return false;
    if (this.outbox.size === 0) return true;
    this.inflight = true;
    const batch = [...this.outbox.values()].slice(0, MAX_BATCH);
    try {
      const acks = await this.transport.push(this.token, batch);
      const acked = new Map(acks.map((a) => [opKey(a.pallet, a.key), a]));
      let progressed = false;
      for (const op of batch) {
        const k = opKey(op.pallet, op.key);
        if (this.outbox.get(k)?.ver !== op.ver) continue; // changed meanwhile: the newer one goes next
        const ack = acked.get(k);
        if (!ack || ack.rejected) {
          // Never resent: a change the server cannot take would loop forever.
          // The carton stays on the screen and is booked from there.
          this.outbox.delete(k);
          progressed = true;
          this.onEvent({ kind: 'dropped', pallet: op.pallet, key: op.key, reason: ack?.rejected ?? 'no_ack' });
          continue;
        }
        if (ack.ver > this.floor) this.floor = ack.ver;
        if (ack.applied === false && ack.ver >= op.ver && !op.deleted && ack.deleted && op.origin === 'user') {
          // The worker scanned this carton, and a removal stamped later (a
          // clock ahead, another phone) is on the server: the scan wins — a
          // carton in hand is never dropped silently.
          this.outbox.set(k, { ...op, ver: ack.ver + 1 });
          const v = this.vers.get(op.pallet);
          if (v) v.set(op.key, ack.ver + 1);
          this.onEvent({ kind: 'requeued', pallet: op.pallet, key: op.key, serverVer: ack.ver });
          progressed = true;
          continue;
        }
        if (ack.ver >= op.ver) {
          // Taken, or the server already holds something newer (the next
          // pull brings that in).
          this.outbox.delete(k);
          progressed = true;
        }
      }
      this.attempt = 0;
      this.status = { pending: this.outbox.size, failing: false, everSynced: true, unavailable: false };
      this.persist();
      this.emit();
      this.inflight = false;
      if (!progressed) { this.schedule(BACKOFF_MS[BACKOFF_MS.length - 1]); return false; }
      return true;
    } catch (e) {
      this.inflight = false;
      if (e instanceof LedgerUnavailableError) {
        this.markUnavailable();
        this.schedule(UNAVAILABLE_RETRY_MS);
        return false;
      }
      this.status = { ...this.status, pending: this.outbox.size, failing: true };
      this.emit();
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.schedule(wait);
      return false;
    }
  }

  private persist(): void {
    if (!this.store) return;
    const key = outboxKey(this.token, this.tab);
    try {
      if (this.outbox.size === 0) this.store.removeItem(key);
      else this.store.setItem(key, JSON.stringify([...this.outbox.values()]));
    } catch {
      // Full / disabled store: the change is still in memory and still sent.
    }
  }

  /** Take over the outboxes other page loads of this token left behind (a
   *  killed browser, an offline scan, a closed tab): their changes are sent
   *  from here. Sending twice is harmless — the server keeps the highest
   *  version per carton. */
  private adoptStoredOutboxes(): void {
    if (!this.store) return;
    const prefix = `${LEDGER_PREFIX}:${this.token}:${OUTBOX_PART}:`;
    const keys: string[] = [];
    try {
      for (let i = 0; i < this.store.length; i += 1) {
        const k = this.store.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
    } catch {
      return;
    }
    let any = false;
    for (const k of keys) {
      try {
        const raw = this.store.getItem(k);
        const ops = raw ? (JSON.parse(raw) as LedgerOp[]) : [];
        for (const op of Array.isArray(ops) ? ops : []) {
          if (!op || typeof op.key !== 'string' || typeof op.ver !== 'number' || typeof op.pallet !== 'number') continue;
          const ok = opKey(op.pallet, op.key);
          const cur = this.outbox.get(ok);
          if (!cur || cur.ver < op.ver) { this.outbox.set(ok, op); any = true; }
          if (op.ver > this.floor) this.floor = op.ver;
        }
        if (k !== outboxKey(this.token, this.tab)) this.store.removeItem(k);
      } catch {
        /* a corrupt outbox is skipped */
      }
    }
    if (any) {
      this.status.pending = this.outbox.size;
      this.persist();
      this.schedule(0);
    }
  }

  private emit(): void {
    try { this.onStatus(this.getStatus()); } catch { /* ignore */ }
  }
}
