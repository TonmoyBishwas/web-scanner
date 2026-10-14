/**
 * The non-meat "fill in what's missing" delivery-note form — pure logic.
 *
 * Contract (bot ↔ scanner, 2026-10-13): the bot writes a `receipt_forms` row
 * (header + lines pre-filled from the delivery note) and sends the worker a
 * signed link to /receive/{id}. The worker fixes only what is missing or red
 * and approves once; POST /api/receipt-form/{id} validates the answers with
 * `validateAnswers` below (the SAME rules the page shows live), marks the
 * row submitted and hands it to the bot, which re-checks and books it.
 *
 * Rules (client spec B2):
 * - received quantity finite, 0 ≤ q ≤ 1e6; cartons a whole number ≥ 0 or blank;
 * - an expiry is a real date AFTER today (Asia/Jerusalem) and at most 15 years
 *   ahead — never on/before today (lib/date-validation.ts's rule);
 * - a line that needs an expiry and was received (> 0) has a date or
 *   "no expiry" — "no expiry" is always possible, so the worker is never stuck;
 * - a short line (received < note − 0.0005) says why: will arrive / won't /
 *   other (+ a note 1..500 chars). An over line needs no reason.
 *
 * Client-safe: no node imports. Used by the page (client), the page's server
 * component and the API route.
 */
import { validateCartonDates } from './date-validation';

// ── Types (the receipt_forms row) ────────────────────────────────────────

export const PACKAGING = ['carton', 'sack', 'bag', 'bucket', 'crate', 'tray', 'bottle', 'unit', 'other'] as const;
export type Packaging = (typeof PACKAGING)[number];

export const PACKAGING_LABELS: Record<Packaging, { he: string; en: string }> = {
  carton: { he: 'קרטון', en: 'Carton' },
  sack: { he: 'שק', en: 'Sack' },
  bag: { he: 'שקית', en: 'Bag' },
  bucket: { he: 'דלי', en: 'Bucket' },
  crate: { he: 'ארגז', en: 'Crate' },
  tray: { he: 'מגש', en: 'Tray' },
  bottle: { he: 'בקבוק', en: 'Bottle' },
  unit: { he: 'יחידה', en: 'Unit' },
  other: { he: 'אחר', en: 'Other' },
};

export const EXTRA_UNITS = ['units', 'kg', 'cartons', 'packs', 'litres'] as const;
export type ExtraUnit = (typeof EXTRA_UNITS)[number];

export const EXTRA_UNIT_LABELS: Record<ExtraUnit, { he: string; en: string }> = {
  units: { he: "יח'", en: 'units' },
  kg: { he: 'ק"ג', en: 'kg' },
  cartons: { he: 'קרטונים', en: 'cartons' },
  packs: { he: 'אריזות', en: 'packs' },
  litres: { he: 'ליטר', en: 'litres' },
};

export const GAPS = ['will', 'wont', 'other'] as const;
export type Gap = (typeof GAPS)[number];

export type FormLanguage = 'Hebrew' | 'English';
export type FormStatus = 'open' | 'submitted' | 'processing' | 'done' | 'closed' | 'failed';

export interface FormHeader {
  supplier: string;
  invoice_number: string;
  /** 'YYYY-MM-DD' or '' */
  invoice_date: string;
  line_count: number;
}

export interface FormLine {
  /** 1-based */
  index: number;
  code: string;
  name_he: string;
  name_en: string;
  /** The note's figure. */
  qty: number;
  unit: string;
  /** Display word in the form's language, e.g. 'ק"ג' / "יח'". */
  unit_label: string;
  /** qty is a weight in kg. */
  weighed: boolean;
  cartons: number | null;
  packaging: Packaging | null;
  needs_expiry: boolean;
}

export interface LineAnswer {
  index: number;
  received_qty: number;
  cartons: number | null;
  packaging: Packaging | null;
  expiry_date: string | null;
  no_expiry: boolean;
  gap: Gap | null;
  gap_note: string | null;
}

export interface ExtraItem {
  name: string;
  quantity: number;
  unit: ExtraUnit;
}

export interface Answers {
  pallets: number | null;
  lines: LineAnswer[];
  extras: ExtraItem[];
}

// ── Limits ───────────────────────────────────────────────────────────────

