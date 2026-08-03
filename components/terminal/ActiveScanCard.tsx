'use client';

import { MI } from './MI';
import { useT } from '@/lib/i18n';

interface ActiveScanCardProps {
  index: number;
  name: string;
  /** Big mono value (weight) already formatted, e.g. "18.45" */
  value: string;
  unit: string;
  barcode?: string;
  expiry?: string;
  status?: 'reading' | 'done' | 'failed';
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit?: () => void;
  tone?: 'brand' | 'warn';
}

// Design "active scan" summary card: #0a0f14 on 2px brand border, 38px mono
// index badge, green live dot + "נסרק כרגע", 26px Roboto Mono value,
// פרטים expander + ערוך button, expandable barcode/expiry rows.
export function ActiveScanCard({
  index, name, value, unit, barcode, expiry,
  status = 'done', expanded, onToggleExpand, onEdit, tone = 'brand',
}: ActiveScanCardProps) {
  const tr = useT();
  const borderColor = status === 'failed' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : '#13a4ec';
  const badgeBg = tone === 'warn' ? 'rgba(245,158,11,.16)' : 'rgba(19,164,236,.16)';
  const accentInk = tone === 'warn' ? '#fbbf5c' : '#7cc9f2';

  return (
    <div
      className="bg-header rounded-[14px] px-[13px] py-3 shadow-[inset_0_2px_10px_rgba(0,0,0,.4)]"
      style={{ border: `2px solid ${borderColor}` }}
    >
      <div className="flex justify-between items-center gap-[10px]">
        <div className="flex items-center gap-[10px] min-w-0">
          <div
            className="flex-none w-[38px] h-[38px] rounded-[10px] flex items-center justify-center font-mono font-black text-[16px] text-ink-inverse"
            style={{ background: badgeBg, border: `1px solid ${borderColor}` }}
          >
            {index}
          </div>
          <div className="min-w-0">
            <span
              className="inline-flex items-center gap-1 text-[8.5px] font-black tracking-[1px] mb-[3px]"
              style={{ color: accentInk }}
            >
              <span
                className={`w-[6px] h-[6px] rounded-full inline-block ${status === 'reading' ? 'animate-shim' : ''}`}
                style={{ background: status === 'failed' ? '#ef4444' : '#22c55e' }}
              />
              {status === 'failed' ? tr('terminal.notRecognized') : tr('terminal.scanningNow')}
            </span>
            <div className="text-[15px] font-extrabold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis">
              {name}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-[10px] flex-none">
          <div className="flex items-baseline gap-[2px] justify-end" dir="ltr">
            <span className="font-mono font-black text-[26px] leading-none text-ink-inverse">{value}</span>
            <span className="text-[12px] font-extrabold" style={{ color: accentInk }}>{unit}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-[10px] border-t border-white/8 pt-2">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-[5px] text-[#e8eef2] text-[11px] font-bold py-[2px]"
        >
          {tr('terminal.details')}
          <MI name={expanded ? 'expand_less' : 'expand_more'} size={17} />
        </button>
        {onEdit && (
          <button
            onClick={onEdit}
            className="flex-none flex items-center gap-[5px] bg-white/6 border border-white/18 text-ink-inverse rounded-[9px] px-3 py-[6px] text-[11px] font-extrabold"
          >
            <MI name="edit" size={16} />
            {tr('terminal.edit')}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-[11px] pt-[11px] border-t border-white/8 flex flex-col gap-2">
          {barcode && (
            <div className="flex justify-between items-center gap-2">
              <span className="text-[10px] font-bold text-ink-inverse">{tr('terminal.barcode')}</span>
              <span className="font-mono text-[11px] font-semibold text-ink-inverse" dir="ltr">{barcode}</span>
            </div>
          )}
          {expiry && (
            <div className="flex justify-between items-center gap-2">
              <span className="text-[10px] font-bold text-ink-inverse">{tr('terminal.expiry')}</span>
              <span className="font-mono text-[11px] font-semibold text-ink-inverse" dir="ltr">{expiry}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
