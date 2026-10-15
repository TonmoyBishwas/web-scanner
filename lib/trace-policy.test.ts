import { describe, it, expect } from 'vitest';
import { traceAllActive } from './trace-policy';

describe('traceAllActive', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  it('off when unset, unparsable or past', () => {
    expect(traceAllActive(now, undefined)).toBe(false);
    expect(traceAllActive(now, '')).toBe(false);
    expect(traceAllActive(now, 'next week')).toBe(false);
    expect(traceAllActive(now, '2026-10-14')).toBe(false);
  });
  it('on while the date is in the future', () => {
    expect(traceAllActive(now, '2026-10-22')).toBe(true);
    expect(traceAllActive(now, ' 2026-10-22T23:59:00+03:00 ')).toBe(true);
  });
});
