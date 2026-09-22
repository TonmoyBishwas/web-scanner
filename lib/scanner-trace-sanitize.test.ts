import { describe, it, expect } from 'vitest';
import { sanitizeForTrace, packEventData, bodyForTrace, MAX_EVENT_CHARS } from './scanner-trace-sanitize';

const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(5000);
const rawB64 = 'QUJD'.repeat(2000);

describe('sanitizeForTrace', () => {
  it('replaces photos by a marker, by value and by key', () => {
    const out = sanitizeForTrace({ image: jpeg, other: rawB64, name: 'קבבונים' }) as Record<string, unknown>;
    expect(out.image).toMatch(/^<omitted \d+ chars>$/);
    expect(out.other).toMatch(/^<image \d+ chars>$/);
    expect(out.name).toBe('קבבונים');
  });
  it('keeps ordinary long-ish strings but truncates huge ones', () => {
    const s = 'x y '.repeat(100); // 400 chars with spaces → not an image
    expect(sanitizeForTrace(s)).toBe(s);
    const big = 'a b '.repeat(1000);
    expect(String(sanitizeForTrace(big)).length).toBeLessThan(1100);
  });
  it('caps arrays, nesting and Maps', () => {
    const arr = sanitizeForTrace(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(arr.length).toBe(61);
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(sanitizeForTrace(deep))).toContain('<depth>');
    expect(sanitizeForTrace(new Map([['k', 1]]))).toEqual([['k', 1]]);
  });
});

describe('packEventData', () => {
  it('returns a preview when an event is too big even after sanitising', () => {
    const data = { rows: Array.from({ length: 60 }, (_, i) => ({ i, text: 'word '.repeat(150) })) };
    const out = packEventData(data) as { truncated?: boolean; preview?: string };
    expect(out.truncated).toBe(true);
    expect(out.preview!.length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_EVENT_CHARS);
  });
  it('never throws on cyclic data', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => packEventData(a)).not.toThrow();
  });
});

describe('bodyForTrace', () => {
  it('parses JSON bodies and strips the image field', () => {
    const out = bodyForTrace(JSON.stringify({ image: jpeg, barcode: '7290004456825' })) as Record<string, unknown>;
    expect(out.barcode).toBe('7290004456825');
    expect(String(out.image)).toMatch(/^<omitted/);
  });
  it('keeps non-JSON text', () => {
    expect(bodyForTrace('plain')).toBe('plain');
  });
});
