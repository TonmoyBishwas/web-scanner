/**
 * Runtime switches for scanner features (27/10): `public.scanner_flags`, one
 * row per flag — `enabled_all`, or a list of chat ids it is on for. Read by
 * the session GET (app/api/multi-pallet-session/route.ts), which hands the
 * page `features: { units_mode }`; flipping a row needs no redeploy.
 *
 * A missing table, a missing row or any DB error is OFF: a feature behind a
 * flag must never switch on because the flag could not be read.
 */

export interface ScannerFlagRow {
  enabled_all?: unknown;
  chat_ids?: unknown;
}

/** On for everyone, or for this chat id; off for anything unreadable. */
export function flagEnabledFor(row: ScannerFlagRow | null | undefined, chatId: string | number | null | undefined): boolean {
  if (!row) return false;
  if (row.enabled_all === true) return true;
  const chat = String(chatId ?? '').trim();
  if (!chat || !Array.isArray(row.chat_ids)) return false;
  return row.chat_ids.some((c) => String(c ?? '').trim() === chat);
}

/**
 * One flag's row, cached for `ttlMs` per server instance: the session GET is
 * polled, and a flag flip may take that long to reach a running page. A
 * failed load is cached as "no row" (off) for the same time.
 */
export function cachedFlagRow(
  load: () => Promise<ScannerFlagRow | null>,
  ttlMs = 30_000,
  now: () => number = () => Date.now(),
): () => Promise<ScannerFlagRow | null> {
  let cached: { row: ScannerFlagRow | null; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.row;
    let row: ScannerFlagRow | null = null;
    try {
      row = await load();
    } catch {
      row = null;
    }
    cached = { row, at: now() };
    return row;
  };
}
