/**
 * Receive-form trace — the pure half (no `window`, no React), 2026-10-28.
 *
 * On 27/10 David spent 36 minutes on the expiry step of a 21-line בני דרום
 * note and `scanner_events` showed nothing between `receive_open` (server,
 * page load) and `receive_submit`. The form now records what happened in
 * between: which line he was on and for how long, every field he changed
 * (old → new), what he searched for, when each line became complete, and
 * every save attempt with its outcome.
 *
 * Rows land in `scanner_events` as page 'receive', token = the form id,
 * kind 'ui' / 'lifecycle', next to the server's own `receive_open` /
 * `receive_submit` rows (POST /api/receipt-form/{id}/events). Nothing here is
 * shown to the worker.
 *
 * Privacy: values are what the note already holds (quantities, cartons,
 * packaging, dates) — free text the worker types (the "other reason" note, an
 * extra item's name) is recorded as its LENGTH only. Search text is item
 * names, kept short.
 *
 * This file holds the event builders and the `ReceiveTracker` state machine
 * (debounced field changes, time per line, lines becoming complete). Time is
 * passed in, so all of it is unit-tested (lib/receive-trace.test.ts); the
 * browser half is lib/receive-trace-client.ts + app/receive/[id]/useReceiveTrace.ts.
 */
import type { FormDraft, FormLine, LineDraft, LineError } from '@/lib/receipt-form';

/** One event as the page queues it (the transport adds ts/seq). */
export interface ReceiveEvent {
  kind: 'ui' | 'lifecycle' | 'error';
  event: string;
  data?: Record<string, unknown>;
}

/** Every event name this form emits — the server accepts only these. */
export const RECEIVE_EVENTS = [
  'receive_load',
  'receive_visibility',
  'receive_pagehide',
  'receive_line_focus',
  'receive_line_leave',
  'receive_field_change',
  'receive_line_done',
  'receive_line_reopened',
  'receive_validation_error',
  'receive_bulk',
  'receive_tab',
  'receive_step',
  'receive_search',
  'receive_search_go',
  'receive_scroll',
  'receive_next',
  'receive_lines_added',
  'receive_extra',
  'receive_save_attempt',
  'receive_save_ok',
  'receive_save_error',
  'receive_outcome',
] as const;
export type ReceiveEventName = (typeof RECEIVE_EVENTS)[number];
export const RECEIVE_EVENT_SET: ReadonlySet<string> = new Set(RECEIVE_EVENTS);

/** A burst of typing on one field becomes one event after this much quiet. */
export const FIELD_DEBOUNCE_MS = 1500;
/** Values are short by nature; anything longer is cut. */
const MAX_VALUE_CHARS = 24;
const MAX_QUERY_CHARS = 40;

export type LineField = 'qty' | 'cartons' | 'packaging' | 'expiry' | 'no_expiry' | 'gap' | 'gap_note';
export type FormField = 'pallets' | 'extra_name' | 'extra_qty' | 'extra_unit';
export type TraceField = LineField | FormField;

/** Where the worker is: a note line (its 1-based index) or another part of the form. */
export type Area = number | 'pallets' | 'tools' | 'search' | 'extras' | 'tabs' | 'footer' | 'other';

const LINE_FIELDS: Record<Exclude<keyof LineDraft, 'index'>, LineField> = {
  qty: 'qty',
  cartons: 'cartons',
  packaging: 'packaging',
  expiry: 'expiry',
  noExpiry: 'no_expiry',
  gap: 'gap',
  gapNote: 'gap_note',
};

/** Fields whose value is the worker's own free text: only its length is kept. */
const FREE_TEXT: ReadonlySet<TraceField> = new Set(['gap_note', 'extra_name']);

/** A value as it goes into the trail: short, and never free text. */
export function traceValue(field: TraceField, v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (FREE_TEXT.has(field)) return typeof v === 'string' ? v.length : null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  const s = String(v);
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) : s;
}

/** Field-by-field changes a patch makes to a line draft (unchanged keys skipped). */
export function lineFieldChanges(
  before: LineDraft | undefined,
  patch: Partial<LineDraft>,
): { field: LineField; old: unknown; new: unknown }[] {
  const out: { field: LineField; old: unknown; new: unknown }[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof LineDraft, unknown][]) {
    if (k === 'index') continue;
    const field = LINE_FIELDS[k];
    if (!field) continue;
    const old = before ? before[k] : undefined;
    if (old === v) continue;
    out.push({ field, old, new: v });
  }
  return out;
}

