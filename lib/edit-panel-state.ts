/**
 * The carton edit panel's state, as pure derivations.
 *
 * Floor complaint (2026-10-01): the panel was "very hard to get what it
 * means, which one is selected, which to edit". One brand-blue border meant
 * three things at once (the field being edited, the chosen invoice line, an
 * always-outlined text box), empty values were drawn as data ("0 kg", "—"),
 * and Save looked the same whether nothing had changed or the carton was still
 * incomplete. The trace shows the cost: every traced worker saved with the
 * weight still missing and had to come back, 3-5 opens per carton.
 *
 * Each field tile now carries ONE state, and each state ONE colour + icon:
 * - missing  → amber, dashed, "!" badge          (needs you)
 * - invalid / past → red, "!" badge               (this value is wrong)
 * - changed and valid → green check               (you fixed it)
 * - untouched and valid → grey pencil             (tap to change)
 * - and, on top, the field being edited → brand blue + pencil + caret.
 *
 * These helpers decide those states, which field opens first, what the
 * header's "Missing: …" line lists, and what Save looks like. The rendering
 * stays in components/terminal/EditPanel.tsx.
 */

export type EditField = 'name' | 'weight' | 'expiry';

/** '' → missing; a number above 0 → ok; anything else ('0', '.', '0.0') → invalid. */
export type WeightState = 'missing' | 'ok' | 'invalid';

/**
 * blank → missing; one of the invoice lines → ok; any other name (read off the
 * sticker, or typed) → offInvoice. With no invoice lines to compare against
 * there is nothing to be "off", so any name is ok.
 */
export type NameState = 'missing' | 'ok' | 'offInvoice';

/** '' → missing; today or earlier → past; a later date → ok. */
export type ExpiryState = 'missing' | 'past' | 'ok';

/**
 * What a field tile shows. `changed` = the worker changed it in this edit and
 * the new value is valid; `idle` = untouched and fine.
 */
export type TileState = 'missing' | 'invalid' | 'offInvoice' | 'changed' | 'idle';

/** What the panel can still be missing, in the order the header lists them. */
export type MissingField = 'barcode' | 'name' | 'weight' | 'expiry';

/**
 * Save button:
 * - disabled: nothing to save (no edit, no flag, no barcode conflict)
 * - warn: it saves, but the carton keeps its warning (a gate field is missing)
 * - ready: it saves and the carton is complete
 */
export type SaveMode = 'disabled' | 'warn' | 'ready';

export function weightState(weight: string): WeightState {
  const raw = (weight ?? '').trim();
  if (!raw) return 'missing';
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? 'ok' : 'invalid';
}

export function nameState(name: string, chips: ReadonlyArray<{ active: boolean }> = []): NameState {
  if (!(name ?? '').trim()) return 'missing';
  if (chips.length === 0) return 'ok';
  return chips.some((c) => c.active) ? 'ok' : 'offInvoice';
}

/**
 * Both dates are ISO `YYYY-MM-DD`, so a string comparison is a date
 * comparison. A carton that expires TODAY is already flagged: on the floor it
 * means the worker picked the calendar's "today" instead of the sticker's
 * date, which is how 64 tilapia cartons got their receiving day as expiry.
 */
export function expiryState(isoExpiry: string, todayIso: string): ExpiryState {
  const v = (isoExpiry ?? '').trim();
  if (!v) return 'missing';
  return v <= todayIso ? 'past' : 'ok';
}

/** Today in the device's own calendar, as `YYYY-MM-DD` (not UTC: Israel is ahead of it). */
export function localIsoDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Which field the panel opens on: the first one that still needs the worker
 * (the item, then the weight, then the expiry). A complete carton opens on
 * Weight, the value the OCR gets wrong most often.
 */
export function firstField(name: string, weight: string, expiry: string): EditField {
  if (!(name ?? '').trim()) return 'name';
  if (weightState(weight) !== 'ok') return 'weight';
  if (!(expiry ?? '').trim()) return 'expiry';
  return 'weight';
}

/**
 * Where to go after an invoice item was picked: on to whatever is still
 * missing, or stay on the item list when nothing is.
 */
export function fieldAfterItemPick(weight: string, expiry: string): EditField {
  if (weightState(weight) !== 'ok') return 'weight';
  if (!(expiry ?? '').trim()) return 'expiry';
  return 'name';
}

