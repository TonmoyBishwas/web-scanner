/**
 * The non-meat receive form v3 (Claude Design "Non-Meat Receive Form",
 * approved by Mevaser 01/11) — shared types, constants and pure logic.
 *
 * Behind the scanner flag `receive_form_v3` (lib/scanner-flags.ts
 * receiveFormV3On), OFF. With the flag off nothing here runs.
 *
 * The worker's answers keep today's keys with today's meaning (the bot's
 * `receipt_form.validate_answers` reads index, received_qty, cartons,
 * packaging, expiry_date, no_expiry, gap, gap_note per line and pallets /
 * extras at the top). v3 adds OPTIONAL keys the bot ignores: per line
 * `pallet`, `loose_qty`, `split_unit`, `splits`; at the top `form_version: 3`
 * and `loose_lines`. A split line's `expiry_date` is its EARLIEST split date,
 * so Priority receives exactly what it receives today.
 *
 * Client-safe: no node imports. Used by the v3 page (client), the page's
 * server component and the API route. Spec: docs/RECEIVE_FORM_V3.md.
 */
import {
  EXTRA_UNITS,
  MAX_EXTRAS,
  MAX_QTY,
  PACKAGING,
  PACKAGING_LABELS,
  PACKAGING_PLURAL,
  PACKAGING_SINGULAR,
  SHORT_EPSILON,
  GAPS,
  expiryError,
  fingerprints,
  fmtQty,
  isRealIsoDate,
  isShort,
  lineFingerprint,
  parseDecimal,
  parseWholeOrBlank,
  type Answers,
  type ExtraDraft,
  type FormDraft,
  type FormHeader,
  type FormLanguage,
  type FormLine,
  type Gap,
  type LineAnswer,
  type Packaging,
} from './receipt-form';

// ── Constants ─────────────────────────────────────────────────────────────

export const V3 = {
  /** The bot refuses more (receipt_form.validate_answers `bad_pallets`). */
  MAX_PALLETS: 50,
  MAX_SPLIT_ROWS: 3,
  AUTO_COLLAPSE_MS: 1400,
  MIN_STEP_MS: 600,
  STEP_GAP_MS: 400,
  REDIRECT_DELAY_MS: 900,
  REDIRECT_MS: 3000,
  CLOSE_FALLBACK_MS: 800,
  STATUS_POLL_MS: 3000,
  PRIORITY_TIMEOUT_MS: 120_000,
  FORM_POLL_MS: 15_000,
  HEADER_COLLAPSE_AT: 24,
  HEADER_EXPAND_AT: 4,
  SWIPE_MIN_PX: 40,
} as const;

/** The answers' marker for a v3 body (`answers.form_version`). */
export const V3_FORM_VERSION = 3;

// ── Types ─────────────────────────────────────────────────────────────────

export type V3Mode = 'same' | 'pack' | 'two';
export type V3LineStatus = 'ready' | 'expiry' | 'gap' | 'pallet' | 'fix';
export type V3ExpState = 'ok' | 'empty' | 'partial' | 'invalid' | 'past' | 'far' | 'over';
/** 'none' = nothing arrived (quantity 0): no pallet needed. */
export type V3PalletValue = number | 'loose' | 'none' | null;

/** One split row while typing; `date` is typed 'dd.mm.yyyy'. */
export interface V3SplitRow {
  qty: string;
  date: string;
}

export interface V3LineDraft {
  index: number;
  qty: string;
  cartons: string;
  packaging: Packaging | '';
  /** Typed 'dd.mm.yyyy' (partial while typing), '' = none. */
  expiry: string;
  noExpiry: boolean;
  split: V3SplitRow[] | null;
  gap: Gap | null;
  gapNote: string;
  /** The chosen pallet (pallets ≥ 2). */
  pallet: number | null;
  /** Step 1 acknowledged (the prototype's s2ok). */
  ack: boolean;
  /** Step 1 edited (the prototype's s2edit). */
  edited: boolean;
}

export interface V3Draft {
  stage: 'pallets' | 'list';
  /** 0..50 */
  pallets: number;
  /** Line index → packages outside the pallet. */
  loose: Record<number, number>;
  lastPallet: number | null;
  lines: V3LineDraft[];
  extras: ExtraDraft[];
}

export interface V3SplitState {
  /** The basis the rows must add up to (packages, or the quantity for a 'two' line). */
  total: number;
  sum: number;
  left: number;
  over: boolean;
  missing: boolean;
  bad: 'invalid' | 'past' | 'far' | null;
}

export interface V3Rail {
  s1: boolean;
  s2: boolean;
  s3: boolean;
  active: 1 | 2 | 3;
}