/** The line's identity in every event: its index and the note's item code. */
export function lineRef(line: Pick<FormLine, 'index' | 'code'> | undefined, index: number): { line: number; line_code: string | null } {
  return { line: index, line_code: line?.code ? String(line.code).slice(0, 40) : null };
}

/** The errors that mean "this value is wrong" (red), not "still to fill in" (amber). */
const TODO_ERRORS: ReadonlySet<string> = new Set(['expiry_missing', 'gap_missing', 'gap_note_missing']);
export function fixErrors(errs: readonly string[] | undefined): string[] {
  return (errs ?? []).filter((e) => !TODO_ERRORS.has(e));
}

/** Lines whose answer differs from what the note pre-filled (pallets / extras not counted). */
export function changedLineCount(initial: FormDraft, now: FormDraft): number {
  const byIndex = new Map(initial.lines.map((l) => [l.index, l]));
  let n = 0;
  for (const l of now.lines) {
    const o = byIndex.get(l.index);
    if (!o) {
      n += 1;
      continue;
    }
    if (
      o.qty !== l.qty || o.cartons !== l.cartons || o.packaging !== l.packaging || o.expiry !== l.expiry ||
      o.noExpiry !== l.noExpiry || o.gap !== l.gap || o.gapNote !== l.gapNote
    ) n += 1;
  }
  return n;
}

/** How many lines carry each error code (a validation snapshot, small). */
export function errorCounts(lines: Record<number, readonly LineError[] | readonly string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const errs of Object.values(lines)) for (const e of errs) out[e] = (out[e] ?? 0) + 1;
  return out;
}

/** A search as recorded: the text (short), how many lines it shows, and the first few. */
export function searchPayload(
  query: string,
  result: { active: boolean; fuzzy?: boolean; lines: readonly Pick<FormLine, 'index'>[] },
  total: number,
): Record<string, unknown> {
  const q = query.trim();
  return {
    q: q.length > MAX_QUERY_CHARS ? q.slice(0, MAX_QUERY_CHARS) : q,
    q_len: q.length,
    results: result.active ? result.lines.length : total,
    fuzzy: Boolean(result.fuzzy),
    first: result.lines.slice(0, 5).map((l) => l.index),
    total,
  };
}

/** Which area of the form a DOM element id belongs to (`line-7`, `q-7`, `pallets`, ...). */
export function areaOfId(id: string | null | undefined): Area | null {
  if (!id) return null;
  const m = /^(?:line|q|c|p|e)-(\d{1,4})$/.exec(id);
  if (m) return Number(m[1]);
  if (id === 'pallets') return 'pallets';
  if (id === 'same-date' || id === 'expiry-tools') return 'tools';
  if (id === 'extras') return 'extras';
  if (id === 'receive-search') return 'search';
  return null;
}

// ── The tracker ──────────────────────────────────────────────────────────

interface PendingField {
  /** `${area}|${field}` (or `extra:<key>|field`). */
  key: string;
  ref: Record<string, unknown>;
  field: TraceField;
  old: unknown;
  latest: unknown;
  edits: number;
  first: number;
  last: number;
}

interface LineStats {
  visits: number;
  activeMs: number;
  edits: number;
}

export interface TrackerOptions {
  /** Load time (ms epoch). */
  start: number;
  /** The note's lines, by index — for line codes. */
  lineOf: (index: number) => Pick<FormLine, 'index' | 'code'> | undefined;
  /** The line's current error codes (after the edit) — read when a field event is cut. */
  errorsOf?: (index: number) => readonly string[] | undefined;
  emit: (e: ReceiveEvent) => void;
}

/**
 * The stateful part: debounced field changes, which line is active and for
 * how long, and lines becoming complete. Every method takes `now` (ms epoch)
 * and never throws to the caller (the hook wraps it too).
 */
export class ReceiveTracker {
  private readonly o: TrackerOptions;
  private pending: PendingField | null = null;
  private area: Area | null = null;
  /** When the current area's visible stretch began (null while the tab is hidden). */
  private areaSince: number | null = null;
  /** The current visit's visible ms so far (excluding hidden stretches). */
  private visitMs = 0;
  /** When the current visit began / was last touched (a tap, a focus, an edit). */
  private visitStart = 0;
  private lastTouch = 0;
  /**
   * The last touch of the previous line visit — the gap from it to the next
   * line's first touch is "between lines": finding the item on the pallets.
   */
  private lastLineTouch: number | null = null;
  private hidden = false;
  private readonly stats = new Map<number, LineStats>();
  private ready: Set<number> | null = null;
  private lastDone: number | null = null;
  private doneCount = 0;

