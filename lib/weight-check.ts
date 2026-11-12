/**
 * The pallet page's weight check on a whole list (lib/weight-sanity.ts), its
 * session switch, and the "Different carton?" / identical / New carton save
 * that runs it — out of app/pallet-verify/[token]/page.tsx so the switch's
 * wiring is tested (review 12/11). The page owns the rows; these are pure.
 */
import { applyFormWeightToSource, type IdenticalForm } from './identical-boxes';
import { findWeightSuspects, type WeighedBox } from './weight-sanity';
import { acceptDoubts, type DoubtedRow } from './weight-review';
import type { BarcodeFilled } from './barcode-reconcile';
import type { MultiPalletSession } from '@/types';

export interface WeightCheckOpts {
  /** weight_ratio_over_kg_name (12/11): findWeightSuspects `ratioOverKgName`. */
  ratioOverKgName?: boolean;
}

type CheckedRow = WeighedBox & DoubtedRow & { barcode: string; barcode_filled?: BarcodeFilled };

/**
 * weight_ratio_over_kg_name (12/11, IN26014927): the weight check's switch,
 * read from the session at each check (the checks run in state updaters).
 * Off: as before.
 */
export function weightCheckOpts(session: Pick<MultiPalletSession, 'features'> | null | undefined): { ratioOverKgName: boolean } {
  return { ratioOverKgName: !!session?.features?.weight_ratio_over_kg_name };
}

/**
 * Flag every carton on the list whose weight looks wrong (lib/weight-sanity.ts)
 * — a new read can also expose an earlier one, e.g. a first carton read as
 * 120 kg once three real 12 kg ones are in. Only ever ADDS a doubt, and never
 * touches needs_review (lib/weight-review.ts); a ratio doubt holds through
 * blocksConfirm instead (lib/failed-read.ts).
 */
export function flagSuspectWeights<R extends CheckedRow>(
  list: R[],
  extraNames: Record<string, Array<string | null | undefined>> = {},
  opts: WeightCheckOpts = {},
): R[] {
  // A weight read from the carton's barcode is not a guess from the sticker:
  // it still counts towards the item's median, it is never itself doubted.
  const suspects = findWeightSuspects(
    list.map((b) => (b.barcode_filled && 'weight' in b.barcode_filled ? { ...b, weight_checked: true } : b)),
    extraNames,
    opts,
  );
  if (!suspects.length) return list;
  const by = new Map(suspects.map((x) => [x.barcode, x]));
  return list.map((b) => {
    const x = by.get(b.barcode);
    if (!x || b.weight_suspect) return b;
    return { ...b, weight_suspect: { typical: x.typical, reason: x.reason, name: x.name } };
  });
}

export interface IdenticalSave<R> {
  /** The carton the form was opened on (its barcode). */
  sourceBarcode: string;
  /** "Different carton?": the source is a counted carton of its own and stays. */
  anotherOf: boolean;
  /** The photo row a twin from the edit panel takes the place of. */
  replaces?: string;
  /** The new rows, one per minted label (lib/identical-boxes.ts expandIdenticalBoxes). */
  rows: R[];
  form: IdenticalForm;
  /** The labels the save minted. */
  saved: number;
  /** identical_source_weight (11/11): the source takes the form's weight
   *  (decided by the page, lib/identical-boxes.ts sourceTakesFormWeight). */
  reweighSource: boolean;
  opts: WeightCheckOpts;
}

/**
 * The list after an identical / "Different carton?" / New carton save: the
 * sample row replaced by the new rows (or, for "Different carton?", the new
 * rows added at the end), then the weight check over the whole list.
 */
export function replaceIdenticalSample<R extends CheckedRow & { needs_review?: boolean; weight_typed?: boolean }>(
  prevAll: R[],
  s: IdenticalSave<R>,
): R[] {
  const prev = s.replaces ? prevAll.filter((b) => b.barcode !== s.replaces) : prevAll;
  // "Different carton?": the carton it was copied from is a counted
  // carton of its own and stays; the new one joins the end of the list.
  // The form showed that carton's doubted weight and the worker saved it
  // unchanged: the doubt is settled for it too.
  if (s.anotherOf) {
    // identical_source_weight (11/11): a weight he typed over the
    // carton's label reading is that carton's weight too (`reweighSource`).
    const base = s.reweighSource ? applyFormWeightToSource(prev, s.sourceBarcode, s.form, s.saved) : prev;
    const settled = s.form.weight_confirmed
      ? acceptDoubts(base, new Set(base.filter((b) => b.barcode === s.sourceBarcode
          && Math.abs(b.weight - s.form.weight) < 0.001).map((b) => b.barcode)))
      : base;
    return flagSuspectWeights([...settled, ...s.rows], {}, s.opts);
  }
  const idx = prev.findIndex((b) => b.barcode === s.sourceBarcode);
  return flagSuspectWeights(
    idx === -1 ? [...prev, ...s.rows] : [...prev.slice(0, idx), ...s.rows, ...prev.slice(idx + 1)],
    {},
    s.opts,
  );
}
