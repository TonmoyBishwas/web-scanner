import { describe, expect, it } from 'vitest';
import { isFinalStatus, isInFlightStatus, readBotReply } from './receipt-form-submit';

describe('readBotReply', () => {
  it('200 ok:true is saved', () => {
    expect(readBotReply(200, { ok: true, status: 'done', saved_lines: 26, gr_note: 'GR26000070' })).toEqual({
      kind: 'done',
      saved_lines: 26,
      gr_note: 'GR26000070',
    });
    expect(readBotReply(200, { ok: true, status: 'done' })).toEqual({ kind: 'done', saved_lines: null, gr_note: null });
  });

  it('a bot refusal passes its status, error and message through', () => {
    expect(readBotReply(409, { ok: false, error: 'not_held', message: 'התעודה כבר נסגרה בצ׳אט' })).toEqual({
      kind: 'refused',
      httpStatus: 409,
      error: 'not_held',
      message: 'התעודה כבר נסגרה בצ׳אט',
    });
  });

  it('a 2xx without ok:true, junk bodies and proxy pages are refusals', () => {
    expect(readBotReply(200, { ok: false })).toMatchObject({ kind: 'refused', httpStatus: 502, error: 'bot_error' });
    expect(readBotReply(200, null)).toMatchObject({ kind: 'refused', httpStatus: 502 });
    expect(readBotReply(404, null)).toMatchObject({ kind: 'refused', httpStatus: 404, message: null });
    expect(readBotReply(502, '<html>')).toMatchObject({ kind: 'refused', httpStatus: 502 });
    expect(readBotReply(301, {})).toMatchObject({ kind: 'refused', httpStatus: 502 });
  });
});

describe('status helpers', () => {
  it('final vs in flight', () => {
    expect(isFinalStatus('done')).toBe(true);
    expect(isFinalStatus('closed')).toBe(true);
    expect(isFinalStatus('open')).toBe(false);
    expect(isInFlightStatus('submitted')).toBe(true);
    expect(isInFlightStatus('processing')).toBe(true);
    expect(isInFlightStatus('failed')).toBe(false);
  });
});