  constructor(o: TrackerOptions) {
    this.o = o;
  }

  private emit(event: ReceiveEventName, data?: Record<string, unknown>, kind: ReceiveEvent['kind'] = 'ui'): void {
    try { this.o.emit({ kind, event, data }); } catch { /* never let tracing break the form */ }
  }

  private stat(index: number): LineStats {
    let s = this.stats.get(index);
    if (!s) {
      s = { visits: 0, activeMs: 0, edits: 0 };
      this.stats.set(index, s);
    }
    return s;
  }

  /** Total visible ms the worker has spent on a line so far (closed visits + the open one). */
  lineActiveMs(index: number, now: number): number {
    const base = this.stats.get(index)?.activeMs ?? 0;
    if (this.area !== index) return base;
    return base + this.visitMs + (this.areaSince !== null ? now - this.areaSince : 0);
  }

  // ── Where the worker is ──

  /** Focus / a tap landed in `area`. A different area closes the open visit. */
  focus(area: Area, now: number, extra?: Record<string, unknown>): void {
    if (area === this.area) {
      this.lastTouch = now;
      return;
    }
    this.leave(now);
    this.area = area;
    this.areaSince = this.hidden ? null : now;
    this.visitMs = 0;
    this.visitStart = now;
    this.lastTouch = now;
    if (typeof area === 'number') {
      const s = this.stat(area);
      s.visits += 1;
      this.emit('receive_line_focus', {
        ...lineRef(this.o.lineOf(area), area),
        visit: s.visits,
        // Time since the worker left the previous line: walking the pallets to find this item.
        between_ms: this.lastLineTouch !== null ? Math.max(0, now - this.lastLineTouch) : null,
        since_load_ms: now - this.o.start,
        ...extra,
      });
    }
  }

  /** Close the open visit (if it is a line, emit how long it lasted). */
  leave(now: number): void {
    const area = this.area;
    if (area === null) return;
    if (this.pending && this.pending.key.startsWith(`${area}|`)) this.cut();
    const ms = this.visitMs + (this.areaSince !== null ? now - this.areaSince : 0);
    this.area = null;
    this.areaSince = null;
    this.visitMs = 0;
    if (typeof area === 'number') {
      const s = this.stat(area);
      s.activeMs += ms;
      this.lastLineTouch = this.lastTouch;
      this.emit('receive_line_leave', {
        ...lineRef(this.o.lineOf(area), area),
        ms,
        // From the first to the last touch of this visit: the work on the line itself.
        busy_ms: Math.max(0, this.lastTouch - this.visitStart),
        total_ms: s.activeMs,
        visit: s.visits,
        edits: s.edits,
      });
    }
  }

  /** Tab hidden (phone locked, WhatsApp opened) / visible again: the clock on the open visit pauses. */
  visibility(visible: boolean, now: number): void {
    if (visible === !this.hidden) return;
    if (!visible) {
      this.cut();
      if (this.areaSince !== null) this.visitMs += now - this.areaSince;
      this.areaSince = null;
      this.hidden = true;
    } else {
      this.hidden = false;
      if (this.area !== null) this.areaSince = now;
    }
    this.emit('receive_visibility', {
      state: visible ? 'visible' : 'hidden',
      area: this.area,
      since_load_ms: now - this.o.start,
    }, 'lifecycle');
  }

  // ── Field changes ──

  /** A change to a note line's draft (the form's onChange patch + the draft before it). */
  lineEdit(index: number, before: LineDraft | undefined, patch: Partial<LineDraft>, now: number): void {
    const changes = lineFieldChanges(before, patch);
    if (!changes.length) return;
    // Typing into a line makes it the active one even where focus events are missed.
    this.focus(index, now);
    for (const c of changes) {
      this.change(`${index}|${c.field}`, lineRef(this.o.lineOf(index), index), c.field, c.old, c.new, now);
    }
  }

  /** A change outside the lines (pallets, an extra item). `key` identifies the field instance. */
  formEdit(key: string, field: FormField, old: unknown, value: unknown, now: number): void {
    if (old === value) return;
    this.change(`${key}|${field}`, key.startsWith('extra:') ? { extra: key.slice(6) } : {}, field, old, value, now);
  }

