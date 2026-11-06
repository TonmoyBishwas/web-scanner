/**
 * The receive form's two calls to its own API, shared by today's form
 * (app/receive/[id]/ReceiptForm.tsx) and the v3 form (lib/receive-v3-client.ts,
 * flag receive_form_v3) so both send exactly the same request:
 *
 *   POST /api/receipt-form/{id}  body {exp, sig, rev, answers}   (the save)
 *   GET  /api/receipt-form/{id}?exp&sig&rev                      (the 15 s poll)
 *
 * Client-safe (fetch only). A network failure throws, as fetch does; each
 * caller keeps its own catch. The body is parsed whatever the HTTP status
 * (an unreadable body = null), so a caller reads `ok` / `status` / `data`
 * exactly as it read `res.ok` / `res.status` / `await res.json()` before.
 */

export interface ReceiptFormAnswer {
  /** res.ok */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The JSON body, or null when it is not JSON. */
  data: Record<string, unknown> | null;
}

async function answerOf(res: Response): Promise<ReceiptFormAnswer> {
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, status: res.status, data };
}

/** Save the answers (the route awaits the bot, up to 25 s). Throws on a network error. */
export async function postReceiptForm(o: {
  formId: string;
  exp: string;
  sig: string;
  rev: number;
  answers: unknown;
}): Promise<ReceiptFormAnswer> {
  const res = await fetch(`/api/receipt-form/${encodeURIComponent(o.formId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exp: o.exp, sig: o.sig, rev: o.rev, answers: o.answers }),
    cache: 'no-store',
  });
  return answerOf(res);
}

/** What the form row is now (status, rev, lines, features). Throws on a network error. */
export async function getReceiptForm(o: { formId: string; exp: string; sig: string; rev: number }): Promise<ReceiptFormAnswer> {
  const q = new URLSearchParams({ exp: o.exp, sig: o.sig, rev: String(o.rev) });
  const res = await fetch(`/api/receipt-form/${encodeURIComponent(o.formId)}?${q.toString()}`, { cache: 'no-store' });
  return answerOf(res);
}
