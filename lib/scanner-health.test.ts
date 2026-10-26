import { describe, it, expect } from 'vitest';
import { KeyThrottle, ScannerHealth } from './scanner-health';

describe('KeyThrottle', () => {
  it('lets one event per key through each window', () => {
    const t = new KeyThrottle(5000);
    expect(t.allow('A', 0)).toBe(true);
    expect(t.allow('A', 4999)).toBe(false);
    expect(t.allow('B', 100)).toBe(true);
    expect(t.allow('A', 5000)).toBe(true);
  });
});

describe('ScannerHealth', () => {
  it('counts the platform detector\'s frames, decodes and values as before', () => {
    const h = new ScannerHealth();
    h.frame(0, [], 0);
    h.frame(1, ['A'], 100);
    h.frame(2, ['A', 'B'], 200);
    h.confirm(200);
    const s = h.snapshot(1200);
    expect(s).toMatchObject({ frames: 3, decodes: 2, confirmed: 1, distinct: 2, values: ['A', 'B'], since_confirmed_ms: 1000 });
  });

  it('counts the edge-to-edge worker\'s reads on their own (09:55:16: a confirmation with 0 decodes)', () => {
    const h = new ScannerHealth();
    h.frame(0, [], 0);
    h.e2e(1, ['7290003670444014790729829072027'], 50);
    h.e2e(0, [], 90);
    h.confirm(100);
    const s = h.snapshot(1000);
    expect(s).toMatchObject({
      frames: 1, decodes: 0, confirmed: 1,
      e2e_decodes: 1, e2e_values: ['7290003670444014790729829072027'],
    });
  });

  it('idle_ms is the time since the last read from either decoder', () => {
    const h = new ScannerHealth();
    expect(h.snapshot(15_000).idle_ms).toBeNull(); // nothing read yet
    h.frame(1, ['A'], 16_000);
    h.e2e(1, ['B'], 17_000);
    h.frame(0, [], 29_000); // an empty frame is not a read
    expect(h.snapshot(30_000).idle_ms).toBe(13_000);
    // Carries over the window: 2 minutes of nothing reads as 2 minutes.
    h.frame(0, [], 140_000);
    expect(h.snapshot(150_000).idle_ms).toBe(133_000);
  });

  it('the snapshot resets the window, e2e counters included', () => {
    const h = new ScannerHealth();
    h.frame(1, ['A'], 0);
    h.e2e(1, ['B'], 0);
    h.snapshot(100);
    expect(h.snapshot(200)).toMatchObject({ frames: 0, decodes: 0, distinct: 0, values: [], e2e_decodes: 0, e2e_values: [] });
  });
});
