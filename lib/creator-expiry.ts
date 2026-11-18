/**
 * creator_expiry_prefill (18/11, approved by Mevaser; Well Done 48936 on
 * 15/11: New carton filled in only the count, and David typed guessed
 * values for 4 cartons).
 *
 * When New carton (צרו קרטון, "create carton") opens on an item, its expiry
 * field starts on the expiry of that item's cartons already on the open list:
 * the most common one; on a tie, the one of the carton scanned last. The
 * worker can change or clear it. The WEIGHT is never filled in from the list
 * (every Well Done carton weighs differently).
 *
 * A carton is the item's when count-check's cartonsOnListFor would count it
 * (the invoice has one line, or the row's name matches this line). Only
 * expiries a carton could be booked with count: a date in a known shape that
 * validateCartonDates does not refuse (after today, after the row's own
 * production date). Nothing usable → null: the field stays blank as today.
 *
 * A missing scanner_flags row is OFF; the page then passes no prefill.
 */
import { validateCartonDates } from './date-validation';
import { toIsoDate } from './expiry';
import { matchInvoiceItem, type InvoiceItem } from './invoice-match';

export interface ExpiryRow {
  barcode: string;
  item_name?: string;
  item_name_hebrew?: string;
  expiry?: string | null;
  production_date?: string | null;
  scanned_at?: string | null;
}

/** The expiry (ISO `YYYY-MM-DD`) New carton opens on for this item, or null. */
export function creatorExpiryPrefill(
  itemCode: string | number | null | undefined,
  rows: ReadonlyArray<ExpiryRow>,
  lines: ReadonlyArray<InvoiceItem> | null | undefined,
  receiptDate: string,
): string | null {
  const all = lines ? [...lines] : [];
  const code = String(itemCode ?? '');
  if (!code || all.length === 0) return null;
  const oneLine = all.length === 1 && String(all[0].item_code ?? '') === code;
  // expiry → how many cartons carry it, and when the last of them was scanned.
  const seen = new Map<string, { n: number; last: number; order: number }>();
  rows.forEach((r, order) => {
    const hit = oneLine || String(matchInvoiceItem(r.item_name_hebrew ?? '', r.item_name ?? '', all)?.item_code ?? '') === code;
    if (!hit) return;
    const iso = toIsoDate(String(r.expiry ?? ''));
    if (!iso) return;
    if (validateCartonDates({ production: r.production_date ?? '', expiry: iso, receiptDate }).expiryError) return;
    const at = Date.parse(String(r.scanned_at ?? ''));
    const when = Number.isFinite(at) ? at : -Infinity;
    const prev = seen.get(iso);
    if (!prev) {
      seen.set(iso, { n: 1, last: when, order });
    } else {
      prev.n += 1;
      if (when >= prev.last) { prev.last = when; prev.order = order; }
    }
  });
  let best: { iso: string; n: number; last: number; order: number } | null = null;
  for (const [iso, s] of seen) {
    if (
      !best
      || s.n > best.n
      || (s.n === best.n && (s.last > best.last || (s.last === best.last && s.order > best.order)))
    ) {
      best = { iso, ...s };
    }
  }
  return best?.iso ?? null;
}
