import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AttentionBoard } from './AttentionBoard';

/**
 * Priority — needs attention.
 *
 * Opened from the "Details and Send again" link in the bot's office alert
 * (`?u=<chat_id>&exp=<unix s>&sig=<hex>`, signed by the bot, valid 24 h).
 * Lists every finished delivery that is not in Priority and needs a person,
 * with a guarded Send again and Mark as found per row. No bulk action.
 * The API re-checks the link and that `u` is an active Admin on every call.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Priority — needs attention',
  // The signed link is in the URL: keep it out of Referer headers and indexes.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function PriorityAttentionPage() {
  return (
    <Suspense fallback={null}>
      <AttentionBoard />
    </Suspense>
  );
}
