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
  /** Drop this scan. Must be reachable HERE — the newest scan is the one a
   *  worker realises they mis-scanned, and it is not in the history list. */
  onDelete?: () => void;
  /** Failed-OCR only: re-run OCR / look at the captured frame. */
  onRetry?: () => void;
  onViewImage?: () => void;
  tone?: 'brand' | 'warn';
}

// Design "active scan" summary card: #0a0f14 on 2px brand border, mono index
// badge, green live dot + "נסרק כרגע", big Roboto Mono value, פרטים expander
// + action row, expandable barcode/expiry rows.
//
// Sizing note: every metric here is one step below the original design spec.
// The card is pinned above the history list inside a sheet that also has to
// leave the camera room, and at the design's size a single scan pushed the
// first history row off-screen.
export function ActiveScanCard({
  index, name, value, unit, barcode, expiry,
  status = 'done', expanded, onToggleExpand,
  onEdit, onDelete, onRetry, onViewImage, tone = 'brand',
}: ActiveScanCardProps) {
  const tr = useT();
  const borderColor = status === 'failed' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : '#13a4ec';
  const badgeBg = tone === 'warn' ? 'rgba(245,158,11,.16)' : 'rgba(19,164,236,.16)';
  const accentInk = tone === 'warn' ? '#fbbf5c' : '#7cc9f2';
  const failed = status === 'failed';

  return (
    <div
      className="bg-header rounded-[14px] px-3 py-[9px] shadow-[inset_0_2px_10px_rgba(0,0,0,.4)]"
      style={{ border: `2px solid ${borderColor}` }}
    >
      <div className="flex justify-between items-center gap-2">
        <div className="flex items-center gap-[9px] min-w-0">
          <div
            className="flex-none w-[33px] h-[33px] rounded-[9px] flex items-center justify-center font-mono font-black text-[15px] text-ink-inverse"
            style={{ background: badgeBg, border: `1px solid ${borderColor}` }}
          >
            {index}
          </div>
          <div className="min-w-0">
            <span
              className="inline-flex items-center gap-1 text-[8.5px] font-black tracking-[1px] mb-[2px]"
              style={{ color: accentInk }}
            >
              <span
                className={`w-[6px] h-[6px] rounded-full inline-block ${status === 'reading' ? 'animate-shim' : ''}`}
                style={{ background: failed ? '#ef4444' : '#22c55e' }}
              />
              {failed ? tr('terminal.notRecognized') : tr('terminal.scanningNow')}
            </span>
            <div className="text-[14px] font-extrabold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis">
              {name}
            </div>
          </div>
        </div>
        <div className="flex items-baseline gap-[2px] justify-end flex-none" dir="ltr">
          <span className="font-mono font-black text-[23px] leading-none text-ink-inverse">{value}</span>
          <span className="text-[12px] font-extrabold" style={{ color: accentInk }}>{unit}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 border-t border-white/8 pt-[7px]">
        <button
          onClick={onToggleExpand}
          className="flex-none flex items-center gap-[4px] text-[#e8eef2] text-[11px] font-bold py-[2px]"
        >
          {tr('terminal.details')}
          <MI name={expanded ? 'expand_less' : 'expand_more'} size={17} />
        </button>
        <div className="flex items-center gap-[6px] flex-none">
          {failed && onViewImage && (
            <button
              onClick={onViewImage}
              className="flex items-center gap-[4px] bg-white/6 border border-white/18 text-ink-inverse rounded-[9px] px-[10px] py-[5px] text-[11px] font-extrabold"
            >
              <MI name="image" size={15} />
              {tr('ocr.view')}
            </button>
          )}
          {failed && onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-[4px] bg-brand-weak border border-brand/40 text-brand-weak-ink rounded-[9px] px-[10px] py-[5px] text-[11px] font-extrabold"
            >
              <MI name="refresh" size={15} />
              {tr('ocr.retry')}
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="flex items-center gap-[4px] bg-danger-weak border border-danger/45 text-danger-weak-ink rounded-[9px] px-[10px] py-[5px] text-[11px] font-extrabold"
            >
              <MI name="delete" size={15} />
              {tr('common.delete')}
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-[4px] bg-white/6 border border-white/18 text-ink-inverse rounded-[9px] px-[10px] py-[5px] text-[11px] font-extrabold"
            >
              <MI name="edit" size={15} />
              {tr('terminal.edit')}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-white/8 flex flex-col gap-[6px]">
          {barcode && (
            <div className="flex justify-between items-center gap-2">
              <span className="flex-none text-[10px] font-bold text-ink-inverse">{tr('terminal.barcode')}</span>
              <span
                className="font-mono text-[11px] font-semibold text-ink-inverse min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                dir="ltr"
              >
                {barcode}
              </span>
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
