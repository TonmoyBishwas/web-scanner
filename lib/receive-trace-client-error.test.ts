import { describe, expect, it } from 'vitest';
import { RECEIVE_EVENT_SET, clientErrorPayload } from '@/lib/receive-trace';

describe('receive_client_error payload (2026-11-10)', () => {
  it('window error: message, script name without host/query, position, short stack, form', () => {
    const e = new TypeError('x is undefined');
    e.stack = ['TypeError: x is undefined', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const p = clientErrorPayload(
      'error',
      { message: 'Uncaught TypeError: x is undefined', filename: 'https://s.vercel.app/_next/static/chunks/abc123.js?v=1', lineno: 12, colno: 40, error: e },
      'v3',
      1,
    );
    expect(p).toMatchObject({ type: 'error', form: 'v3', nth: 1, name: 'TypeError', source: 'abc123.js', line: 12, col: 40 });
    expect(p.message).toBe('Uncaught TypeError: x is undefined');
    expect(String(p.stack).split('\n')).toHaveLength(6);
  });

  it('unhandled rejection with a string reason, long message cut', () => {
    const p = clientErrorPayload('rejection', { reason: 'z'.repeat(1000) }, 'classic', 3);
    expect(p).toMatchObject({ type: 'rejection', form: 'classic', nth: 3, source: null, line: null, stack: null });
    expect(String(p.message)).toHaveLength(300);
  });

  it('the server accepts the new event names', () => {
    for (const n of ['receive_client_error', 'receive_error_shown', 'receive_notice']) expect(RECEIVE_EVENT_SET.has(n)).toBe(true);
  });
});