export interface LineAnswerV3 extends LineAnswer {
  pallet?: number | 'loose' | null;
  loose_qty?: number | null;
  split_unit?: 'packages' | 'qty';
  splits?: { qty: number; expiry_date: string }[];
}

export interface AnswersV3 extends Omit<Answers, 'lines'> {
  lines: LineAnswerV3[];
  form_version: 3;
  loose_lines: number;
}

export type V3LineError =
  | 'pallet_missing'
  | 'pallet_out_of_range'
  | 'loose_invalid'
  | 'split_invalid'
  | 'split_sum'
  | 'split_expiry';
export type V3FormError = 'pallets_range' | 'nothing_to_receive';
export interface V3Validation {
  ok: boolean;
  lines: Record<number, V3LineError[]>;
  form: V3FormError[];
}

export type V3Erp = 'priority' | 'none';
export type V3Outcome = 'pending' | 'success' | 'partial' | 'timeout' | 'failed';
export interface V3StatusResponse {
  ok: true;
  erp: V3Erp;
  form_status: string;
  outcome: V3Outcome;
  docno: string | null;
  office_lines: number | null;
  submitted_at: string | null;
}

export type V3NoticeKind = 'alreadySaved' | 'beingSaved' | 'failed' | 'linkInvalid' | 'cancelled' | 'duplicate' | 'replaced';

export interface ReceiveV3Boot {
  notePhotos: string[];
  erp: V3Erp;
  /** Digits only; null = "סגרו" calls window.close() only. */
  botWaNumber: string | null;
  /** 'YYYY-MM-DD', Asia/Jerusalem, from the server render. */
  today: string;
}

export type V3InitialView =
  | { kind: 'form' }
  | { kind: 'status' }
  | { kind: 'notice'; notice: V3NoticeKind; newer?: { id: string; href: string } | null };

/** The one component the integrator / page renders. */
export interface ReceiveFormV3Props {
  formId: string;
  exp: string;
  sig: string;
  language: FormLanguage;
  header: FormHeader;
  lines: FormLine[];
  previousFormIds: string[];
  boot: ReceiveV3Boot;
  initialView: V3InitialView;
}

// ── Small helpers ─────────────────────────────────────────────────────────

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const digitsOf = (s: string) => (s ?? '').replace(/\D/g, '');

/** A whole number typed in a field; '' / junk → null. */
function whole(s: string): number | null {
  const n = parseWholeOrBlank(s);
  return n === null || Number.isNaN(n) ? null : n;
}

/** The line's package count for "outside the pallet": its cartons, or 1 when blank / 0. */
function packagesOf(d: Pick<V3LineDraft, 'cartons'>): number {
  return Math.max(whole(d.cartons) ?? 1, 1);
}

// ── Mode ──────────────────────────────────────────────────────────────────

/**
 * How step 1 lays out a line: 'same' = the package count IS the quantity
 * (one stepper), 'pack' = packages × units per package (the units total
 * follows the stepper), 'two' = a weight or a quantity and a package count
 * typed separately. A counted line whose packages ≠ units and no per_pack is
 * 'two' [INFERRED, spec O6].
 */
export function lineMode(line: FormLine): V3Mode {
  if (line.weighed) return 'two';
  if (line.per_pack !== null) return 'pack';
  if (line.cartons !== null && Math.abs(line.cartons - line.qty) < SHORT_EPSILON) return 'same';
  return 'two';
}

// ── The draft ─────────────────────────────────────────────────────────────

function initialLineDraft(l: FormLine): V3LineDraft {
  return {
    index: l.index,
    qty: fmtQty(l.qty),
    cartons: l.cartons === null ? '' : String(l.cartons),
    packaging: l.packaging ?? '',
    expiry: '',
    noExpiry: false,
    split: null,
    gap: null,
    gapNote: '',
    pallet: null,
    ack: false,
    edited: false,
  };
}

/** Everything pre-filled from the note; step 1 (pallets) first, 0 pallets. */
export function initialV3Draft(lines: FormLine[]): V3Draft {
  return { stage: 'pallets', pallets: 0, loose: {}, lastPallet: null, lines: lines.map(initialLineDraft), extras: [] };
}

// ── Dates ('dd.mm.yyyy' while typing) ─────────────────────────────────────

/** Up to 8 digits → 'dd', 'dd.mm', 'dd.mm.yyyy' (partial while typing). */
function dotted(d: string): string {
  const x = d.slice(0, 8);
  return x.slice(0, 2) + (x.length > 2 ? '.' + x.slice(2, 4) : '') + (x.length > 4 ? '.' + x.slice(4) : '');
}

