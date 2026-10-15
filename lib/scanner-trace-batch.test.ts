import { describe, it, expect } from 'vitest';
import {
  batchCount, growBudget, shrinkBudget, utf8Bytes,
  TRACE_BATCH_MAX_BYTES, TRACE_BATCH_MIN_BYTES,
} from './scanner-trace-batch';

describe('scanner-trace-batch', () => {
  it('utf8Bytes counts Hebrew as 2 bytes', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('שלום')).toBe(8);
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('cuts a batch by bytes, not by event count', () => {
    const sizes = Array(150).fill(16_000);
    expect(batchCount(sizes, TRACE_BATCH_MAX_BYTES)).toBe(3);
    expect(batchCount(Array(150).fill(100), TRACE_BATCH_MAX_BYTES)).toBe(150);
  });

  it('always sends at least one event', () => {
    expect(batchCount([90_000, 10], TRACE_BATCH_MAX_BYTES)).toBe(1);
    expect(batchCount([], TRACE_BATCH_MAX_BYTES)).toBe(0);
  });

  it('halves on failure, grows back on success', () => {
    expect(shrinkBudget(60_000)).toBe(30_000);
    expect(shrinkBudget(3_000)).toBe(TRACE_BATCH_MIN_BYTES);
    expect(growBudget(30_000)).toBe(60_000);
    expect(growBudget(50_000)).toBe(TRACE_BATCH_MAX_BYTES);
  });
});
