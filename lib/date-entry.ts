/**
 * Typed date entry (dd.mm.yyyy) for the receive form — pure helpers.
 *
 * Android Chrome opens ONLY a calendar for <input type="date">; the keyboard
 * never appears (David, 20/10). The form now types into a text field with a
 * numeric keypad and keeps the calendar as a separate button. These helpers
 * turn what was typed into the ISO `YYYY-MM-DD` the draft already stores.
 */
import { isRealIsoDate } from './receipt-form';

export type DateEntryResult =
  | { kind: 'empty' }
  | { kind: 'partial' }
  | { kind: 'date'; iso: string }
  | { kind: 'invalid' };

const SEP = /[./\-\s,]+/;

/**
 * What the field shows while typing. Separators the worker typed (/ - space ,)
 * become '.', anything else is dropped. Digits typed with no separator get
 * the dots inserted for them: `311227` → `31.12.27`, `31122027` → `31.12.2027`.
 * Max 10 characters.
 */
export function maskDateInput(raw: string): string {
  const groups: string[] = [''];
  for (const ch of raw || '') {
    const last = groups.length - 1;
    if (ch >= '0' && ch <= '9') {
      // Day and month hold 2 digits; a 3rd digit starts the next part.
      if (last < 2 && groups[last].length === 2) groups.push('');
      const cur = groups.length - 1;
      if (cur === 2 && groups[cur].length === 4) continue; // year is full
      groups[cur] += ch;
    } else if (/[./\-\s,]/.test(ch)) {
      // A typed separator closes a non-empty day/month (so "1.5.27" works);
      // a repeated or leading one is ignored.
      if (groups[last] !== '' && last < 2) groups.push('');
    }
    // anything else (letters, the calendar's own text) is dropped
  }
  return groups.join('.');
}

/**
 * Typed text → a date. Day first (Israeli stickers). Accepts dd.mm.yyyy,
 * d.m.yy, dd/mm/yy, ddmmyy, ddmmyyyy; a 2-digit year is 20yy.
 *
 * `final: false` (still typing) treats a 2-digit year as unfinished, so
 * "31.12.20" on its way to "31.12.2027" is not judged as the year 2020.
 * `final: true` (the field lost focus) accepts it.
 */
export function parseDateEntry(text: string, opts: { final: boolean }): DateEntryResult {
  const s = (text || '').trim();
  if (!s) return { kind: 'empty' };
  if (/[^\d./\-\s,]/.test(s)) return { kind: 'invalid' };

  let dd: string, mm: string, yy: string;
  if (!SEP.test(s)) {
    if (s.length < 6 || s.length === 7) return opts.final ? { kind: 'invalid' } : { kind: 'partial' };
    if (s.length > 8) return { kind: 'invalid' };
    if (s.length === 6 && !opts.final) return { kind: 'partial' };
    [dd, mm, yy] = [s.slice(0, 2), s.slice(2, 4), s.slice(4)];
  } else {
    const g = s.split(SEP).filter(Boolean);
    if (g.length > 3 || g.some((x, i) => (i < 2 ? x.length > 2 : x.length > 4))) return { kind: 'invalid' };
    if (g.length < 3) return opts.final ? { kind: 'invalid' } : { kind: 'partial' };
    [dd, mm, yy] = g;
    if (yy.length === 1 || yy.length === 3) return opts.final ? { kind: 'invalid' } : { kind: 'partial' };
    if (yy.length === 2 && !opts.final) return { kind: 'partial' };
  }
  const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  const iso = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  return isRealIsoDate(iso) ? { kind: 'date', iso } : { kind: 'invalid' };
}

/** `2027-12-31` → `31.12.2027`; anything that is not ISO is returned as is. */
export function isoToDotted(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso || '';
}

/**
 * What the field reports upward (into LineDraft.expiry / sameDate):
 * the ISO date when it parses, '' while empty or unfinished, and the raw text
 * when it is wrong — `expiryError` then says 'expiry_invalid' ("Not a valid
 * date") with no new message.
 */
export function entryToValue(text: string, final: boolean): string {
  const p = parseDateEntry(text, { final });
  if (p.kind === 'date') return p.iso;
  if (p.kind === 'invalid') return text.trim();
  return '';
}
