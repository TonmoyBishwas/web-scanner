'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { MI } from './MI';
import { nearestScrollTop } from '@/lib/scan-notice';

interface HistoryRowProps {
  index: number | string;
  name: string;
  barcode?: string;
  /** Formatted weight, e.g. "45.20" — omit to hide the value block */
  weight?: string;
  unitLabel?: string;
  status?: 'done' | 'pending' | 'failed';
  onClick?: () => void;
  /**
   * Row actions — normally a <ScanActions/> bar, which lays out (and wraps)
   * its own buttons. Rendered full-width BELOW the summary line — squeezing
   * them in beside the weight collided with the 31-digit barcode and left
   * both unreadable.
   */
  actions?: ReactNode;
  dimmed?: boolean;
  /** This row's barcode is a saved label that has not been printed yet. */
  unprinted?: boolean;
  /** Spoken / long-press text for the unprinted marker. */
  unprintedLabel?: string;
  /** A re-read just named this carton ("already counted"): blue ring + pulse
   *  and a double tick for a moment, and the list scrolls it into view. */
  highlight?: boolean;
}

/** The nearest ancestor that scrolls vertically — the sheet's list. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

// Design history row: rgba(10,15,20,.5) on #1e2a35 hairline, 40px mono index
// badge, green check + name, LTR mono barcode, 17px mono weight, chevron.
export function HistoryRow({
  index, name, barcode, weight, unitLabel = 'ק"ג',
  status = 'done', onClick, actions, dimmed = false, unprinted = false, unprintedLabel,
  highlight = false,
}: HistoryRowProps) {
  const statusIcon = highlight ? 'done_all' : status === 'failed' ? 'error' : status === 'pending' ? 'hourglass_empty' : 'check_circle';
  const statusColor = highlight ? '#13a4ec' : status === 'failed' ? '#ef4444' : status === 'pending' ? '#fbbf5c' : '#22c55e';
  const open = Boolean(actions);
  const rootRef = useRef<HTMLDivElement>(null);

  // Bring the named carton into view — but only scroll the sheet's own list,
  // and only when it is open far enough to show it (nearestScrollTop). A
  // plain scrollIntoView would also scroll the overflow-hidden page shells
  // around the sheet, which is how a camera layout gets knocked sideways.
  useEffect(() => {
    if (!highlight) return;
    const el = rootRef.current;
    const list = el && scrollParent(el);
    if (!el || !list) return;
    const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const to = nearestScrollTop(top, el.offsetHeight, list.scrollTop, list.clientHeight);
    if (to !== null) list.scrollTo({ top: to, behavior: 'smooth' });
  }, [highlight]);

  return (
    <div
      ref={rootRef}
      onClick={onClick}
      className={`bg-[rgba(10,15,20,.5)] border rounded-[13px] px-[13px] py-[11px] transition-opacity ${highlight ? 'border-brand animate-markerPulse' : open ? 'border-line-strong' : 'border-line'} ${onClick ? 'cursor-pointer' : ''} ${dimmed ? 'opacity-50' : ''}`}
    >
      <div className="flex justify-between items-center gap-[10px]">
        <div className="flex items-center gap-[11px] min-w-0">
          <div className="flex-none w-10 h-10 rounded-[10px] bg-tile border border-line flex items-center justify-center font-mono font-black text-[16px] text-[#e8eef2]">
            {index}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-[5px]">
              <MI name={statusIcon} size={14} style={{ color: statusColor }} />
              {unprinted && (
                // Amber = needs attention: label saved, not printed yet.
                <span role="img" aria-label={unprintedLabel} title={unprintedLabel} className="flex-none inline-flex">
                  <MI name="print_disabled" size={13} style={{ color: '#fbbf5c' }} />
                </span>
              )}
              <span className="text-[12px] font-extrabold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis">
                {name}
              </span>
            </div>
            {barcode && (
              // Barcodes here run to 31 digits — without its own clamp this
              // line pushed the weight off the row.
              <span
                className="block font-mono text-[10px] font-medium text-[#e8eef2] tracking-[.3px] whitespace-nowrap overflow-hidden text-ellipsis"
                dir="ltr"
              >
                {barcode}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-[9px] flex-none">
          {weight !== undefined && (
            <span className="font-mono font-black text-[17px] text-ink-inverse">
              {weight} <span className="font-sans font-normal text-[10px]">{unitLabel}</span>
            </span>
          )}
          {onClick && (
            <MI name={open ? 'expand_less' : 'expand_more'} size={18} className="text-[#e8eef2]" />
          )}
        </div>
      </div>

      {actions && <div className="mt-[10px] pt-[10px] border-t border-line">{actions}</div>}
    </div>
  );
}