  private change(key: string, ref: Record<string, unknown>, field: TraceField, old: unknown, value: unknown, now: number): void {
    this.lastTouch = now;
    if (this.pending && this.pending.key !== key) this.cut();
    if (!this.pending) {
      this.pending = { key, ref, field, old, latest: value, edits: 1, first: now, last: now };
    } else {
      this.pending.latest = value;
      this.pending.edits += 1;
      this.pending.last = now;
    }
  }

  /** Cut the pending field event if it has been quiet for FIELD_DEBOUNCE_MS (the hook's timer). */
  tick(now: number): void {
    if (this.pending && now - this.pending.last >= FIELD_DEBOUNCE_MS) this.cut();
  }

  /** True while a field event is waiting for quiet (the hook arms its timer on this). */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Emit the pending field event now (before a save, a leave, the page going away). */
  cut(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const oldV = traceValue(p.field, p.old);
    const newV = traceValue(p.field, p.latest);
    // Typed and typed back: nothing changed.
    if (oldV === newV && !FREE_TEXT.has(p.field)) return;
    const index = typeof p.ref.line === 'number' ? (p.ref.line as number) : null;
    let errs: string[] | undefined;
    if (index !== null) {
      this.stat(index).edits += 1;
      try { errs = [...(this.o.errorsOf?.(index) ?? [])]; } catch { errs = undefined; }
    }
    this.emit('receive_field_change', {
      ...p.ref,
      field: p.field,
      old: oldV,
      new: newV,
      keystrokes: p.edits,
      ms: p.last - p.first,
      ...(errs !== undefined ? { errs } : {}),
    });
    const bad = fixErrors(errs);
    if (index !== null && bad.length) {
      this.emit('receive_validation_error', { ...p.ref, field: p.field, value: newV, errs: bad, at: 'field' });
    }
  }

  // ── Lines becoming complete ──

  /**
   * The set of complete lines after a render. The first call is the
   * baseline (lines complete from the note itself are not "done" events);
   * after it, every line that turns complete is one `receive_line_done`
   * with the time spent on it, and one that stops being complete is
   * `receive_line_reopened`. A bulk tool completing many at once is one event.
   */
  readyLines(ready: ReadonlySet<number>, now: number, total: number): void {
    if (this.ready === null) {
      this.ready = new Set(ready);
      return;
    }
    const done = [...ready].filter((i) => !this.ready!.has(i)).sort((a, b) => a - b);
    const reopened = [...this.ready].filter((i) => !ready.has(i)).sort((a, b) => a - b);
    this.ready = new Set(ready);
    if (done.length > 3) {
      this.doneCount += done.length;
      this.emit('receive_line_done', {
        lines: done.slice(0, 60),
        count: done.length,
        ready: ready.size,
        total,
        since_load_ms: now - this.o.start,
        bulk: true,
      });
      this.lastDone = now;
    } else {
      for (const i of done) {
        this.doneCount += 1;
        const s = this.stats.get(i);
        this.emit('receive_line_done', {
          ...lineRef(this.o.lineOf(i), i),
          active_ms: this.lineActiveMs(i, now),
          visits: s?.visits ?? 0,
          edits: s?.edits ?? 0,
          // The cadence the client asked for: time from the previous completed line to this one.
          since_prev_done_ms: this.lastDone !== null ? now - this.lastDone : null,
          since_load_ms: now - this.o.start,
          ready: ready.size,
          total,
        });
        this.lastDone = now;
      }
    }
    if (reopened.length) {
      this.emit('receive_line_reopened', { lines: reopened.slice(0, 60), ready: ready.size, total });
    }
  }

  /** Per-line totals for the save event: the slowest lines first (≤ 30), so a 36-minute form explains itself. */
  summary(now: number): { lines_visited: number; done_during_session: number; slowest: { line: number; line_code: string | null; ms: number; visits: number; edits: number }[] } {
    const rows = [...this.stats.keys()].map((i) => ({
      ...lineRef(this.o.lineOf(i), i),
      ms: this.lineActiveMs(i, now),
      visits: this.stats.get(i)!.visits,
      edits: this.stats.get(i)!.edits,
    }));
    rows.sort((a, b) => b.ms - a.ms);
    return { lines_visited: rows.length, done_during_session: this.doneCount, slowest: rows.slice(0, 30) };
  }
}
