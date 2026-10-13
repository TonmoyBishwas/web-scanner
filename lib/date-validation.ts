/**
 * The one rule for a carton's two dates, wherever they are read or edited.
 *
 * Client requirement (2026-10-13), from Glatt delivery 261058197: 8 of 128
 * meat cartons were booked with wrong dates — the production date typed as
 * the expiry, the same date in both fields, an expiry (2026-06-23) before the
 * day the goods arrived, and plain typos. So:
 *
 * - an expiry ON or BEFORE the receipt date (today) is refused;
 * - an expiry ON or BEFORE the production date is refused;
 * - a BLANK expiry is always accepted ("no expiry" must never block).
 *
 * When both rules fail (the production date typed into both fields is
 * usually also in the past) the production-date message wins: "probably
 * swapped" tells the worker what actually went wrong.
 *
 * Inputs may be ISO `YYYY-MM-DD` or the sticker's `D/M/YYYY`; a value in any
 * other shape cannot be compared and is not judged (the bot keeps the raw
 * string either way). The result is a translation key, so the message is
 * Hebrew or English with the page.
 */
import { toIsoDate } from './expiry';

export type CartonDateError = 'dates.expiryNotFuture' | 'dates.expiryNotAfterProduction';

export interface CartonDateCheck {
  expiryError?: CartonDateError;
}

export function validateCartonDates(args: {
  production?: string | null;
  expiry?: string | null;
  /** ISO `YYYY-MM-DD` — the receiving day (the device's today). */
  receiptDate: string;
}): CartonDateCheck {
  const expiry = toIsoDate(args.expiry ?? '');
  if (!expiry) return {};
  const production = toIsoDate(args.production ?? '');
  // ISO strings compare as dates.
  if (production && expiry <= production) return { expiryError: 'dates.expiryNotAfterProduction' };
  if (expiry <= args.receiptDate) return { expiryError: 'dates.expiryNotFuture' };
  return {};
}
