/**
 * Runtime switches for scanner features (27/10): `public.scanner_flags`, one
 * row per flag — `enabled_all`, or a list of chat ids it is on for. Read by
 * the session GET (app/api/multi-pallet-session/route.ts), which hands the
 * page `features: { units_mode, camera_short_serial }`; flipping a row needs
 * no redeploy.
 *
 * A missing table, a missing row or any DB error is OFF: a feature behind a
 * flag must never switch on because the flag could not be read.
 *
 * Server only (the service-role client): the page sees `features` alone.
 */
import { supabase } from './supabase';
import { SHORT_SERIAL_SUPPLIER_VATS } from './carton-barcode';

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

/**
 * The camera books a short carton serial (item 1, 04/11): Wall Dan's 6-digit
 * running numbers, read by the camera, are booked like any full barcode —
 * no photo tap — on a short-serial supplier's receipt only
 * (lib/carton-barcode.ts SHORT_SERIAL_SUPPLIER_VATS, cameraSerialAccepted).
 * A missing row is OFF; the page then refuses the read as today.
 */
export const cameraShortSerialRow = flagRow('camera_short_serial');

/**
 * The flag row AND the receipt's supplier VAT, with the VAT cached per
 * receipt for `vatTtlMs`. Only a found, non-null VAT is cached: a miss, a
 * null or a failed lookup is asked again next time, so a VAT written after
 * the first look does not hold the feature off. Any throw is off.
 */
export function shortSerialGate(
  row: () => Promise<ScannerFlagRow | null>,
  lookupVat: (receiptId: string) => Promise<string | null>,
  vats: readonly string[],
  vatTtlMs = 10 * 60_000,
  now: () => number = () => Date.now(),
): (chatId: string | number | null | undefined, receiptId: string | null | undefined) => Promise<boolean> {
  const cache = new Map<string, { vat: string; at: number }>();
  return async (chatId, receiptId) => {
    try {
      const receipt = String(receiptId ?? '').trim();
      if (!receipt) return false;
      if (!flagEnabledFor(await row(), chatId)) return false;
      const hit = cache.get(receipt);
      let vat: string | null;
      if (hit && now() - hit.at < vatTtlMs) {
        vat = hit.vat;
      } else {
        const raw = await lookupVat(receipt);
        vat = raw == null ? null : String(raw).trim() || null;
        if (vat) cache.set(receipt, { vat, at: now() });
        else cache.delete(receipt);
      }
      return !!vat && vats.includes(vat);
    } catch {
      return false;
    }
  };
}

/** The receipt's deliveries.supplier_vat; null on a miss or any error. */
async function receiptSupplierVat(receiptId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('deliveries')
    .select('supplier_vat')
    .eq('id', receiptId)
    .maybeSingle();
  if (error || !data) return null;
  const vat = (data as { supplier_vat?: unknown }).supplier_vat;
  return vat == null ? null : String(vat);
}

/** Camera short serials for this chat on this receipt; off when anything cannot be read. */
export const cameraShortSerialOn = shortSerialGate(
  cameraShortSerialRow,
  receiptSupplierVat,
  SHORT_SERIAL_SUPPLIER_VATS,
);

/**
 * Manual capture review (04/11, client: "stop creating cartons with MANUAL
 * barcodes until fixed"): a photo capture whose printed digits were not read
 * stays held for review instead of being booked as NOBC- (lib/no-barcode.ts
 * unreadDigitsOutcome), and no booking goes out with a MANUAL- placeholder
 * (provisionalAtBooking). A missing row is OFF.
 */
export const manualCaptureReviewRow = flagRow('manual_capture_review');

/** Manual capture review for this chat; off when the flag cannot be read, never a throw. */
export async function manualCaptureReviewOn(chatId: string | number | null | undefined): Promise<boolean> {
  try {
    return flagEnabledFor(await manualCaptureReviewRow(), chatId);
  } catch {
    return false;
  }
}
