'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

interface UnitsBatchRowProps {
  name: string;
  /** "7 cartons · exp 12/11/26" (+k when the save has more expiries). */
  summary: string;
  /** Units in the whole save, and their unit label. */
  units: number;
  unitLabel: string;
  expanded: boolean;
  onToggle: () => void;
  /** The save's own carton rows (HistoryRow), shown while expanded. */
  children?: ReactNode;
}

/**
 * One units save on the loose list (lib/units-cartons.ts groupUnitsRows):
 * the item, its cartons and expiry, the units — the HistoryRow look, with a
 * carton icon in the index badge. A tap opens the save's cartons, each still
 * its own row to edit or delete.
 */
export function UnitsBatchRow({ name, summary, units, unitLabel, expanded, onToggle, children }: UnitsBatchRowProps) {
  return (
    <div className={`bg-[rgba(10,15,20,.5)] border rounded-[13px] ${expanded ? 'border-line-strong' : 'border-line'}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full px-[13px] py-[11px] flex justify-between items-center gap-[10px] text-start"
      >
        <div className="flex items-center gap-[11px] min-w-0">
          <div className="flex-none w-10 h-10 rounded-[10px] bg-tile border border-line flex items-center justify-center text-[#e8eef2]">
            <MI name="inventory_2" size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-[5px]">
              <MI name="check_circle" size={14} style={{ color: '#22c55e' }} />
              <span className="text-[12px] font-extrabold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis">
                {name}
              </span>
            </div>
            <span className="block text-[10.5px] font-bold text-[#e8eef2] whitespace-nowrap overflow-hidden text-ellipsis">
              {summary}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-[9px] flex-none">
          <span className="font-mono font-black text-[17px] text-ink-inverse">
            {units} <span className="font-sans font-normal text-[10px]">{unitLabel}</span>
          </span>
          <MI name={expanded ? 'expand_less' : 'expand_more'} size={18} className="text-[#e8eef2]" />
        </div>
      </button>
      {expanded && <div className="px-[8px] pb-[8px] flex flex-col gap-[6px]">{children}</div>}
    </div>
  );
}
