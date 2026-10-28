/**
 * The receive form's redesign (28/10), pure logic. Behind the
 * `receive_redesign` flag (public.scanner_flags); nothing here changes what is
 * validated or submitted — it decides what the worker SEES.
 *
 * Why (David, note 2607237, 27/10): 36 minutes for 21 lines. Every line
 * needed an expiry typed by hand, the lines come in the note's order (not how
 * the goods stand on the pallets), and every card showed four open fields.
 *
 * - `lineNames`: the card's title is the Priority item's name when the code
 *   maps (bot 96e26c3), the note's printed wording a small subtitle under it.
 * - The expiry walk: one line at a time. `walkOrder` = the lines that need an
 *   expiry and arrived; `nextUndated` skips to the next one still without a
 *   date or "no expiry"; `groupByPackage` builds the "which item is in front of
 *   you?" picker, grouped by the package the worker sees on the pallet.
 */
import {
  PACKAGING,
  expiryError,
  parseDecimal,
  type FormLine,
  type LineDraft,
  type Packaging,
} from './receipt-form';
import { searchKey } from './receipt-form-search';

// ── Names ────────────────────────────────────────────────────────────────

/**
 * Title + subtitle of a line. Title: the Priority name (explicit
 * `priority_name`, else `name_he`, which the bot already sets to it), else the
 * English name. Subtitle: the printed name, only when it reads differently.
 */
export function lineNames(
  line: Pick<FormLine, 'name_he' | 'name_en' | 'priority_name' | 'name_printed'>,
): { title: string; subtitle: string } {
  const printed = (line.name_printed ?? '').trim();
  const title = (line.priority_name ?? '').trim() || line.name_he.trim() || line.name_en.trim() || printed;
  const subtitle = printed && searchKey(printed) !== searchKey(title) ? printed : '';
  return { title, subtitle };
}

// ── The expiry walk ──────────────────────────────────────────────────────

/** In the walk: the line wants an expiry and was not marked "did not arrive" (0). */
export function inWalk(line: Pick<FormLine, 'needs_expiry'>, d: Pick<LineDraft, 'qty'>): boolean {
  return line.needs_expiry && parseDecimal(d.qty) !== 0;
}

/** Has its expiry answer: "no expiry", or a date the form accepts. */
export function isDated(d: Pick<LineDraft, 'expiry' | 'noExpiry'>, todayIso: string): boolean {
  return d.noExpiry || (!!d.expiry && expiryError(d.expiry, todayIso) === null);
}

/** The walk's lines, in note order (line indexes). */
export function walkOrder(lines: FormLine[], drafts: LineDraft[]): number[] {
  const byIndex = new Map(lines.map((l) => [l.index, l]));
  return drafts.filter((d) => {
    const l = byIndex.get(d.index);
    return !!l && inWalk(l, d);
  }).map((d) => d.index);
}

/** "n of m dated": the walk's lines with their answer, of all the walk's lines. */
export function walkProgress(lines: FormLine[], drafts: LineDraft[], todayIso: string): { dated: number; total: number } {
  const order = new Set(walkOrder(lines, drafts));
  const dated = drafts.filter((d) => order.has(d.index) && isDated(d, todayIso)).length;
  return { dated, total: order.size };
}

/**
 * The next walk line still without an answer AFTER `from`, wrapping round
 * the note; `from` itself is never the answer. `from` null (or not in the
 * walk) = the first undated line. null = no other undated line.
 */
export function nextUndated(order: number[], undated: (index: number) => boolean, from: number | null): number | null {
  const at = from === null ? -1 : order.indexOf(from);
  for (let k = 1; k <= order.length; k += 1) {
    const i = order[(at + k + order.length) % order.length];
    if (i !== from && undated(i)) return i;
  }
  return null;
}

/** The walk line before `from` (null at the first, or when `from` is not in the walk). */
export function prevInWalk(order: number[], from: number | null): number | null {
  const at = from === null ? -1 : order.indexOf(from);
  return at > 0 ? order[at - 1] : null;
}

/** Where the walk opens: the first undated line, else the first line of the walk. */
export function walkStart(order: number[], undated: (index: number) => boolean): number | null {
  return order.find(undated) ?? order[0] ?? null;
}

// ── "Which item is in front of you?" ─────────────────────────────────────

export interface PackageGroup {
  /** The outer package; a line with none known falls under 'other' ("packages"). */
  packaging: Packaging;
  /** Line indexes, note order. */
  lines: number[];
}

/**
 * The picker's groups: the worker's package choice (else the note's), in the
 * PACKAGING order the form's dropdown uses; unknown = 'other', last.
 */
export function groupByPackage(lines: FormLine[], drafts: LineDraft[], indexes: number[]): PackageGroup[] {
  const byLine = new Map(lines.map((l) => [l.index, l]));
  const byDraft = new Map(drafts.map((d) => [d.index, d]));
  const groups = new Map<Packaging, number[]>();
  for (const i of indexes) {
    const p: Packaging = byDraft.get(i)?.packaging || byLine.get(i)?.packaging || 'other';
    const g = groups.get(p);
    if (g) g.push(i);
    else groups.set(p, [i]);
  }
  return PACKAGING.filter((p) => groups.has(p)).map((p) => ({ packaging: p, lines: groups.get(p)! }));
}