export const MAX_QTY = 1e6;
export const MAX_EXTRAS = 20;
export const MAX_GAP_NOTE = 500;
export const MAX_EXTRA_NAME = 200;
export const MAX_PALLETS = 999;
export const EXPIRY_MAX_YEARS = 15;
/** Below this a received quantity counts as short (float noise, not a grace band). */
export const SHORT_EPSILON = 0.0005;

// ── Error codes (each maps to one `receive.err.*` message) ───────────────

export type LineError =
  | 'qty_invalid'
  | 'cartons_invalid'
  | 'packaging_invalid'
  | 'expiry_missing'
  | 'expiry_invalid'
  | 'expiry_not_future'
  | 'expiry_too_far'
  | 'expiry_conflict'
  | 'gap_missing'
  | 'gap_invalid'
  | 'gap_note_missing'
  | 'gap_note_too_long';

export type ExtraError = 'extra_name_missing' | 'extra_name_too_long' | 'extra_qty_invalid' | 'extra_unit_invalid';

export type FormError = 'pallets_invalid' | 'lines_mismatch' | 'too_many_extras';

export interface ValidationResult {
  ok: boolean;
  /** line index → its errors (only lines with errors appear). */
  lines: Record<number, LineError[]>;
  /** extras array position → its errors. */
  extras: Record<number, ExtraError[]>;
  form: FormError[];
}

// ── Dates ────────────────────────────────────────────────────────────────

/** Today in Israel as `YYYY-MM-DD` — the receiving day, whatever the server's zone. */
export function todayInJerusalem(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A real calendar date in strict `YYYY-MM-DD` (2026-02-30 is not). */
export function isRealIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** ISO date `days` after `iso`. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The last accepted expiry: today + 15 years (29 Feb rolls to 1 Mar). */
export function maxExpiryIso(todayIso: string): string {
  const [y, m, d] = todayIso.split('-').map(Number);
  return new Date(Date.UTC(y + EXPIRY_MAX_YEARS, m - 1, d)).toISOString().slice(0, 10);
}

/** The expiry rule alone: null when the date is acceptable. */
export function expiryError(iso: string, todayIso: string): LineError | null {
  if (!isRealIsoDate(iso)) return 'expiry_invalid';
  // The shared carton rule: an expiry on/before the receiving day is refused.
  if (validateCartonDates({ expiry: iso, receiptDate: todayIso }).expiryError) return 'expiry_not_future';
  if (iso > maxExpiryIso(todayIso)) return 'expiry_too_far';
  return null;
}

/** `2026-10-13` → `13/10/2026`; '' stays ''. */
export function formatDdMmYyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || '';
}

// ── Quantities ───────────────────────────────────────────────────────────

/** Received is short of the note (beyond float noise). */
export function isShort(line: Pick<FormLine, 'qty'>, received: number): boolean {
  return Number.isFinite(received) && Number.isFinite(line.qty) && received < line.qty - SHORT_EPSILON;
}

/** Received is more than the note (beyond float noise). */
export function isOver(line: Pick<FormLine, 'qty'>, received: number): boolean {
  return Number.isFinite(received) && Number.isFinite(line.qty) && received > line.qty + SHORT_EPSILON;
}

/** A quantity for display: at most 3 decimals, no trailing zeros. */
export function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(3)));
}

/**
 * What the worker typed → a number. Accepts a decimal comma (Hebrew
 * keyboards). Blank or anything else → NaN, which validation reports.
 */
export function parseDecimal(s: string): number {
  const v = (s ?? '').trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return NaN;
  return Number(v);
}

/** A whole number ≥ 0 typed by the worker; blank → null; anything else → NaN. */
export function parseWholeOrBlank(s: string): number | null {
  const v = (s ?? '').trim();
  if (!v) return null;
  return /^\d{1,9}$/.test(v) ? Number(v) : NaN;
}

// ── Validation (page live + API) ─────────────────────────────────────────

function isWholeOrNull(n: unknown, max: number): boolean {
  return n === null || (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max);
}

