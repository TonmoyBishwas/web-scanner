/**
 * How POST /api/receipt-form/{id} reads the bot's answer to
 * `/webhook/receipt-form` — pure, so it is tested without a network.
 *
 * Contract:
 *   200 {ok:true, status:'done', saved_lines, gr_note?}  → saved
 *   4xx/5xx {ok:false, error, message?}                  → the bot put the row back
 *                                                          to 'open' (or 'failed')
 * Anything else (a 2xx without ok:true, an HTML error page from the proxy,
 * a 404 from a bot that does not have the route yet) is a refusal too: the
 * route then puts the row back to 'open' only where it is still 'submitted'
 * (the bot never claimed it), so the worker can try again.
 */
export type BotReply =
  | { kind: 'done'; saved_lines: number | null; gr_note: string | null }
  | { kind: 'refused'; httpStatus: number; error: string; message: string | null };

export function readBotReply(httpStatus: number, body: unknown): BotReply {
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (httpStatus >= 200 && httpStatus < 300 && o?.ok === true) {
    const n = Number(o.saved_lines);
    return {
      kind: 'done',
      saved_lines: Number.isFinite(n) ? n : null,
      gr_note: typeof o.gr_note === 'string' && o.gr_note ? o.gr_note : null,
    };
  }
  return {
    kind: 'refused',
    // A 2xx that is not a success is still a failure for the page.
    httpStatus: httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
    error: typeof o?.error === 'string' && o.error ? o.error : 'bot_error',
    message: typeof o?.message === 'string' && o.message.trim() ? o.message.trim().slice(0, 500) : null,
  };
}

/** Statuses the page shows as "already saved" rather than an error. */
export function isFinalStatus(status: unknown): boolean {
  return status === 'done' || status === 'closed';
}

/** Statuses the page shows as "being saved right now". */
export function isInFlightStatus(status: unknown): boolean {
  return status === 'submitted' || status === 'processing';
}
