/**
 * Replay a scanning session's camera reads, rebuilt from its scanner_events
 * trace, through the confirmer and the page's read checks — the release
 * check the client asked for on 01/11 ("before every release rerun it on the
 * last week's real receipts and show that the results haven't changed").
 * Used by scripts/replay-scan-sessions.ts and lib/barcode-frame.test.ts.
 *
 * The trace does not keep every frame. It keeps, per value, the reads the
 * confirmer counted and when the first one came:
 *  - `scan_confirmed` {value, ms_from_first_read, reads}: confirmed at `ts`;
 *  - `read_dropped`   {value, reads, ms_from_first_read, reason}: left
 *    unconfirmed at `ts` (expired / superseded / …) after `reads` reads;
 *  - `cooldown_drop`  {value, held_by, ms}: confirmed inside the previous
 *    carton's 3 s cooldown.
 * `framesFromTrace` puts each value's reads back on the timeline (the first
 * at `ts − ms_from_first_read`, the rest spread up to `ts`, an expired
 * value's inside its 3 s window). `replayFrames` feeds them, one read per
 * frame, through a ReadConfirmer and the same steps the pallet page takes
 * after a confirmation: the short-read guard, the 3 s cooldown, classifyRead
 * and the duplicate check. Manual captures, typed digits and the edit panel
 * are not replayed.
 */
import { ReadConfirmer, type ReadPolicy } from './barcode-frame';
import { classifyRead, hasCartonCode, inboundReadPolicy, type ReadVerdict } from './carton-barcode';

export interface TraceRow {
  /** Event time, ms since epoch. */
  ts: number;
  event: string;
  data: Record<string, unknown> | null;
}

export interface ReplayFrame {
  t: number;
  value: string;
  /** Sort tie-break at the same `t`: a dropped value's read goes before a confirming read. */
  order: number;
}

const WINDOW_MS = 3000;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function framesFromTrace(rows: ReadonlyArray<TraceRow>): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  for (const r of rows) {
    const d = r.data ?? {};
    const value = str(d.value);
    if (!value) continue;
    if (r.event === 'scan_confirmed') {
      const reads = Math.max(1, num(d.reads, 2));
      const first = r.ts - Math.max(0, num(d.ms_from_first_read));
      if (reads === 1) {
        out.push({ t: r.ts, value, order: 1 });
        continue;
      }
      for (let j = 0; j < reads - 1; j += 1) out.push({ t: first + ((r.ts - first) * j) / (reads - 1), value, order: 1 });
      out.push({ t: r.ts, value, order: 1 });
    } else if (r.event === 'read_dropped') {
      const reads = Math.max(1, num(d.reads, 1));
      const ms = Math.max(0, num(d.ms_from_first_read));
      const first = r.ts - ms;
      // An expired value's reads all fell inside its window; others up to the drop.
      const span = str(d.reason) === 'expired' ? Math.min(ms, WINDOW_MS - 100) : ms;
      for (let j = 0; j < reads; j += 1) out.push({ t: first + (span * j) / reads, value, order: 0 });
    } else if (r.event === 'cooldown_drop') {
      out.push({ t: r.ts - 1, value, order: 1 }, { t: r.ts, value, order: 1 });
    }
  }
  return out.sort((a, b) => a.t - b.t || a.order - b.order);
}

export interface ReplayRules {
  /** The confirmer's per-value policy, given the list so far (undefined = two reads for every value). */
  policy?: (listed: Set<string>) => ReadPolicy;
  /** The page's read check. */
  classify: (value: string) => ReadVerdict;
  /** Duplicate check: is `value` on the list `codes` already? */
  isDuplicate: (codes: Set<string>, value: string) => boolean;
}

/** The rules before 01/11: two reads for every value, no Glatt mid check, dedupe by the exact string. */
export function oldRules(): ReplayRules {
  return {
    classify: (v) => {
      const r = classifyRead(v);
      return r.ok || r.reason === 'misread' ? { ok: true } : r;
    },
    isDuplicate: (codes, v) => codes.has(v),
  };
}

/** The rules from 01/11, with the note's lines for the one-read trust. */
export function newRules(lines: ReadonlyArray<{ item_code?: string | number | null }>): ReplayRules {
  return {
    policy: (listed) => inboundReadPolicy(() => lines, () => listed),
    classify: classifyRead,
    isDuplicate: hasCartonCode,
  };
}

export interface ReplayOutcome {
  /** Cartons booked, in order (the page's processed list). */
  booked: Array<{ value: string; t: number; reads: number }>;
  refused: Array<{ value: string; t: number; reason: string }>;
  duplicates: Array<{ value: string; t: number }>;
  cooldownDropped: Array<{ value: string; t: number }>;
}

export function replayFrames(frames: ReadonlyArray<ReplayFrame>, rules: ReplayRules): ReplayOutcome {
  const confirmer = new ReadConfirmer(2, WINDOW_MS);
  const processed = new Set<string>();
  const out: ReplayOutcome = { booked: [], refused: [], duplicates: [], cooldownDropped: [] };
  let lastScanAt = -Infinity;
  let lastScanned = '';
  const policy = rules.policy?.(processed);
  for (const f of frames) {
    const { confirmed, confirmedReads } = confirmer.add([{ value: f.value, dist: 0 }], f.t, 'replay', policy);
    if (!confirmed) continue;
    const verdict = rules.classify(confirmed);
    // SmartScanner's acceptValue: a too-short read never arms the cooldown.
    if (!verdict.ok && verdict.reason === 'too_short') {
      out.refused.push({ value: confirmed, t: f.t, reason: 'too_short' });
      continue;
    }
    if (f.t - lastScanAt < WINDOW_MS) {
      if (confirmed !== lastScanned) out.cooldownDropped.push({ value: confirmed, t: f.t });
      continue;
    }
    lastScanAt = f.t;
    lastScanned = confirmed;
    if (!verdict.ok) {
      out.refused.push({ value: confirmed, t: f.t, reason: verdict.reason });
      continue;
    }
    if (rules.isDuplicate(processed, confirmed)) {
      out.duplicates.push({ value: confirmed, t: f.t });
      continue;
    }
    processed.add(confirmed);
    out.booked.push({ value: confirmed, t: f.t, reads: confirmedReads });
  }
  return out;
}