export function validateLine(line: FormLine, a: LineAnswer, todayIso: string): LineError[] {
  const errs: LineError[] = [];
  const q = a.received_qty;
  const qtyOk = typeof q === 'number' && Number.isFinite(q) && q >= 0 && q <= MAX_QTY;
  if (!qtyOk) errs.push('qty_invalid');
  if (!isWholeOrNull(a.cartons, MAX_QTY)) errs.push('cartons_invalid');
  if (a.packaging !== null && !(PACKAGING as readonly string[]).includes(a.packaging)) errs.push('packaging_invalid');

  // Expiry: a date that is given is always judged; one is required only on a
  // line that needs it and actually arrived.
  if (a.expiry_date !== null && a.expiry_date !== '') {
    if (a.no_expiry) errs.push('expiry_conflict');
    else {
      const e = expiryError(a.expiry_date, todayIso);
      if (e) errs.push(e);
    }
  } else if (line.needs_expiry && qtyOk && q > 0 && !a.no_expiry) {
    errs.push('expiry_missing');
  }

  if (qtyOk && isShort(line, q)) {
    if (a.gap === null) errs.push('gap_missing');
    else if (!(GAPS as readonly string[]).includes(a.gap)) errs.push('gap_invalid');
    else if (a.gap === 'other') {
      const note = (a.gap_note ?? '').trim();
      if (!note) errs.push('gap_note_missing');
      else if (note.length > MAX_GAP_NOTE) errs.push('gap_note_too_long');
    }
  } else if (a.gap !== null && !(GAPS as readonly string[]).includes(a.gap)) {
    errs.push('gap_invalid');
  }
  return errs;
}

export function validateExtra(x: ExtraItem): ExtraError[] {
  const errs: ExtraError[] = [];
  const name = (x.name ?? '').trim();
  if (!name) errs.push('extra_name_missing');
  else if (name.length > MAX_EXTRA_NAME) errs.push('extra_name_too_long');
  const q = x.quantity;
  if (!(typeof q === 'number' && Number.isFinite(q) && q > 0 && q <= MAX_QTY)) errs.push('extra_qty_invalid');
  if (!(EXTRA_UNITS as readonly string[]).includes(x.unit)) errs.push('extra_unit_invalid');
  return errs;
}

/**
 * Every rule the API enforces, and the page shows live. `answers.lines` must
 * hold every form line's index exactly once (order free).
 */
export function validateAnswers(lines: FormLine[], answers: Answers, todayIso: string): ValidationResult {
  const res: ValidationResult = { ok: true, lines: {}, extras: {}, form: [] };

  if (!isWholeOrNull(answers.pallets, MAX_PALLETS)) res.form.push('pallets_invalid');

  const byIndex = new Map<number, LineAnswer>();
  let mismatch = answers.lines.length !== lines.length;
  for (const a of answers.lines) {
    if (byIndex.has(a.index)) mismatch = true;
    byIndex.set(a.index, a);
  }
  for (const line of lines) {
    const a = byIndex.get(line.index);
    if (!a) {
      mismatch = true;
      continue;
    }
    const errs = validateLine(line, a, todayIso);
    if (errs.length) res.lines[line.index] = errs;
  }
  if (mismatch) res.form.push('lines_mismatch');

  if (answers.extras.length > MAX_EXTRAS) res.form.push('too_many_extras');
  answers.extras.forEach((x, i) => {
    const errs = validateExtra(x);
    if (errs.length) res.extras[i] = errs;
  });

  res.ok = res.form.length === 0 && Object.keys(res.lines).length === 0 && Object.keys(res.extras).length === 0;
  return res;
}

// ── Untrusted JSON → Answers (API) ───────────────────────────────────────

function strOrNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Shape-check a request body's `answers`. Wrong TYPES are refused here
 * (null); wrong VALUES are left for `validateAnswers` to report per line.
 */
