'use client';

/**
 * "N labels waiting — print later" (client request (d), 2026-10-15), on the
 * pallet-done card and the all-done screen. With the print gate off a pallet
 * is booked before its labels are printed; this is the way back to them
 * after the scanner session has expired: the signed pending-labels page for
 * the delivery note (lib/label-link.ts), opened here or copied to send on.
 * Amber = needs attention, nothing failed.
 */

import { MI } from './MI';
import { useT } from '@/lib/i18n';
import { trace } from '@/lib/scanner-trace';

interface PendingLabelsLinkProps {
  count: number;
  /** The signed page; null while unknown (no secret configured / not loaded). */
  url: string | null;
  onCopied: () => void;
  /** Where it is shown, for the trace. */
  from: 'pallet_done' | 'all_done';
}

export function PendingLabelsLink({ count, url, onCopied, from }: PendingLabelsLinkProps) {
  const tr = useT();
  if (count <= 0) return null;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      trace('ui', 'labels_link_copied', { count, from });
      onCopied();
    } catch {
      // Clipboard blocked (insecure context / permission): Open still works.
    }
  }

  return (
    <div className="mt-3 rounded-[12px] border border-warn/40 bg-warn-weak px-3 py-[10px]">
      <p className="flex items-center gap-[6px] text-[12px] font-extrabold text-[#fbbf5c]">
        <MI name="print_disabled" size={16} className="flex-none" />
        <span className="min-w-0">
          {count === 1 ? tr('labels.waitingOne') : tr('labels.waiting', { count })}
        </span>
      </p>
      {url && (
        <div className="flex gap-2 mt-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trace('ui', 'labels_link_opened', { count, from })}
            className="flex-1 min-w-0 min-h-[40px] inline-flex items-center justify-center gap-[5px] rounded-[10px] bg-warn text-canvas text-[12px] font-black"
          >
            <MI name="print" size={16} /> {tr('labels.waitingOpen')}
          </a>
          <button
            type="button"
            onClick={() => void copy()}
            className="flex-1 min-w-0 min-h-[40px] inline-flex items-center justify-center gap-[5px] rounded-[10px] border border-warn/50 text-warn-weak-ink text-[12px] font-extrabold"
          >
            <MI name="content_copy" size={16} /> {tr('labels.waitingCopy')}
          </button>
        </div>
      )}
    </div>
  );
}
