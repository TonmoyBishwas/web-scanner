/**
 * Receive form v3: the composed texts (spec 7.6 / 5.8 / 5.19), built from the
 * receive.v3.* block with `t()` and the approved package words of
 * lib/receipt-form.ts. Every number is bidi-isolated (`I()`); no Hebrew is
 * written here — only joined.
 */
import { t, type TranslationKey } from '@/lib/i18n/server';
import { fmtQty, parseDecimal, type FormLanguage, type FormLine, type Gap } from '@/lib/receipt-form';
import {
  dateCheck,
  lineMode,
  palletOf,
  pkgWord,
  shortBy,
  splitBasis,
  type V3Draft,
  type V3LineDraft,
  type V3LineStatus,
} from '@/lib/receive-v3';
import { I } from './tokens';

export type Tr = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export function makeTr(language: FormLanguage): Tr {
  return (key, vars) => t(language, key, vars);
}

export type Lang = 'he' | 'en';
export const langOf = (language: FormLanguage): Lang => (language === 'Hebrew' ? 'he' : 'en');

const SHORT_EPS = 0.0005;

/** A typed number → number or null (blank / junk). */
export function num(s: string): number | null {
  const v = parseDecimal(s ?? '');
  return Number.isFinite(v) ? v : null;
}

/** `{n} {package word}` ("3 דליים", "1 דלי"); '' for a blank count. */
export function pkgText(n: string | number, k: V3LineDraft['packaging'] | null, lang: Lang): string {
  if (n === '' || n === null || n === undefined) return '';
  const v = typeof n === 'number' ? n : Number(n);
  return `${I(typeof n === 'number' ? fmtQty(n) : n)} ${pkgWord(Number.isFinite(v) ? v : 0, k || null, lang)}`;
}

/** An amount of the line in its own unit: packages on a "same" line, else the note's unit. */
export function amountText(line: FormLine, d: V3LineDraft, n: number, lang: Lang): string {
  return lineMode(line) === 'same' ? pkgText(fmtQty(n), d.packaging, lang) : `${I(fmtQty(n))} ${line.unit_label}`;
}

/** The split's amount, as the prototype's amt(): the package word on a "same" line, else the note's unit. */
export function splitAmountText(line: FormLine, d: V3LineDraft, n: number, lang: Lang): string {
  return amountText(line, d, n, lang);
}

export const GAP_KEY: Record<Gap, TranslationKey> = {
  will: 'receive.v3.gapWill',
  wont: 'receive.v3.gapWont',
  other: 'receive.v3.gapOther',
};

/** How much is missing (0 when not short). */
export function shortAmount(line: FormLine, d: V3LineDraft): number {
  return shortBy(line, d);
}

/** The values text (spec 7.6): packages / quantity, + "short: …" and its reason. */
export function valuesText(line: FormLine, d: V3LineDraft, lang: Lang, tr: Tr): string {
  const m = lineMode(line);
  const pk = d.cartons !== '' ? pkgText(d.cartons, d.packaging, lang) : '';
  const qtyU = `${I(d.qty)} ${line.unit_label}`;
  let out: string;
  if (m === 'same') out = pk || qtyU;
  else if (m === 'two') out = [qtyU, pk].filter(Boolean).join(' · ');
  else {
    const q = num(d.qty) ?? 0;
    const c = num(d.cartons) ?? 0;
    out = pk + (Math.abs(q - c * (line.per_pack ?? 0)) >= SHORT_EPS ? ` · ${qtyU}` : '');
  }
  const short = shortAmount(line, d);
  if (short > 0) {
    out += ` · ${tr('receive.v3.short', { amount: amountText(line, d, short, lang) })}`;
    if (d.gap) {
      const note = d.gap === 'other' ? d.gapNote.trim() : '';
      out += ` · ${tr(GAP_KEY[d.gap])}${note ? `: ${note}` : ''}`;
    }
  }
  return out;
}

