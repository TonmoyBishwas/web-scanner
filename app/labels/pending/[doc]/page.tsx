import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PendingLabels } from './PendingLabels';

/**
 * Labels to print — one delivery note's saved-but-unprinted carton labels
 * (client request (d), 2026-10-15).
 *
 * Opened from the scanner's "N labels waiting — print later" (pallet-done
 * card, all-done screen) or the bot's unprinted-labels message:
 * `/labels/pending/<document_number>?sig=<hex>`, where sig is
 * HMAC-SHA256(LPN_SECRET, "labels:" + document_number) — lib/label-link.ts.
 * No scanner session needed (it expires after 2 h); the API re-checks the
 * signature on every call and reaches only this note's labels.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Labels to print',
  // The signature is in the URL: keep it out of Referer headers and indexes.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export default async function PendingLabelsPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  return (
    <Suspense fallback={null}>
      <PendingLabels doc={safeDecode(doc)} />
    </Suspense>
  );
}
