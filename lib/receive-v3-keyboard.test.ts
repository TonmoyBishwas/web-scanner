import { describe, expect, it } from 'vitest';
import { V3, dateJustCompleted, expState, initialV3Draft, kbViewportStep, typeDate, type KbViewport } from './receive-v3';
import { normalizeFormLines } from './receipt-form';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  const W = 384;
  const run = (seq: ([number, boolean] | [number, boolean, number])[], s0: KbViewport = { base: H, shrunk: false, width: W }) => {
    let s = s0;
    return seq.map(([h, typing, w]) => {
      const r = kbViewportStep(s, h, w ?? s.width, typing);
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
    const r = kbViewportStep({ base: 600, shrunk: false, width: W }, 656, W, false);
    expect(r.next.base).toBe(656);
  });

  it('rotating starts again from the new height: never a close mid-typing', () => {
    const land: KbViewport = { base: 304, shrunk: false, width: 695 };
    // opened in landscape, keyboard up, rotated to portrait with the keyboard still up
    expect(run([[110, true], [395, true, W], [395, true]], land)).toEqual([false, false, false]);
  });

  it('opened in portrait, used in landscape: hide-keyboard is caught there too', () => {
    expect(run([[304, false, 695], [110, true], [304, true]])).toEqual([false, false, true]);
  });
});

describe('split by expiry: the date that makes the split add up closes the keyboard', () => {
  const GET = JSON.parse(readFileSync(path.resolve(__dirname, '../test/fixtures/receive_form_get_bnei_darom.json'), 'utf8')) as { lines: unknown };
  const LINES = normalizeFormLines(GET.lines);
  const D0 = initialV3Draft(LINES);
  const line = LINES.find((l) => l.needs_expiry && !l.weighed && Number(D0.lines.find((x) => x.index === l.index)?.qty) >= 2) ?? LINES[0];
  const d0 = D0.lines.find((x) => x.index === line.index)!;
  const total = Number(d0.qty);
  const closes = (rows: { qty: string; date: string }[], k: number, before: string) => {
    const d = { ...d0, split: rows };
    return dateJustCompleted(before, rows[k].date, TODAY) && expState(line, d, TODAY) === 'ok';
  };

  it('row 1 complete, row 2 still empty: keyboard stays (he goes on to row 2)', () => {
    expect(closes([{ qty: '1', date: '01.06.2027' }, { qty: String(total - 1), date: '' }], 0, '01.06.202')).toBe(false);
  });

  it('the last date that makes it add up: keyboard closes', () => {
    expect(closes([{ qty: '1', date: '01.06.2027' }, { qty: String(total - 1), date: '01.07.2027' }], 1, '01.07.202')).toBe(true);
  });

  it('adds up to less than the quantity: keyboard stays', () => {
    expect(total).toBeGreaterThanOrEqual(2);
    expect(closes([{ qty: '1', date: '01.06.2027' }, { qty: '0', date: '01.07.2027' }], 1, '01.07.202')).toBe(false);
  });
});