/**
 * One keystroke in a date field (the prototype's typeDate): digits only, dots
 * after 2 and 4 digits, at most 8 digits. A backspace right after a dot
 * deletes the digit before it (cursor-aware). A 6th digit whose year part is
 * not 19/20 expands at once to 20yy ('120527' → '12.05.2027').
 */
export function typeDate(raw: string, old: string, selectionStart: number | null): string {
  raw = raw ?? '';
  old = old ?? '';
  let d = digitsOf(raw);
  const od = digitsOf(old);
  if (raw.length < old.length && d === od) {
    // Only a dot went: drop the digit before the cursor instead.
    const sel = selectionStart ?? raw.length;
    const pos = digitsOf(raw.slice(0, sel)).length;
    d = d.slice(0, Math.max(0, pos - 1)) + d.slice(pos);
  }
  d = d.slice(0, 8);
  if (d.length > od.length && d.length === 6 && !/^(19|20)$/.test(d.slice(4, 6))) d = d.slice(0, 4) + '20' + d.slice(4);
  return dotted(d);
}

/** On blur: a 6-digit date expands to 20yy ('12.05.27' → '12.05.2027'); anything else stays. */
export function expandDate(value: string): string {
  const d = digitsOf(value);
  return d.length === 6 ? `${d.slice(0, 2)}.${d.slice(2, 4)}.20${d.slice(4)}` : value;
}