export function parseAnswers(raw: unknown): Answers | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.pallets !== null && r.pallets !== undefined && typeof r.pallets !== 'number') return null;
  if (!Array.isArray(r.lines) || r.lines.length > 500) return null;
  if (r.extras !== undefined && r.extras !== null && !Array.isArray(r.extras)) return null;
  const rawExtras = (r.extras ?? []) as unknown[];
  if (rawExtras.length > 100) return null;

  const lines: LineAnswer[] = [];
  for (const l of r.lines) {
    if (!l || typeof l !== 'object') return null;
    const o = l as Record<string, unknown>;
    if (typeof o.index !== 'number' || !Number.isInteger(o.index)) return null;
    if (typeof o.received_qty !== 'number') return null;
    if (o.cartons !== null && o.cartons !== undefined && typeof o.cartons !== 'number') return null;
    const packaging = strOrNull(o.packaging);
    const expiry = strOrNull(o.expiry_date);
    const gap = strOrNull(o.gap);
    const gapNote = strOrNull(o.gap_note);
    if (packaging === undefined || expiry === undefined || gap === undefined || gapNote === undefined) return null;
    if (o.no_expiry !== undefined && typeof o.no_expiry !== 'boolean') return null;
    lines.push({
      index: o.index,
      received_qty: o.received_qty,
      cartons: (o.cartons as number | null | undefined) ?? null,
      packaging: packaging as Packaging | null,
      expiry_date: expiry === '' ? null : expiry,
      no_expiry: o.no_expiry === true,
      gap: gap as Gap | null,
      gap_note: gapNote,
    });
  }

  const extras: ExtraItem[] = [];
  for (const x of rawExtras) {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.quantity !== 'number' || typeof o.unit !== 'string') return null;
    extras.push({ name: o.name.trim(), quantity: o.quantity, unit: o.unit as ExtraUnit });
  }

  return { pallets: (r.pallets as number | null | undefined) ?? null, lines, extras };
}

// ── The DB row → safe shapes (the page) ──────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** `receipt_forms.lines` as stored by the bot → FormLine[], defensively. */
export function normalizeFormLines(raw: unknown): FormLine[] {
  if (!Array.isArray(raw)) return [];
  const out: FormLine[] = [];
  raw.forEach((l, i) => {
    if (!l || typeof l !== 'object') return;
    const o = l as Record<string, unknown>;
    const qty = typeof o.qty === 'number' ? o.qty : Number(o.qty);
    const cartons = typeof o.cartons === 'number' && Number.isInteger(o.cartons) && o.cartons >= 0 ? o.cartons : null;
    const packaging = (PACKAGING as readonly string[]).includes(o.packaging as string) ? (o.packaging as Packaging) : null;
    out.push({
      index: typeof o.index === 'number' && Number.isInteger(o.index) ? o.index : i + 1,
      code: str(o.code),
      name_he: str(o.name_he),
      name_en: str(o.name_en),
      qty: Number.isFinite(qty) ? qty : 0,
      unit: str(o.unit),
      unit_label: str(o.unit_label),
      weighed: o.weighed === true,
      cartons,
      packaging,
      needs_expiry: o.needs_expiry === true,
    });
  });
  return out;
}

export function normalizeFormHeader(raw: unknown, lineCount: number): FormHeader {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = Number(o.line_count);
  return {
    supplier: str(o.supplier),
    invoice_number: str(o.invoice_number),
    invoice_date: isRealIsoDate(o.invoice_date) ? (o.invoice_date as string) : '',
    line_count: Number.isInteger(n) && n > 0 ? n : lineCount,
  };
}

// ── The page's editable draft (strings while typing) ─────────────────────

export interface LineDraft {
  index: number;
  qty: string;
  cartons: string;
  packaging: Packaging | '';
  expiry: string;
  noExpiry: boolean;
  gap: Gap | null;
  gapNote: string;
}

export interface ExtraDraft {
  /** Stable React key. */
  key: string;
  name: string;
  quantity: string;
  unit: ExtraUnit;
}

export interface FormDraft {
  pallets: string;
  lines: LineDraft[];
  extras: ExtraDraft[];
}

/** Everything pre-filled from the note. */
export function initialDraft(lines: FormLine[]): FormDraft {
  return {
    pallets: '',
    lines: lines.map((l) => ({
      index: l.index,
      qty: fmtQty(l.qty),
      cartons: l.cartons === null ? '' : String(l.cartons),
      packaging: l.packaging ?? '',
      expiry: '',
      noExpiry: false,
      gap: null,
      gapNote: '',
    })),
    extras: [],
  };
}

/**
 * Draft → the answers to POST. A reason is only sent for a line that is
 * still short (a cleared shortage drops a stale reason), a note only for
 * 'other', and a date never together with "no expiry".
 */
