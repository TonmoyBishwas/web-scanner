import { describe, expect, it } from 'vitest';
import {
  manualTargetDigits, noteShortRead, TARGET_HINT_WINDOW_MS, targetDigitsToForward, targetVerdict,
} from './manual-target';

// Well Done note 48745 (04/11): schnitzel and chicken breast, Wall Dan serials.
const LINES = [
  { item_code: '7290008432986' },
  { item_code: '7290001495476' },
];
const T0 = Date.parse('2026-11-04T13:32:22Z');

describe('noteShortRead', () => {
  it('the same serial again only moves its time on', () => {
    const a = noteShortRead(null, '410413', T0);
    expect(a).toEqual({ value: '410413', at: T0 });
    expect(noteShortRead(a, '410413', T0 + 500)).toEqual({ value: '410413', at: T0 + 500 });
  });

  it('a different serial keeps the old one as prev', () => {
    const a = noteShortRead(null, '410413', T0);
    expect(noteShortRead(a, ' 410408 ', T0 + 300)).toEqual({
      value: '410408', at: T0 + 300, prev: { value: '410413', at: T0 },
    });
  });
});

describe('manualTargetDigits', () => {
  const note = noteShortRead(null, '410413', T0);

  it('a tap right after the camera read the chicken serial asks for it', () => {
    expect(manualTargetDigits(note, T0 + 2000, LINES, [])).toBe('410413');
    expect(manualTargetDigits(note, T0 + TARGET_HINT_WINDOW_MS, LINES, [])).toBe('410413');
  });

  it('too late, or no read at all: no hint', () => {
    expect(manualTargetDigits(note, T0 + TARGET_HINT_WINDOW_MS + 1, LINES, [])).toBeNull();
    expect(manualTargetDigits(null, T0, LINES, [])).toBeNull();
    expect(manualTargetDigits(undefined, T0, LINES, [])).toBeNull();
  });

  it('a read stamped a moment after the tap still counts', () => {
    expect(manualTargetDigits(note, T0 - 10, LINES, [])).toBe('410413');
  });

  it('two different labels read in the window: no guess', () => {
    const two = noteShortRead(note, '410408', T0 + 400);
    expect(manualTargetDigits(two, T0 + 1000, LINES, [])).toBeNull();
    // The older one long gone: the newer one is the target.
    expect(manualTargetDigits(two, T0 + TARGET_HINT_WINDOW_MS + 200, LINES, [])).toBe('410408');
  });

  it('a serial already on the list: no hint (the capture goes out as before)', () => {
    expect(manualTargetDigits(note, T0 + 500, LINES, ['410402', '410413'])).toBeNull();
  });

  it('not a carton serial: an invoice code or a piece of one, too short, a piece of a listed long code', () => {
    expect(manualTargetDigits(noteShortRead(null, '843298', T0), T0, LINES, [])).toBeNull();
    expect(manualTargetDigits(noteShortRead(null, '24755', T0), T0, LINES, [])).toBeNull();
    expect(manualTargetDigits(noteShortRead(null, '123456789012', T0), T0, LINES, [])).toBeNull();
    expect(manualTargetDigits(noteShortRead(null, '410413', T0), T0, LINES, ['729000628936041041312345678901'])).toBeNull();
  });
});

describe('targetVerdict', () => {
  it('no target: today\'s path', () => {
    expect(targetVerdict(null, '410405')).toBe('none');
    expect(targetVerdict('', '410405')).toBe('none');
  });

  it('the label asked for: match', () => {
    expect(targetVerdict('410413', '410413')).toBe('match');
    expect(targetVerdict('410413', ' 410 413 ')).toBe('match');
  });

  it('a neighbouring label, or no number read: mismatch', () => {
    // 13:33:30 — decoder on 410415, the reader returned schnitzel 410405.
    expect(targetVerdict('410415', '410405')).toBe('mismatch');
    expect(targetVerdict('410415', null)).toBe('mismatch');
    expect(targetVerdict('410415', '')).toBe('mismatch');
    expect(targetVerdict('410415', '7290008432986410415')).toBe('mismatch');
  });
});

describe('targetDigitsToForward', () => {
  it('a short digit string goes on; anything else is dropped', () => {
    expect(targetDigitsToForward('410413')).toBe('410413');
    expect(targetDigitsToForward(' 410413 ')).toBe('410413');
    expect(targetDigitsToForward(undefined)).toBeUndefined();
    expect(targetDigitsToForward('')).toBeUndefined();
    expect(targetDigitsToForward(410413)).toBeUndefined();
    expect(targetDigitsToForward('41041x')).toBeUndefined();
    expect(targetDigitsToForward('7290008432986')).toBeUndefined();
  });

  it('absent means the bot body is unchanged', () => {
    const body = (t: unknown) => JSON.stringify({ image: 'x', barcode: 'multi-pallet', candidates: undefined, target_digits: targetDigitsToForward(t) });
    expect(body(undefined)).toBe(JSON.stringify({ image: 'x', barcode: 'multi-pallet' }));
  });
});
