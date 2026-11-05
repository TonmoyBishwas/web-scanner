/**
 * Label switches (Mevaser, 04/11 + 05/11) and the top-bar-only delete.
 *
 * Two independent per-chat switches in `public.scanner_flags`:
 *   - `carton_labels`: the warehouse's own carton labels — the "each carton
 *     gets its own label with a unique barcode" wording, the save-labels
 *     buttons, the Labels chip and the edit panel's "create a barcode for
 *     this carton". Off for a tenant that only fills stock into Priority.
 *   - `lpn_labels`: the pallet LPN sticker — the Pallets screen's "Open
 *     sticker". On for the current tenant (as today).
 *
 * Both are DEFAULT-ON switches, unlike every other scanner flag: a missing
 * row, an unreadable row or a DB error is "as today" (shown), so inserting
 * no rows changes nothing. Only a row that exists and is not on for the chat
 * switches the feature off. The session GET passes `carton_labels: false` /
 * `lpn_labels: false` only then, so with no rows the response is exactly as
 * before.
 *
 * Off hides wording, buttons and a chip, nothing else: `28…` codes are still
 * minted as the carton's booking key, `carton_labels` rows saved, the cartons
 * booked, the LPN created and its sticker page served. No new text — a save
 * button that said "save N labels" reuses the approved units wording "add N
 * cartons" (carton.unitsSave, Mevaser 27/10).
 *
 * `top_bar_delete_only` (Mevaser 05/11: "no per-carton delete; the only
 * delete is in the top bar, next to Pallets"): an ordinary OFF-by-default
 * flag. On, the rows' Delete action goes; the top bar's Delete chip
 * (selection mode, then "delete selected") is the one way to remove a carton.
 *
 * The DB side (reading the rows) is lib/scanner-flags.ts `defaultOnFlagFor`;
 * this file is what the page reads, free of React and the DB so vitest runs
 * it in node and the browser bundle never pulls in the service-role client.
 */
import type { TranslationKey } from '@/lib/i18n/server';

/** The session's `features` as far as these switches go. */
export interface LabelSwitchFeatures {
  carton_labels?: boolean;
  lpn_labels?: boolean;
  top_bar_delete_only?: boolean;
}

/** Carton-label wording, buttons and chip shown? Absent = yes (as today). */
export function cartonLabelsShown(features: LabelSwitchFeatures | null | undefined): boolean {
  return features?.carton_labels !== false;
}

/** The LPN sticker link shown? Absent = yes (as today). */
export function lpnLabelsShown(features: LabelSwitchFeatures | null | undefined): boolean {
  return features?.lpn_labels !== false;
}

/** A row's own Delete action offered? Absent = yes (as today). */
export function perCartonDeleteShown(features: LabelSwitchFeatures | null | undefined): boolean {
  return features?.top_bar_delete_only !== true;
}

/**
 * The save button of New carton (kg) and All boxes identical. Labels on:
 * the label wording it has today (`carton.*` or `identical.*`). Off: the
 * approved units wording, which names cartons, not labels.
 */
export function cartonSaveKey(
  count: number,
  cartonLabels: boolean,
  form: 'carton' | 'identical',
): { key: TranslationKey; params?: Record<string, number> } {
  if (!cartonLabels) {
    return count === 1 ? { key: 'carton.unitsSaveOne' } : { key: 'carton.unitsSave', params: { n: count } };
  }
  if (form === 'identical') {
    return count === 1 ? { key: 'identical.saveOne' } : { key: 'identical.save', params: { count } };
  }
  return count === 1 ? { key: 'carton.saveOne' } : { key: 'carton.save', params: { count } };
}

/**
 * All boxes identical, total mode: the live line under the count. Labels
 * on: "N labels will be saved (this carton too) · M on the list" as today
 * (the Another-carton form always says "N will be added"). Off: that same
 * label-free "N will be added · M on the list".
 */
export function identicalTotalKey(anotherOf: boolean, cartonLabels: boolean): 'identical.willAdd' | 'identical.willSave' {
  return anotherOf || !cartonLabels ? 'identical.willAdd' : 'identical.willSave';
}
