import { describe, it, expect } from 'vitest';
import {
  batchCount, growBudget, shrinkBudget, utf8Bytes, storedQueuesToDrop,
  TRACE_BATCH_MAX_BYTES, TRACE_BATCH_MIN_BYTES, STORED_QUEUE_MAX_AGE_MS,
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

describe('storedQueuesToDrop', () => {
  const now = 10 * STORED_QUEUE_MAX_AGE_MS;
  it('drops stale and unreadable queues', () => {
    expect(storedQueuesToDrop([
      { key: 'old', saved: now - STORED_QUEUE_MAX_AGE_MS - 1, chars: 10 },
      { key: 'bad', saved: null, chars: 10 },
      { key: 'fresh', saved: now - 1000, chars: 10 },
    ], now)).toEqual(['old', 'bad']);
  });
  it('keeps the newest queues within the total budget, drops the oldest', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, saved: now - i * 1000, chars: 150_000 }));
    const drop = storedQueuesToDrop(entries, now, 1_000_000);
    expect(drop).toEqual(['k6', 'k7', 'k8', 'k9', 'k10', 'k11']);
  });
  it('nothing to drop when small and fresh', () => {
    expect(storedQueuesToDrop([{ key: 'a', saved: now, chars: 5 }], now)).toEqual([]);
  });
});
