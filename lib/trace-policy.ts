/**
 * Trace everyone for a while (2026-10-15, logging gap G1): while the env var
 * `TRACE_ALL_UNTIL` holds an ISO date/time in the future, /api/trace records
 * every session, not only users with `trace_enabled` / `trace_until`. Unset,
 * unparsable or past = per-user flags only (the behaviour before).
 */
export function traceAllActive(now = Date.now(), raw: string | undefined = process.env.TRACE_ALL_UNTIL): boolean {
  if (!raw) return false;
  const until = Date.parse(raw.trim());
  return Number.isFinite(until) && until > now;
}
