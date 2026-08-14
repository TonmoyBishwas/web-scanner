'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

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
   * Row actions (edit / delete / retry). Rendered as a full-width row BELOW
   * the summary line — squeezing them in beside the weight collided with the
   * 31-digit barcode and left both unreadable.
   */
  actions?: ReactNode;
  dimmed?: boolean;
}

// Design history row: rgba(10,15,20,.5) on #1e2a35 hairline, 40px mono index
// badge, green check + name, LTR mono barcode, 17px mono weight, chevron.
export function HistoryRow({
  index, name, barcode, weight, unitLabel = 'ק"ג',
  status = 'done', onClick, actions, dimmed = false,
}: HistoryRowProps) {
  const statusIcon = status === 'failed' ? 'error' : status === 'pending' ? 'hourglass_empty' : 'check_circle';
  const statusColor = status === 'failed' ? '#ef4444' : status === 'pending' ? '#fbbf5c' : '#22c55e';
  const open = Boolean(actions);

  return (
    <div
      onClick={onClick}
      className={`bg-[rgba(10,15,20,.5)] border rounded-[13px] px-[13px] py-[11px] transition-opacity ${open ? 'border-line-strong' : 'border-line'} ${onClick ? 'cursor-pointer' : ''} ${dimmed ? 'opacity-50' : ''}`}
    >
      <div className="flex justify-between items-center gap-[10px]">
        <div className="flex items-center gap-[11px] min-w-0">
          <div className="flex-none w-10 h-10 rounded-[10px] bg-tile border border-line flex items-center justify-center font-mono font-black text-[16px] text-[#e8eef2]">
            {index}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-[5px]">
              <MI name={statusIcon} size={14} style={{ color: statusColor }} />
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

      {actions && (
        <div className="flex items-center gap-2 mt-[10px] pt-[10px] border-t border-line">{actions}</div>
      )}
    </div>
  );
}
