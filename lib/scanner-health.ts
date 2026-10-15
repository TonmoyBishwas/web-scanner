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

/** Counters for one heartbeat window. */
export class ScannerHealth {
  frames = 0;
  decodes = 0;
  confirmed = 0;
  private values = new Set<string>();
  lastConfirmedAt = 0;

  frame(readCount: number, values: Iterable<string>): void {
    this.frames += 1;
    if (readCount > 0) this.decodes += 1;
    for (const v of values) if (this.values.size < 100) this.values.add(v);
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
      since_confirmed_ms: this.lastConfirmedAt ? now - this.lastConfirmedAt : null,
      ...extra,
    };
    this.frames = 0;
    this.decodes = 0;
    this.confirmed = 0;
    this.values.clear();
    return out;
  }
}