export function draftToAnswers(lines: FormLine[], draft: FormDraft): Answers {
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  return {
    pallets: parseWholeOrBlank(draft.pallets),
    lines: draft.lines.map((d) => {
      const line = byIndex.get(d.index);
      const q = parseDecimal(d.qty);
      const short = line ? isShort(line, q) : false;
      const gap = short ? d.gap : null;
      return {
        index: d.index,
        received_qty: q,
        cartons: parseWholeOrBlank(d.cartons),
        packaging: d.packaging === '' ? null : d.packaging,
        expiry_date: d.noExpiry || !d.expiry ? null : d.expiry,
        no_expiry: d.noExpiry,
        gap,
        gap_note: gap === 'other' ? d.gapNote.trim() : null,
      };
    }),
    extras: draft.extras.map((x) => ({ name: x.name.trim(), quantity: parseDecimal(x.quantity), unit: x.unit })),
  };
}

/** Does this line still want an expiry decision (a date or "no expiry")? */
function wantsExpiry(line: FormLine | undefined, d: LineDraft): boolean {
  return !!line && line.needs_expiry && !d.expiry && !d.noExpiry;
}

/** "One date for all lines": fills every needs-expiry line with no date and no "no expiry". */
export function applySameDateToAll(lines: FormLine[], drafts: LineDraft[], iso: string): LineDraft[] {
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  return drafts.map((d) => (wantsExpiry(byIndex.get(d.index), d) ? { ...d, expiry: iso } : d));
}

/** "The rest have no expiry": every needs-expiry line still without a date → no expiry. */
export function markRestNoExpiry(lines: FormLine[], drafts: LineDraft[]): LineDraft[] {
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  return drafts.map((d) => (wantsExpiry(byIndex.get(d.index), d) ? { ...d, noExpiry: true } : d));
}

/** How many needs-expiry lines still have neither a date nor "no expiry". */
export function countWantingExpiry(lines: FormLine[], drafts: LineDraft[]): number {
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  return drafts.filter((d) => wantsExpiry(byIndex.get(d.index), d)).length;
}

/** Rows that still block approval: lines + extras with errors, + 1 for a bad pallet count. */
export function remainingCount(v: ValidationResult): number {
  return (
    Object.keys(v.lines).length +
    Object.keys(v.extras).length +
    (v.form.includes('pallets_invalid') ? 1 : 0) +
    (v.form.includes('too_many_extras') ? 1 : 0)
  );
}

// ── Draft persistence (localStorage, per form) ───────────────────────────

export function draftStorageKey(formId: string): string {
  return `receipt-form-draft:${formId}`;
}

/**
 * A stored draft, if it still fits these lines (same indexes in the same
 * order) — otherwise null, and the page starts from the note again.
 */
export function restoreDraft(raw: string | null, lines: FormLine[]): FormDraft | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: number; draft?: FormDraft };
    const d = o?.draft;
    if (o?.v !== 1 || !d || !Array.isArray(d.lines) || !Array.isArray(d.extras)) return null;
    if (d.lines.length !== lines.length) return null;
    for (let i = 0; i < lines.length; i++) {
      const l = d.lines[i];
      if (!l || l.index !== lines[i].index) return null;
      if (typeof l.qty !== 'string' || typeof l.cartons !== 'string' || typeof l.expiry !== 'string') return null;
      if (typeof l.noExpiry !== 'boolean' || typeof l.gapNote !== 'string') return null;
      if (l.packaging !== '' && !(PACKAGING as readonly string[]).includes(l.packaging)) return null;
      if (l.gap !== null && !(GAPS as readonly string[]).includes(l.gap)) return null;
    }
    const extras = d.extras
      .filter(
        (x) =>
          x &&
          typeof x.key === 'string' &&
          typeof x.name === 'string' &&
          typeof x.quantity === 'string' &&
          (EXTRA_UNITS as readonly string[]).includes(x.unit),
      )
      .slice(0, MAX_EXTRAS);
    return { pallets: typeof d.pallets === 'string' ? d.pallets : '', lines: d.lines, extras };
  } catch {
    return null;
  }
}

export function serializeDraft(draft: FormDraft): string {
  return JSON.stringify({ v: 1, draft, savedAt: Date.now() });
}
