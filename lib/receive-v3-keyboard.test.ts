import { describe, expect, it } from 'vitest';
import { V3, dateJustCompleted, kbViewportStep, typeDate, type KbViewport } from './receive-v3';

/**
 * David, Bnei Darom 10/11: the pallet step hides while a number field has
 * focus (6.2), and nothing closed the phone's keyboard after the date, so 40
 * of 41 lines were closed and reopened to reach the pallet. A whole valid
 * date now closes the keyboard; so does Android's own "hide keyboard".
 */

const TODAY = '2026-11-10';

/** Type digits one by one, as the field does. */
function typed(digits: string, from = ''): string[] {
  const out: string[] = [];
  let v = from;
  for (const ch of digits) {
    v = typeDate(v + ch, v, (v + ch).length);
    out.push(v);
  }
  return out;
}

describe('dateJustCompleted (the 8th digit closes the keyboard)', () => {
  it('only the keystroke that makes a valid date', () => {
    const steps = typed('01062027');
    const hits = steps.map((v, i) => dateJustCompleted(i ? steps[i - 1] : '', v, TODAY));
    expect(steps[steps.length - 1]).toBe('01.06.2027');
    expect(hits).toEqual([false, false, false, false, false, false, false, true]);
  });

  it('6 digits expand to 20yy at once and count as complete', () => {
    const steps = typed('010627');
    expect(steps[steps.length - 1]).toBe('01.06.2027');
    expect(dateJustCompleted(steps[steps.length - 2], steps[steps.length - 1], TODAY)).toBe(true);
  });

  it('a past, far or impossible date keeps the keyboard (the error shows, he fixes it)', () => {
    expect(dateJustCompleted('01.11.202', '01.11.2026', TODAY)).toBe(false);
    expect(dateJustCompleted('01.01.204', '01.01.2045', TODAY)).toBe(false);
    expect(dateJustCompleted('31.02.202', '31.02.2027', TODAY)).toBe(false);
  });

  it('no change (a 9th digit is cut) does not close it again', () => {
    expect(dateJustCompleted('01.06.2027', '01.06.2027', TODAY)).toBe(false);
  });
});

describe('kbViewportStep (Android hides the keyboard, the field keeps focus)', () => {
  const H = 695;
  const run = (seq: [number, boolean][], s0: KbViewport = { base: H, shrunk: false }) => {
    let s = s0;
    return seq.map(([h, typing]) => {
      const r = kbViewportStep(s, h, typing);
      s = r.next;
      return r.closed;
    });
  };

  it('keyboard up then down while still typing → closed once', () => {
    expect(run([[H - 40, true], [H - 300, true], [H - 300, true], [H, true], [H, true]])).toEqual([false, false, false, true, false]);
  });

  it('the opening animation never closes it (not seen up yet)', () => {
    expect(run([[H, true], [H - 20, true], [H - 120, true], [H - 310, true]])).toEqual([false, false, false, false]);
  });

  it('the address bar (< KB_VIEWPORT_PX) is not a keyboard', () => {
    expect(V3.KB_VIEWPORT_PX).toBeGreaterThan(60);
    expect(run([[H - 56, true], [H, true]])).toEqual([false, false]);
  });

  it('focus left the number field: nothing to close, and the next field starts fresh', () => {
    expect(run([[H - 300, true], [H - 300, false], [H, false], [H, true]])).toEqual([false, false, false, false]);
  });

  it('the tallest viewport is the base (address bar hidden later)', () => {
    const r = kbViewportStep({ base: 600, shrunk: false }, 656, false);
    expect(r.next.base).toBe(656);
  });

  it('landscape (shorter than the portrait base) never closes it by mistake', () => {
    expect(run([[360, true], [200, true], [360, true]])).toEqual([false, false, false]);
  });
});