/** `12052027` / `12.05.2027` → `12.05.27`; anything shorter as typed. */
function shortDate(v: string): string {
  const dg = (v || '').replace(/\D/g, '');
  return dg.length === 8 ? `${dg.slice(0, 2)}.${dg.slice(2, 4)}.${dg.slice(6)}` : v || '';
}

/** The expiry summary: the date, "no expiry", or the split rows `2 · 12.05.27 / 1 · 20.06.27`. */
export function expirySummary(d: V3LineDraft, tr: Tr): string {
  if (d.split) return d.split.map((r) => `${I(r.qty || '—')} · ${I(shortDate(r.date) || '—')}`).join(' / ');
  if (d.noExpiry) return tr('receive.v3.noExpiry');
  return d.expiry ? I(d.expiry) : '';
}

/** The pallet value text: `משטח 2` / `מחוץ למשטח` / `1 מחוץ למשטח`; '' when not set. */
export function palletName(line: FormLine, d: V3LineDraft, draft: V3Draft, tr: Tr): string {
  const v = palletOf(line, d, draft);
  if (v === null || v === 'none') return '';
  if (v === 'loose') {
    const tot = num(d.cartons) || 1;
    const n = draft.loose[line.index];
    if (n === undefined || n >= tot) return tr('receive.v3.loose');
    return tr('receive.v3.looseN', { n: I(n) });
  }
  return tr('receive.v3.palletN', { n: I(v) });
}

/** The pallet suffix is shown when there are ≥ 2 pallets or the line is (partly) loose. */
export function showsPallet(line: FormLine, draft: V3Draft): boolean {
  return draft.pallets >= 2 || line.index in draft.loose;
}

const STATE_KEY: Record<Exclude<V3LineStatus, 'ready'>, TranslationKey> = {
  expiry: 'receive.v3.st.expiry',
  gap: 'receive.v3.st.gap',
  pallet: 'receive.v3.st.pallet',
  fix: 'receive.v3.st.fix',
};

/** The collapsed card's status line: `{values} · {state} · {pallet}`, empty parts dropped. */
export function statusLineText(line: FormLine, d: V3LineDraft, draft: V3Draft, st: V3LineStatus, lang: Lang, tr: Tr): string {
  const state = st === 'ready' ? expirySummary(d, tr) : tr(STATE_KEY[st]);
  const pal = showsPallet(line, draft) ? palletName(line, d, draft, tr) : '';
  return [valuesText(line, d, lang, tr), state, pal].filter(Boolean).join(' · ');
}

/** The confirmation card's second line: expiry summary + pallet. */
export function confirmExpiryText(line: FormLine, d: V3LineDraft, draft: V3Draft, tr: Tr): string {
  const pal = showsPallet(line, draft) ? palletName(line, d, draft, tr) : '';
  return [expirySummary(d, tr), pal].filter(Boolean).join(' · ');
}

/** The single date field's error text, or null. */
export function dateErrorText(dotted: string, today: string, tr: Tr): string | null {
  const c = dateCheck(dotted, today);
  if (c === 'invalid') return tr('receive.v3.err.dateInvalid');
  if (c === 'past') return tr('receive.v3.err.datePast');
  if (c === 'far') return tr('receive.v3.err.dateFar');
  return null;
}

/** The note's package count in words, for the loose sub-screen ("3 דליים"; 1 when blank). */
export function notePackages(line: FormLine, lang: Lang): string {
  return pkgText(line.cartons ?? 1, line.packaging, lang);
}

/** The line's display name: Hebrew (the Priority name when mapped), else English. */
export function lineName(line: FormLine, lang: Lang): string {
  if (lang === 'en') return line.name_en || line.name_he;
  return line.name_he || line.name_en;
}

/** The split's basis as a display string. */
export function splitBasisText(line: FormLine, d: V3LineDraft): string {
  return fmtQty(splitBasis(line, d));
}
