/**
 * Runtime switches for scanner features (27/10): `public.scanner_flags`, one
 * row per flag — `enabled_all`, or a list of chat ids it is on for. Read by
 * the session GET (app/api/multi-pallet-session/route.ts), which hands the
 * page `features: { units_mode }`; flipping a row needs no redeploy.
 *
 * A missing table, a missing row or any DB error is OFF: a feature behind a
 * flag must never switch on because the flag could not be read.
 *
 * Server only (the service-role client): the page sees `features` alone.
 */
import { supabase } from './supabase';

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

/**
 * Units-carton mode (lib/units-cartons.ts). One cache for the session GET,
 * which tells the page, and POST /api/carton-labels, which refuses a units
 * save while the flag is off for the session's chat.
 */
export const unitsModeRow = cachedFlagRow(async () => {
  const { data, error } = await supabase
    .from('scanner_flags')
    .select('enabled_all, chat_ids')
    .eq('flag', 'units_mode')
    .maybeSingle();
  if (error) return null;
  return (data as ScannerFlagRow | null) ?? null;
});

/** Units mode for this chat; off when the flag cannot be read. */
export async function unitsModeOn(chatId: string | number | null | undefined): Promise<boolean> {
  return flagEnabledFor(await unitsModeRow(), chatId);
}

/** One flag's row by name, cached like `unitsModeRow`; a DB error is no row (off). */
function flagRow(flag: string) {
  return cachedFlagRow(async () => {
    const { data, error } = await supabase
      .from('scanner_flags')
      .select('enabled_all, chat_ids')
      .eq('flag', flag)
      .maybeSingle();
    if (error) return null;
    return (data as ScannerFlagRow | null) ?? null;
  });
}

/**
 * The receive form's redesign (28/10): compact line cards and the
 * one-item-at-a-time expiry walk. Read by the form page (first render) and
 * its poll (GET /api/receipt-form/{id} → `features.receive_redesign`).
 */
export const receiveRedesignRow = flagRow('receive_redesign');

/** The receive redesign for this chat; off when the flag cannot be read, never a throw. */
export async function receiveRedesignOn(chatId: string | number | null | undefined): Promise<boolean> {
  try {
    return flagEnabledFor(await receiveRedesignRow(), chatId);
  } catch {
    return false;
  }
}
