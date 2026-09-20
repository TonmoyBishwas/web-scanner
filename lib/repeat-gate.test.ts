import { describe, it, expect } from 'vitest';
import { RepeatGate } from './repeat-gate';

const CODE = '7290004456825';

function stationary(g: RepeatGate, from: number, to: number, step = 200) {
  for (let t = from; t <= to; t += step) g.observe(CODE, t);
}

describe('RepeatGate', () => {
  it('accepts the first read of a code', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    expect(g.isArmed()).toBe(true);
  });

  it('a phone left on one box never re-arms, however long it stays', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    g.accepted();
    stationary(g, 200, 60_000);
    expect(g.isArmed()).toBe(false);
  });

  it('one dropped frame on a slow phone is not "the box moved away"', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    g.accepted();
    g.observe(null, 400);          // a single miss…
    g.observe(CODE, 2400);         // …even a long one
    expect(g.isArmed()).toBe(false);
  });

  it('a short gap with several misses is still the same box', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    g.accepted();
    g.observe(null, 200);
    g.observe(null, 400);
    g.observe(null, 600);
    g.observe(CODE, 800);          // away 800 ms < 1500
    expect(g.isArmed()).toBe(false);
  });

  it('moving the camera to the next box (absent ≥ gap, ≥ misses) arms it', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    g.accepted();
    g.observe(null, 300);
    g.observe(null, 600);
    g.observe(null, 900);
    g.observe(CODE, 1800);
    expect(g.isArmed()).toBe(true);
    g.accepted();
    expect(g.isArmed()).toBe(false);
  });

  it('a different code is never the same box', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    g.accepted();
    g.observe('7290000000019', 200);
    expect(g.isArmed()).toBe(true);
  });

  it('misses reset once the code is seen again without a real gap', () => {
    const g = new RepeatGate(1500, 2);
    g.observe(CODE, 0);
    g.accepted();
    g.observe(null, 200);
    g.observe(null, 400);
    g.observe(CODE, 600);          // back within 600 ms: misses reset
    g.observe(null, 800);
    g.observe(CODE, 2600);         // only 1 miss since → still the same box
    expect(g.isArmed()).toBe(false);
  });
});