/**
 * Where to go after a date was picked in the calendar: back to the item or
 * the weight if either is still missing, otherwise stay on the expiry.
 */
export function fieldAfterExpiryPick(name: string, weight: string): EditField {
  if (!(name ?? '').trim()) return 'name';
  if (weightState(weight) !== 'ok') return 'weight';
  return 'expiry';
}

/**
 * The fields the header lists as "Missing: …". An expiry that is present but
 * in the past is not missing — its tile says what is wrong with it. A weight
 * of 0 is listed: it will not be saved, so the carton still has none.
 */
export function missingList(args: {
  name: string;
  weight: string;
  expiry: string;
  /** The carton has no barcode identity yet and none has been typed. */
  barcodeMissing?: boolean;
}): MissingField[] {
  const out: MissingField[] = [];
  if (args.barcodeMissing) out.push('barcode');
  if (!(args.name ?? '').trim()) out.push('name');
  if (weightState(args.weight) !== 'ok') out.push('weight');
  if (!(args.expiry ?? '').trim()) out.push('expiry');
  return out;
}

/**
 * The fields whose absence keeps the carton flagged after Save. Mirrors
 * handleSaveEdit in pallet-verify: a name, a weight above 0 and a barcode
 * identity. A missing expiry is shown, but does not block.
 */
export function gateMissing(args: { name: string; weight: string; barcodeMissing?: boolean }): boolean {
  return !!args.barcodeMissing || !(args.name ?? '').trim() || weightState(args.weight) !== 'ok';
}

/**
 * A flagged carton (needs review, or a barcode-vs-OCR conflict) can ALWAYS be
 * saved, even untouched: saving is how the worker says "I looked, it is
 * right", and a disabled Save would strand it.
 */
export function saveMode(args: {
  dirty: boolean;
  hasConflict: boolean;
  needsReview: boolean;
  gateMissing: boolean;
}): SaveMode {
  if (!args.dirty && !args.hasConflict && !args.needsReview) return 'disabled';
  return args.gateMissing ? 'warn' : 'ready';
}

/**
 * One tile's state. `changed` = its value differs from what the panel opened
 * with. The field being edited is drawn on top of this (blue frame), but its
 * value text keeps the amber / red of a missing or wrong value.
 */
export function tileState(
  field: EditField,
  s: { weight: WeightState; name: NameState; expiry: ExpiryState },
  changed: boolean,
): TileState {
  if (field === 'weight') {
    if (s.weight === 'missing') return 'missing';
    if (s.weight === 'invalid') return 'invalid';
  } else if (field === 'name') {
    if (s.name === 'missing') return 'missing';
    if (s.name === 'offInvoice') return 'offInvoice';
  } else {
    if (s.expiry === 'missing') return 'missing';
    if (s.expiry === 'past') return 'invalid';
  }
  return changed ? 'changed' : 'idle';
}

/** One choice in the panel's item list. */
export interface ItemOption {
  he: string;
  en: string;
  /** Every invoice item code that carries this name, in invoice order. */
  codes: string[];
}

/**
 * The invoice lines as the item list offers them: one row per distinct name.
 * Two lines with the same name (one item split over two prices) used to give
 * two rows that lit up together, so two rows looked selected at once. Picking
 * either one wrote the same name anyway, so they become one row that lists
 * both codes. Lines with no name at all are left out.
 */
export function itemOptions(
  lines: ReadonlyArray<{
    item_code?: string | null;
    item_name_hebrew?: string | null;
    item_name_english?: string | null;
  }>,
): ItemOption[] {
  const out: ItemOption[] = [];
  const byKey = new Map<string, ItemOption>();
  for (const line of lines) {
    const he = (line.item_name_hebrew ?? '').trim();
    const en = (line.item_name_english ?? '').trim();
    if (!he && !en) continue;
    const key = `${he}\u0000${en}`;
    let opt = byKey.get(key);
    if (!opt) {
      opt = { he, en, codes: [] };
      byKey.set(key, opt);
      out.push(opt);
    }
    const code = (line.item_code ?? '').trim();
    if (code && !opt.codes.includes(code)) opt.codes.push(code);
  }
  return out;
}
