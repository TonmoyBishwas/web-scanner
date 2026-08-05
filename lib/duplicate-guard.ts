/**
 * Cross-worker duplicate-box detection for split deliveries.
 *
 * Meat boxes carry unique catch-weight barcodes, so the same barcode turning
 * up on two pallets of one delivery means two workers are standing at the same
 * physical pallet. Type A non-meat repeats the same SKU barcode across every
 * box by design (see CLAUDE.md on fish / fixed-weight goods), so the guard is
 * hard-gated to meat — a block there would be wrong, not merely noisy.
 */
import type { MultiPalletSession } from '@/types';

export function findDuplicateOwner(
  session: MultiPalletSession,
  barcode: string,
  currentSlotN: number,
): { pallet_n: number; owner: string | null } | null {
  if (!barcode) return null;
  if (session.mode !== 'split') return null;
  if ((session.category ?? 'meat') !== 'meat') return null;

  for (const done of session.completed_pallets ?? []) {
    if (done.pallet_number === currentSlotN) continue;
    if (!done.barcodes?.includes(barcode)) continue;
    const slot = (session.pallets ?? []).find((p) => p.n === done.pallet_number);
    return { pallet_n: done.pallet_number, owner: slot?.owner ?? null };
  }
  return null;
}
