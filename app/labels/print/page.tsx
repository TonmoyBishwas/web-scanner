import { Suspense } from 'react';
import { LabelSheet } from './LabelSheet';

/**
 * Print sheet for warehouse-minted carton stickers.
 *
 * Opened in a new tab from the Labels screen with `?token&batches&size&lang`; it
 * renders the selected stickers at real-world dimensions and hands them to the
 * browser's own print dialog. There is no printer integration in this system —
 * the device's print target is whatever the worker has paired.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function LabelPrintPage() {
  return (
    <Suspense fallback={null}>
      <LabelSheet />
    </Suspense>
  );
}
