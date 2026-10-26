/**
 * Camera-side telemetry for the scanner trace (2026-10-15, logging gap G4).
 *
 * The reads that matter most for "the barcode isn't detected" never reached
 * the trace: a value seen once and never confirmed, a confirmed value dropped
 * by the 3 s cooldown, the native detector falling back to ZXing. They lived
 * as console lines (if at all). SmartScanner now sends them as structured
 * `ui` events; these are the pure parts — a per-value throttle, so a camera
 * resting on one sticker does not write an event per frame, and the counters
 * behind the 15 s `scanner_health` heartbeat.
 */

/** Lets one event per key through every `windowMs`. */
export class KeyThrottle {
  private last = new Map<string, number>();

  constructor(private readonly windowMs: number, private readonly maxKeys = 200) {}

  /** True when `key` may be emitted at `now` (and records it). */
  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.last.set(key, now);
    if (this.last.size > this.maxKeys) {
      // Drop the oldest entries; Map keeps insertion order.
      for (const k of this.last.keys()) {
        this.last.delete(k);
        if (this.last.size <= this.maxKeys / 2) break;
      }
    }
    return true;
  }

  clear(): void {
    this.last.clear();
  }
}

/**
 * Counters for one heartbeat window. `frames`/`decodes`/`values` are the
 * platform detector's; the edge-to-edge worker's reads are counted on their
 * own (2026-10-26 — they never were, so a carton the worker read showed as a
 * confirmation with 0 decodes). `idle_ms` is the time since either decoder
 * last read anything: a camera resting on nothing readable stands out in one
 * event.
 */
export class ScannerHealth {
  frames = 0;
  decodes = 0;
  confirmed = 0;
  e2eDecodes = 0;
  private values = new Set<string>();
  private e2eValues = new Set<string>();
  lastConfirmedAt = 0;
  lastReadAt = 0;

  frame(readCount: number, values: Iterable<string>, now = Date.now()): void {
    this.frames += 1;
    if (readCount > 0) {
      this.decodes += 1;
      this.lastReadAt = now;
    }
    for (const v of values) if (this.values.size < 100) this.values.add(v);
  }

  /** One result back from the edge-to-edge Code 128 worker. */
  e2e(readCount: number, values: Iterable<string>, now = Date.now()): void {
    if (readCount > 0) {
      this.e2eDecodes += 1;
      this.lastReadAt = now;
    }
    for (const v of values) if (this.e2eValues.size < 100) this.e2eValues.add(v);
  }

  confirm(now: number): void {
    this.confirmed += 1;
    this.lastConfirmedAt = now;
  }

  /** The heartbeat payload; resets the window counters. */
  snapshot(now: number, extra?: Record<string, unknown>): Record<string, unknown> {
    const out = {
      frames: this.frames,
      decodes: this.decodes,
      confirmed: this.confirmed,
      distinct: this.values.size,
      values: [...this.values].slice(0, 8),
      e2e_decodes: this.e2eDecodes,
      e2e_values: [...this.e2eValues].slice(0, 8),
      since_confirmed_ms: this.lastConfirmedAt ? now - this.lastConfirmedAt : null,
      idle_ms: this.lastReadAt ? now - this.lastReadAt : null,
      ...extra,
    };
    this.frames = 0;
    this.decodes = 0;
    this.confirmed = 0;
    this.e2eDecodes = 0;
    this.values.clear();
    this.e2eValues.clear();
    return out;
  }
}