/** 8 typed digits → 'yyyy-mm-dd' as typed (not checked); fewer → null. */
function typedIso(value: string): string | null {
  const d = digitsOf(value);
  if (d.length !== 8) return null;
  return `${d.slice(4, 8)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
}

/** 'dd.mm.yyyy' → 'yyyy-mm-dd' when it is a real date; anything else → null. */
export function dottedToIso(value: string): string | null {
  const iso = typedIso(value);
  return iso && isRealIsoDate(iso) && Number(iso.slice(0, 4)) >= 1900 ? iso : null;
}

/** 'yyyy-mm-dd' → 'dd.mm.yyyy' (the calendar pick); junk → ''. */
export function isoToDotted(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/**
 * A typed date against today: 'empty' / 'partial' (< 8 digits), 'invalid'
 * (not a real date), else lib/receipt-form.ts expiryError's rule — 'past'
 * (on/before today) or 'far' (> 15 years) — so page and server never disagree.
 */
export function dateCheck(value: string, today: string): 'ok' | 'invalid' | 'past' | 'far' | 'partial' | 'empty' {
  const d = digitsOf(value);
  if (!d.length) return 'empty';
  if (d.length < 8) return 'partial';
  const iso = dottedToIso(value);
  if (!iso) return 'invalid';
  const e = expiryError(iso, today);
  if (e === 'expiry_not_future') return 'past';
  if (e === 'expiry_too_far') return 'far';
  if (e) return 'invalid';
  return 'ok';
}

// ── Split by expiry ───────────────────────────────────────────────────────

/**
 * What the split rows must add up to [DEFAULT 3]: packages for a 'pack' line
 * (its cartons), the quantity otherwise (= packages on a 'same' line, kg on
 * a weighed one).
 */
export function splitBasis(line: FormLine, d: V3LineDraft): number {
  const n = lineMode(line) === 'pack' ? whole(d.cartons) ?? 0 : parseDecimal(d.qty);
  return Number.isFinite(n) ? n : 0;
}

export function splitState(line: FormLine, d: V3LineDraft, today: string): V3SplitState {
  const total = splitBasis(line, d);
  let sum = 0;
  let missing = false;
  let bad: V3SplitState['bad'] = null;
  for (const r of d.split ?? []) {
    const q = parseDecimal(r.qty);
    if (!Number.isFinite(q) || q <= 0) missing = true;
    else sum += q;
    const c = dateCheck(r.date, today);
    if (c === 'empty' || c === 'partial') missing = true;
    else if (c !== 'ok' && !bad) bad = c;
  }
  sum = round3(sum);
  const left = round3(total - sum);
  return { total, sum, left, over: sum - total > SHORT_EPSILON, missing, bad };
}

/** Row 1 takes what the other rows leave: max(0, total − Σ others). */
export function balanceSplit(rows: V3SplitRow[], total: number): V3SplitRow[] {
  if (!rows.length) return rows;
  const others = rows.slice(1).reduce((a, r) => {
    const q = parseDecimal(r.qty);
    return a + (Number.isFinite(q) ? q : 0);
  }, 0);
  return [{ ...rows[0], qty: fmtQty(Math.max(0, round3(total - others))) }, ...rows.slice(1)];
}

/** `פיצול לפי תוקף`: the whole basis on the current date, plus an empty row; "no expiry" off. */
export function startSplitPatch(line: FormLine, d: V3LineDraft): Partial<V3LineDraft> {
  return { split: [{ qty: fmtQty(splitBasis(line, d)), date: d.expiry }, { qty: '', date: '' }], noExpiry: false };
}

/** `+ תוקף נוסף` (fewer than 3 rows): a row holding what is left. */
export function addSplitRowPatch(line: FormLine, d: V3LineDraft, today: string): Partial<V3LineDraft> {
  const rows = d.split ?? [];
  if (rows.length >= V3.MAX_SPLIT_ROWS) return {};
  const s = splitState(line, d, today);
  return { split: [...rows, { qty: fmtQty(Math.max(0, s.left)), date: '' }] };
}

/** A row's quantity typed: rows after the first re-balance row 1; row 1 itself does not. */
export function setSplitQtyPatch(line: FormLine, d: V3LineDraft, k: number, qty: string): Partial<V3LineDraft> {
  const rows = (d.split ?? []).map((r, j) => (j === k ? { ...r, qty } : r));
  return { split: k > 0 ? balanceSplit(rows, splitBasis(line, d)) : rows };
}

/** × on a row: one row left ends the split (its date becomes the single expiry); else row 1 re-balances. */
export function removeSplitRowPatch(line: FormLine, d: V3LineDraft, k: number): Partial<V3LineDraft> {
  const rows = (d.split ?? []).filter((_, j) => j !== k);
  if (rows.length <= 1) return { split: null, expiry: rows[0]?.date ?? '' };
  return { split: balanceSplit(rows, splitBasis(line, d)) };
}

/** The earliest valid split date as ISO; null when none. */
function earliestSplitIso(rows: V3SplitRow[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const iso = typedIso(r.date);
    if (iso && (best === null || iso < best)) best = iso;
  }
  return best;
}

// ── Line status ───────────────────────────────────────────────────────────

/**
 * Where the expiry stands. Nothing arrived (0) needs no expiry [INFERRED];
 * a line that does not need one is fine empty [INFERRED] — both as
 * validateLine.
 */
export function expState(line: FormLine, d: V3LineDraft, today: string): V3ExpState {
  const q = parseDecimal(d.qty);
  if (q === 0) return 'ok';
  if (d.split) {
    const s = splitState(line, d, today);
    if (s.over) return 'over';
    if (s.bad) return s.bad;
    if (s.missing || Math.abs(s.left) >= SHORT_EPSILON) return 'partial';
    return 'ok';
  }
  if (d.noExpiry) return 'ok';
  const c = dateCheck(d.expiry, today);
  if (c === 'empty') return line.needs_expiry ? 'empty' : 'ok';
  return c;
}

/**
 * The line's pallet: nothing arrived → 'none'; outside the pallet (ticked,
 * or 0 pallets) → 'loose'; 1 pallet → 1; else the chosen one while it is
 * within the count, or null (still to choose).
 */
export function palletOf(line: FormLine, d: V3LineDraft, draft: V3Draft): V3PalletValue {
  if (parseDecimal(d.qty) === 0) return 'none';
  if (Object.prototype.hasOwnProperty.call(draft.loose, line.index)) return 'loose';
  if (draft.pallets === 0) return 'loose';
  if (draft.pallets === 1) return 1;
  return typeof d.pallet === 'number' && Number.isInteger(d.pallet) && d.pallet >= 1 && d.pallet <= draft.pallets
    ? d.pallet
    : null;
}

function qtyBroken(d: V3LineDraft): boolean {
  const q = parseDecimal(d.qty);
  if (!Number.isFinite(q) || q < 0 || q > MAX_QTY) return true;
  const c = parseWholeOrBlank(d.cartons);
  return c !== null && (Number.isNaN(c) || c > MAX_QTY);
}

/** fix → gap → expiry → pallet → ready (the prototype's status(), in this order). */
export function lineStatusV3(line: FormLine, d: V3LineDraft, draft: V3Draft, today: string): V3LineStatus {
  if (qtyBroken(d)) return 'fix';
  const q = parseDecimal(d.qty);
  if (isShort(line, q) && (d.gap === null || (d.gap === 'other' && !d.gapNote.trim()))) return 'gap';
  const e = expState(line, d, today);
  if (e === 'empty' || e === 'partial') return 'expiry';
  if (e !== 'ok') return 'fix';
  if (palletOf(line, d, draft) === null) return 'pallet';
  return 'ready';
}

/** The three rail dots; active = the first not done. */
export function railState(line: FormLine, d: V3LineDraft, draft: V3Draft, today: string): V3Rail {
  const st = lineStatusV3(line, d, draft, today);
  const s1 = st !== 'gap' && st !== 'fix' && (d.ack || d.edited);
  const s2 = expState(line, d, today) === 'ok';
  const s3 = palletOf(line, d, draft) !== null;
  return { s1, s2, s3, active: !s1 ? 1 : !s2 ? 2 : 3 };
}

/** The inline pallet list opens by itself: ≥ 2 pallets, no pallet yet, steps 1–2 done, not closed by ×. */
export function shouldAutoOpenPalletList(
  line: FormLine,
  d: V3LineDraft,
  draft: V3Draft,
  today: string,
  closedByUser: boolean,
): boolean {
  if (closedByUser || draft.pallets < 2) return false;
  if (palletOf(line, d, draft) !== null) return false;
  const r = railState(line, d, draft, today);
  return r.s1 && r.s2;
}

/** Line indexes not ready, in note order. */
export function remainingLines(lines: FormLine[], draft: V3Draft, today: string): number[] {
  const byIndex = new Map(draft.lines.map((d) => [d.index, d]));
  return lines
    .filter((l) => {
      const d = byIndex.get(l.index);
      return !d || lineStatusV3(l, d, draft, today) !== 'ready';
    })
    .map((l) => l.index);
}

// ── Step 1 edits ──────────────────────────────────────────────────────────

/**
 * The package stepper / field: 'same' → the quantity follows (blank = 0);
 * 'pack' → the units total follows when it still equalled packages × per
 * pack (else the worker typed a total, which stays); 'two' → packages alone.
 * Every step-1 edit marks the line edited.
 */
export function setCartonsPatch(line: FormLine, d: V3LineDraft, value: string): Partial<V3LineDraft> {
  const v = digitsOf(value).slice(0, 6);
  const n = v === '' ? null : Number(v);
  const p: Partial<V3LineDraft> = { cartons: v === '' ? '' : String(n), edited: true };
  const mode = lineMode(line);
  if (mode === 'same') p.qty = n === null ? '0' : String(n);
  if (mode === 'pack' && line.per_pack !== null) {
    const old = (whole(d.cartons) ?? 0) * line.per_pack;
    const q = parseDecimal(d.qty);
    if (Math.abs((Number.isFinite(q) ? q : 0) - old) < SHORT_EPSILON) p.qty = fmtQty((n ?? 0) * line.per_pack);
  }
  return p;
}

/** `כמו בתעודה`: quantity, packages and packaging back to the note's; reason, its note and the split cleared. */
export function resetToNotePatch(line: FormLine): Partial<V3LineDraft> {
  return {
    qty: fmtQty(line.qty),
    cartons: line.cartons === null ? '' : String(line.cartons),
    packaging: line.packaging ?? '',
    gap: null,
    gapNote: '',
    split: null,
    edited: true,
  };
}

/** Quantity, packages or packaging differ from the note (shows `כמו בתעודה`). */
export function differsFromNote(line: FormLine, d: V3LineDraft): boolean {
  const q = parseDecimal(d.qty);
  const qtyDiff = Number.isFinite(q) ? Math.abs(q - line.qty) >= SHORT_EPSILON : d.qty !== fmtQty(line.qty);
  const c = whole(d.cartons);
  const cartonsDiff = c !== line.cartons || (d.cartons.trim() !== '' && c === null);
  return qtyDiff || cartonsDiff || d.packaging !== (line.packaging ?? '');
}

/** How much is short of the note, in the line's quantity unit; 0 when not short. */
export function shortBy(line: FormLine, d: V3LineDraft): number {
  const q = parseDecimal(d.qty);
  return isShort(line, q) ? round3(line.qty - q) : 0;
}

// ── Packaging words and the packaging list ────────────────────────────────

/** The package word for n packages: singular for 1, plural otherwise; the generic word when the type is unknown. */
export function pkgWord(n: number, k: Packaging | '' | null, lang: 'he' | 'en'): string {
  if (!k) return lang === 'he' ? PACKAGING_PLURAL.other.he : PACKAGING_PLURAL.other.en;
  if (Number(n) === 1) return lang === 'he' ? PACKAGING_SINGULAR[k].he : PACKAGING_SINGULAR[k].en.toLowerCase();
  return PACKAGING_PLURAL[k][lang];
}

const PKG_FIRST: readonly Packaging[] = ['carton', 'sack', 'bag', 'pack', 'bucket'];

/**
 * The packaging list: the note's type first, then carton, sack, bag, pack,
 * bucket, then the rest in PACKAGING order, 'other' always last. A filter
 * keeps a type whose singular or plural word (either language) contains it;
 * 'other' always stays.
 */
export function packagingOrder(notePkg: Packaging | null, filter: string): Packaging[] {
  const seen = new Set<Packaging>();
  const out: Packaging[] = [];
  for (const k of [...(notePkg && notePkg !== 'other' ? [notePkg] : []), ...PKG_FIRST, ...PACKAGING]) {
    if (k === 'other' || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  out.push('other');
  const f = (filter ?? '').trim().toLowerCase();
  if (!f) return out;
  return out.filter((k) => {
    if (k === 'other') return true;
    const words = [PACKAGING_LABELS[k].he, PACKAGING_LABELS[k].en, PACKAGING_PLURAL[k].he, PACKAGING_PLURAL[k].en];
    return words.some((w) => w.toLowerCase().includes(f));
  });
}

// ── Answers ───────────────────────────────────────────────────────────────

/** What a v3 line sends as its legacy expiry: earliest split date / typed date as ISO / null. */
function legacyExpiry(d: V3LineDraft, q: number): string | null {
  if (q === 0) return null;
  if (d.split) return earliestSplitIso(d.split);
  if (d.noExpiry) return null;
  return typedIso(d.expiry);
}

/** The pallet a line's answer carries ([DEFAULT 2] for a partly loose line). */
function answerPallet(line: FormLine, d: V3LineDraft, draft: V3Draft): { pallet: number | 'loose' | null; loose: number | null } {
  const v = palletOf(line, d, draft);
  if (v === 'none') return { pallet: null, loose: null };
  const looseCount = draft.loose[line.index];
  if (looseCount !== undefined) {
    const packs = packagesOf(d);
    const n = Math.min(Math.max(1, Math.round(Number(looseCount) || 1)), packs);
    if (draft.pallets === 0 || n >= packs) return { pallet: 'loose', loose: n };
    const chosen = draft.pallets === 1
      ? 1
      : typeof d.pallet === 'number' && Number.isInteger(d.pallet) && d.pallet >= 1 && d.pallet <= draft.pallets
        ? d.pallet
        : null;
    return { pallet: chosen, loose: n };
  }
  if (v === 'loose') return { pallet: 'loose', loose: null };
  return { pallet: v, loose: null };
}

/**
 * The v3 draft → the POST body's `answers`. Today's keys with today's
 * meaning (the same values `draftToAnswers` gives for `v3ToLegacyDraft`),
 * plus the optional v3 keys.
 */
export function v3DraftToAnswers(lines: FormLine[], draft: V3Draft, today: string): AnswersV3 {
  void today; // the answers carry what was typed; validateV3 / validateAnswers judge the dates
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  let looseLines = 0;
  const out: LineAnswerV3[] = draft.lines.map((d) => {
    const line = byIndex.get(d.index);
    const q = parseDecimal(d.qty);
    const short = line ? isShort(line, q) : false;
    const gap = short ? d.gap : null;
    const a: LineAnswerV3 = {
      index: d.index,
      received_qty: q,
      cartons: parseWholeOrBlank(d.cartons),
      packaging: d.packaging === '' ? null : d.packaging,
      expiry_date: legacyExpiry(d, q),
      no_expiry: d.noExpiry && !d.split && q > 0,
      gap,
      gap_note: gap === 'other' ? d.gapNote.trim() : null,
    };
    if (!line) return a;
    const p = answerPallet(line, d, draft);
    a.pallet = p.pallet;
    if (p.loose !== null) {
      a.loose_qty = p.loose;
      looseLines += 1;
    }
    if (d.split && q > 0) {
      a.split_unit = lineMode(line) === 'two' ? 'qty' : 'packages';
      a.splits = d.split.map((r) => ({ qty: parseDecimal(r.qty), expiry_date: typedIso(r.date) ?? '' }));
    }
    return a;
  });
  return {
    pallets: draft.pallets,
    lines: out,
    extras: draft.extras.map((x) => ({ name: x.name.trim(), quantity: parseDecimal(x.quantity), unit: x.unit })),
    form_version: 3,
    loose_lines: looseLines,
  };
}

/**
 * The v3 draft as today's FormDraft (for useReceiveTrace and comparisons):
 * `draftToAnswers(lines, v3ToLegacyDraft(d))` gives the same legacy keys as
 * `v3DraftToAnswers(lines, d, today)`.
 */
export function v3ToLegacyDraft(draft: V3Draft): FormDraft {
  return {
    pallets: String(draft.pallets),
    lines: draft.lines.map((d) => {
      const q = parseDecimal(d.qty);
      return {
        index: d.index,
        qty: d.qty,
        cartons: d.cartons,
        packaging: d.packaging,
        expiry: legacyExpiry(d, q) ?? '',
        noExpiry: d.noExpiry && !d.split && q > 0,
        gap: d.gap,
        gapNote: d.gapNote,
      };
    }),
    extras: draft.extras,
  };
}

// ── Server validation (POST, only for `form_version === 3` bodies) ────────

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * The v3 rules on top of validateAnswers: pallets 0..50 (the bot's limit),
 * something to receive, every arrived line on a pallet / outside, a sane
 * loose count, and splits that are 2–3 good rows adding up to the basis
 * with the earliest date as the line's expiry. Never changes the answers.
 * A partly loose line (loose_qty set) may have no pallet (spec O9).
 */
export function validateV3(lines: FormLine[], answers: AnswersV3, today: string): V3Validation {
  const res: V3Validation = { ok: true, lines: {}, form: [] };
  const pallets = answers.pallets;
  const palletsOk = isInt(pallets) && pallets >= 0 && pallets <= V3.MAX_PALLETS;
  if (!palletsOk) res.form.push('pallets_range');
  const anyLoose = answers.lines.some((a) => (a.loose_qty !== undefined && a.loose_qty !== null) || a.pallet === 'loose');
  if (!(isInt(pallets) && pallets > 0) && !anyLoose) res.form.push('nothing_to_receive');

  const known = new Set(lines.map((l) => l.index));
  for (const a of answers.lines) {
    if (!known.has(a.index)) continue; // validateAnswers reports lines_mismatch
    const errs: V3LineError[] = [];
    const hasLoose = a.loose_qty !== undefined && a.loose_qty !== null;

    if (typeof a.received_qty === 'number' && a.received_qty > 0) {
      const p = a.pallet;
      if (p === undefined || p === null) {
        if (!hasLoose) errs.push('pallet_missing');
      } else if (p === 'loose') {
        // fine
      } else if (!isInt(p) || p < 1 || (palletsOk && p > (pallets as number))) {
        // (A bad pallet count is the form's error, not every line's.)
        errs.push('pallet_out_of_range');
      }
    }

    if (hasLoose) {
      const lq = a.loose_qty as number;
      const max = Math.max(a.cartons ?? 1, 1);
      if (!isInt(lq) || lq < 1 || lq > max) errs.push('loose_invalid');
    }

    if (a.splits !== undefined) {
      const rows = a.splits;
      const shapeOk =
        Array.isArray(rows) &&
        rows.length >= 2 &&
        rows.length <= V3.MAX_SPLIT_ROWS &&
        (a.split_unit === 'packages' || a.split_unit === 'qty') &&
        rows.every(
          (r) =>
            typeof r.qty === 'number' &&
            Number.isFinite(r.qty) &&
            r.qty > 0 &&
            typeof r.expiry_date === 'string' &&
            expiryError(r.expiry_date, today) === null,
        );
      if (!shapeOk) errs.push('split_invalid');
      else {
        const sum = rows.reduce((s, r) => s + r.qty, 0);
        const basis = a.split_unit === 'packages' ? a.cartons : a.received_qty;
        if (typeof basis !== 'number' || Math.abs(sum - basis) > SHORT_EPSILON) errs.push('split_sum');
        const earliest = rows.map((r) => r.expiry_date).sort()[0];
        if (a.expiry_date !== earliest || a.no_expiry) errs.push('split_expiry');
      }
    }
    if (errs.length) res.lines[a.index] = errs;
  }
  res.ok = res.form.length === 0 && Object.keys(res.lines).length === 0;
  return res;
}

/** A v3 body (`answers.form_version === 3`)? */
export function isV3Answers(a: unknown): a is AnswersV3 {
  return !!a && typeof a === 'object' && (a as { form_version?: unknown }).form_version === V3_FORM_VERSION;
}

// ── Draft persistence (localStorage, per form) ────────────────────────────

export function v3DraftStorageKey(formId: string): string {
  return `receipt-form-v3-draft:${formId}`;
}

/** `{v: 3, rev, fp, draft, savedAt}` (fp = the lines' fingerprints). */
export function serializeV3Draft(draft: V3Draft, lines: FormLine[], rev: number): string {
  return JSON.stringify({ v: 3, rev, fp: fingerprints(lines), draft, savedAt: Date.now() });
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function isSplitRows(v: unknown): v is V3SplitRow[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= V3.MAX_SPLIT_ROWS &&
    v.every((r) => r && typeof r === 'object' && isStr((r as V3SplitRow).qty) && isStr((r as V3SplitRow).date))
  );
}

function isV3LineDraft(l: unknown): l is V3LineDraft {
  if (!l || typeof l !== 'object') return false;
  const o = l as Record<string, unknown>;
  return (
    isInt(o.index) &&
    isStr(o.qty) &&
    isStr(o.cartons) &&
    isStr(o.expiry) &&
    typeof o.noExpiry === 'boolean' &&
    isStr(o.gapNote) &&
    (o.packaging === '' || (PACKAGING as readonly string[]).includes(o.packaging as string)) &&
    (o.gap === null || (GAPS as readonly string[]).includes(o.gap as string)) &&
    (o.split === null || isSplitRows(o.split)) &&
    (o.pallet === null || (isInt(o.pallet) && o.pallet >= 1 && o.pallet <= V3.MAX_PALLETS)) &&
    typeof o.ack === 'boolean' &&
    typeof o.edited === 'boolean'
  );
}

/**
 * Fit a v3 draft to (new) lines BY INDEX, as lib/receipt-form.ts mergeDraft:
 * a line keeps what was typed for its index unless `savedFp` says that index
 * was another item; a line with nothing saved starts from the note (not
 * ready, so it shows under "not filled"); loose entries of lines no longer
 * on the note are dropped. Pallets, extras and the stage are kept.
 */
export function mergeV3Draft(
  draft: V3Draft,
  savedFp: Record<number, string> | null,
  lines: FormLine[],
): { draft: V3Draft; added: number[] } {
  const byIndex = new Map<number, V3LineDraft>();
  for (const l of draft.lines) if (isV3LineDraft(l) && !byIndex.has(l.index)) byIndex.set(l.index, l);
  const added: number[] = [];
  const reset = new Set<number>();
  const out = lines.map((line) => {
    const kept = byIndex.get(line.index);
    if (!kept) {
      added.push(line.index);
      return initialLineDraft(line);
    }
    const fp = savedFp?.[line.index];
    if (savedFp && fp !== undefined && fp !== lineFingerprint(line)) {
      reset.add(line.index);
      return initialLineDraft(line);
    }
    return kept;
  });
  const onNote = new Set(lines.map((l) => l.index));
  const loose: Record<number, number> = {};
  for (const [k, v] of Object.entries(draft.loose ?? {})) {
    const i = Number(k);
    if (onNote.has(i) && !reset.has(i) && isInt(v) && v >= 1) loose[i] = v;
  }
  return { draft: { ...draft, loose, lines: out }, added };
}

/**
 * A stored v3 draft fitted to these lines, with the revision it was saved at
 * — or null when there is none or it is unreadable (the page starts from the
 * note). Only `{v: 3}` drafts; the classic `receipt-form-draft:*` ones are
 * never read by v3.
 */
export function restoreV3Draft(
  raw: string | null,
  lines: FormLine[],
): { draft: V3Draft; added: number[]; rev: number | null } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: unknown; rev?: unknown; fp?: unknown; draft?: Partial<V3Draft> };
    const d = o?.draft;
    if (o?.v !== 3 || !d || typeof d !== 'object' || !Array.isArray(d.lines) || !Array.isArray(d.extras)) return null;
    if (!o.fp || typeof o.fp !== 'object' || Array.isArray(o.fp)) return null;
    const fp: Record<number, string> = {};
    for (const [k, v] of Object.entries(o.fp as Record<string, unknown>)) {
      if (/^\d{1,6}$/.test(k) && isStr(v)) fp[Number(k)] = v;
    }
    const extras = d.extras
      .filter(
        (x) =>
          x &&
          isStr(x.key) &&
          isStr(x.name) &&
          isStr(x.quantity) &&
          (EXTRA_UNITS as readonly string[]).includes(x.unit),
      )
      .slice(0, MAX_EXTRAS);
    const pallets = isInt(d.pallets) && d.pallets >= 0 && d.pallets <= V3.MAX_PALLETS ? d.pallets : 0;
    const loose = d.loose && typeof d.loose === 'object' && !Array.isArray(d.loose) ? d.loose : {};
    const lastPallet = isInt(d.lastPallet) && d.lastPallet >= 1 ? d.lastPallet : null;
    const base: V3Draft = {
      stage: d.stage === 'list' ? 'list' : 'pallets',
      pallets,
      loose: loose as Record<number, number>,
      lastPallet,
      lines: d.lines as V3LineDraft[],
      extras,
    };
    const merged = mergeV3Draft(base, fp, lines);
    const rev = isInt(o.rev) && o.rev >= 1 ? o.rev : null;
    return { ...merged, rev };
  } catch {
    return null;
  }
}
