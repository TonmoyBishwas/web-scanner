import { describe, expect, it } from 'vitest';
import { endOcrOutage, newOcrOutageLatch, takeOcrOutageNotice } from './ocr-network-notice';

const on = { enabled: true, questionUp: false };

describe('takeOcrOutageNotice (ocr_network_notice, 04/11)', () => {
  it('flag off: never, however many reads fail', () => {
    const latch = newOcrOutageLatch();
    for (let i = 0; i < 5; i++) expect(takeOcrOutageNotice(latch, { enabled: false, questionUp: false })).toBe(false);
    expect(latch.shown).toBe(false);
  });

  it('flag on: once per outage, not once per carton', () => {
    const latch = newOcrOutageLatch();
    expect(takeOcrOutageNotice(latch, on)).toBe(true);
    expect(takeOcrOutageNotice(latch, on)).toBe(false);
    expect(takeOcrOutageNotice(latch, on)).toBe(false);
  });

  it('a read that comes back (or the browser online again) ends the outage: the next failure says it again', () => {
    const latch = newOcrOutageLatch();
    expect(takeOcrOutageNotice(latch, on)).toBe(true);
    endOcrOutage(latch);
    expect(takeOcrOutageNotice(latch, on)).toBe(true);
    expect(takeOcrOutageNotice(latch, on)).toBe(false);
  });

  it('never over a question notice; the next failure of the outage may say it', () => {
    const latch = newOcrOutageLatch();
    expect(takeOcrOutageNotice(latch, { enabled: true, questionUp: true })).toBe(false);
    expect(latch.shown).toBe(false);
    expect(takeOcrOutageNotice(latch, on)).toBe(true);
  });
});
