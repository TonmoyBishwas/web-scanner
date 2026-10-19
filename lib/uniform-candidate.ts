/**
 * The single-item shortcut's trigger (pallet-verify): do the cartons read so
 * far look like ONE product whose cartons all weigh the same? Only then may
 * the worker scan two samples and declare the total ("we multiply") instead
 * of scanning every carton.
 *
 * "Same weight" means EXACTLY equal (`tolerance` absorbs float noise only):
 * catch-weight meat differs carton to carton, and every carton's own weight
 * is what goes to box_inventory for FEFO on the way out.
 *
 * A carton whose label prints its own weight (a 31-digit catch-weight code,
 * lib/barcode-parser.ts parseCartonBarcode) never qualifies, even when two in
 * a row weigh the same to the gram: the label says the weight is per carton,
 * so multiplying one sample's weight books a made-up weight for every other
 * carton (19/10 — two catch-weight cartons with different expiry digits raised
 * "is this the only product?"). Each of those is scanned, or given a label of
 * its own.
 */

import { parseCartonBarcode } from './barcode-parser';

export interface UniformSampleRow {
  barcode: string;
  item_name?: string;
  item_name_hebrew?: string;
  weight: number;
  /** Minted by "All boxes identical" / "Different carton?" / New carton. */
  minted?: boolean;
}

export interface UniformCandidate {
  name_key: string;
  item_name: string;
  item_name_hebrew: string;
  avg_weight: number;
  sample_barcodes: string[];
}

/** Does this carton's own barcode print its weight? */
export function labelPrintsWeight(barcode: string): boolean {
  return (parseCartonBarcode(barcode)?.weight ?? null) !== null;
}

export function uniformCandidate<T extends UniformSampleRow>(
  done: ReadonlyArray<T>,
  keyOf: (b: T) => string,
  opts: { minSamples: number; tolerance: number },
): UniformCandidate | null {
  if (done.length < opts.minSamples) return null;
  // Minted rows already carry their exact count — nothing to multiply.
  if (done.some((b) => b.minted)) return null;
  // A label that prints its own weight: each carton is weighed on its own.
  if (done.some((b) => labelPrintsWeight(b.barcode))) return null;
  const distinct = new Set(done.map(keyOf));
  if (distinct.size !== 1) return null; // multiple products -> mix path
  const ws = done.map((b) => b.weight);
  if (Math.max(...ws) - Math.min(...ws) >= opts.tolerance) return null; // varies -> mix
  const sample = done[0];
  const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
  return {
    name_key: keyOf(sample),
    item_name: sample.item_name || '',
    item_name_hebrew: sample.item_name_hebrew || '',
    avg_weight: Math.round(avg * 1000) / 1000,
    sample_barcodes: done.map((b) => b.barcode),
  };
}
