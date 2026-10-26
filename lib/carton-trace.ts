/**
 * What the New carton screen (components/terminal/CartonCreator.tsx) records
 * in the scanner trace.
 *
 * Wall Dan 25/10: the trace held `carton_creator_open` at 13:21:10 and the
 * save at 13:25:04, and nothing in between — no item, no date, no refused
 * Save, so 3 min 20 s could not be told apart from a worker who walked away.
 * The screen now traces each step; these are the pure parts of the Save tap.
 */

/** Why a Save tap did nothing; null = it went through. */
export type CartonSaveBlock = 'item' | 'saving' | 'count' | 'date' | 'weight' | 'expiry';

/** The first thing holding Save back, in the order handleSave checks them. */
export function cartonSaveBlock(f: {
  selected: boolean;
  saving: boolean;
  count: number;
  dateError: string | null | undefined;
  weightMissing: boolean;
  expiryMissing: boolean;
}): CartonSaveBlock | null {
  if (!f.selected) return 'item';
  if (f.saving) return 'saving';
  if (f.count < 1) return 'count';
  if (f.dateError) return 'date';
  if (f.weightMissing) return 'weight';
  if (f.expiryMissing) return 'expiry';
  return null;
}

/** The `carton_save_tap` event. The notes are free text a worker may fill
 *  with anything, so only their length is recorded. */
export function cartonSaveTapData(f: {
  itemCode: string | undefined;
  quantity: number;
  weight: string;
  production: string;
  expiry: string;
  notes: string;
  blocked: CartonSaveBlock | null;
}) {
  return {
    item_code: f.itemCode ?? null,
    quantity: f.quantity,
    weight: f.weight,
    production: f.production || null,
    expiry: f.expiry || null,
    notes_len: f.notes.trim().length,
    blocked: f.blocked,
  };
}
