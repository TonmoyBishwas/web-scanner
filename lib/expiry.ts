/**
 * One storage format for a carton's expiry: ISO `YYYY-MM-DD`.
 *
 * Until 2026-10 a scan row's `expiry` held two formats. The OCR and the
 * barcode "Use" offer wrote ISO, while every date a PERSON entered (the edit
 * panel's calendar, the "All boxes identical" form) was stored as
 * `DD/MM/YYYY`. The bot's `_parse_expiry` did not read that form, so each
 * typed date landed in `box_inventory.box_expiry` as NULL (140 of 464 cartons): FEFO
 * sorted them last and the client's Priority receipt lines went out with no
 * expiry. Now every writer stores ISO, the completion routes normalise again
 * (a row restored from an old browser cache can still carry the old form),
 * and only the screen shows `DD/MM/YYYY`.
 */

/**
 * Whatever is in an expiry field → ISO, or '' when it is neither ISO nor
 * `D/M/YYYY` / `DD/MM/YYYY` (day first, as Israeli stickers print it).
 */
export function toIsoDate(v: string): string {
  const raw = (v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

/** `2027-10-31` → `31/10/2027` for display. Anything else is returned as is. */
export function isoToDdmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * The value to STORE. Same as `toIsoDate`, except that a format it does not
 * know is kept (trimmed) rather than blanked: the bot also reads a bare
 * `DDMMYY`, and the raw string is kept in `box_expiry_raw` either way, so
 * wiping it here would only lose information.
 */
export function normalizeExpiry(v: string | null | undefined): string {
  return toIsoDate(v ?? '') || (v ?? '').trim();
}

/**
 * Normalise the expiry on every scan row. Row order and every other field are
 * kept; a row with no expiry (or one already in ISO) is passed through as the
 * same object, and the input array is never mutated.
 */
export function normalizeBoxExpiries<T extends { expiry?: string | null }>(boxes: T[]): T[] {
  return boxes.map((b) => {
    if (!b || typeof b.expiry !== 'string' || !b.expiry) return b;
    const expiry = normalizeExpiry(b.expiry);
    return expiry === b.expiry ? b : { ...b, expiry };
  });
}
