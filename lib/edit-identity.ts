/**
 * What a carton's barcode becomes when the edit panel is saved — decided
 * before the save is traced, so `edit_save` names the identity the row is
 * booked under (04/11: the trace logged only the old MANUAL- key, which
 * read as if a placeholder had been saved).
 *
 *  - 'forced'  a label minted for it, or the NOBC- marker of No barcode;
 *  - 'typed'   13+ digits typed for an unidentified carton (the page still
 *              checks they are not a carton already on the list) — or fewer
 *              that `shortSerialOk` takes as the carton's own serial;
 *  - 'short'   digits started but too few — the save is refused;
 *  - 'kept'    its existing barcode (identified, or nothing typed yet).
 */
export type EditIdentity =
  | { kind: 'forced'; id: string }
  | { kind: 'typed'; id: string }
  | { kind: 'short'; typed: number }
  | { kind: 'kept'; id: string };

/**
 * `shortSerialOk` (04/11, Wall Dan): typed digits under `minDigits` that the
 * camera would book as a carton serial — the page passes its camera gate
 * (flag camera_short_serial on a short-serial supplier's receipt, the same
 * CAMERA_SERIAL_RE and exclusions: lib/carton-barcode.ts
 * cameraSerialBookable) only while the flag is on. Absent, a short entry is
 * 'short' exactly as before.
 */
export function resolveEditIdentity(
  form: { barcode: string; forcedId?: string; unidentified: boolean; barcodeInput: string },
  minDigits = 13,
  shortSerialOk?: (digits: string) => boolean,
): EditIdentity {
  if (form.forcedId) return { kind: 'forced', id: form.forcedId };
  if (form.unidentified) {
    const typed = (form.barcodeInput || '').replace(/\D/g, '');
    if (typed.length >= minDigits) return { kind: 'typed', id: typed };
    if (typed && shortSerialOk?.(typed)) return { kind: 'typed', id: typed };
    if ((form.barcodeInput || '').trim()) return { kind: 'short', typed: typed.length };
  }
  return { kind: 'kept', id: form.barcode };
}
