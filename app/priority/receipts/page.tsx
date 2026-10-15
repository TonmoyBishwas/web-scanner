import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ReceiptsBoard } from './ReceiptsBoard';

/**
 * Priority — receipts (the owner's fixed link).
 *
 * `?u=<users.id>&sig=<hex>`, signed with ADMIN_LINK_SECRET over
 * "receipts.<u>" and never expiring (lib/receipts-link.ts). Replaces the
 * per-receipt WhatsApp texts: every delivery of the last 14 days with its
 * Priority status, and a way into /priority/attention for the ones that
 * need a person. Read-only. The API re-checks that `u` is an active Admin
 * on every load, so deactivating the user revokes the link.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Priority — receipts',
  // The signed link is in the URL: keep it out of Referer headers and indexes.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function PriorityReceiptsPage() {
  return (
    <Suspense fallback={null}>
      <ReceiptsBoard />
    </Suspense>
  );
}
