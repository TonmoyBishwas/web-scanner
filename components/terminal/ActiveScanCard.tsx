'use client';

import { MI } from './MI';
import { ScanActions } from './ScanActions';
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
  /** "All boxes identical" — the worker declares every carton of this product
   *  the same and mints a printed label per carton (pallet-verify only). */
  onIdentical?: () => void;
  tone?: 'brand' | 'warn';
  /** This row's barcode is a saved label that has not been printed yet. */
  unprinted?: boolean;
  /** A re-read just named this carton ("already counted"): blue ring + pulse
   *  for a moment, so the worker sees WHICH carton the camera saw again. */
  highlight?: boolean;
}

// Design "active scan" summary card: #0a0f14 on 2px brand border, mono index
// badge, green live dot + "נסרק כרגע", big Roboto Mono value + chevron (the
// summary line itself expands the barcode/expiry rows), and the shared
// ScanActions bar, which wraps instead of running off a narrow phone.
//
// Sizing note: every metric here is one step below the original design spec.
// The card is pinned above the history list inside a sheet that also has to
// leave the camera room, and at the design's size a single scan pushed the
// first history row off-screen.
export function ActiveScanCard({
  index, name, value, unit, barcode, expiry,
  status = 'done', expanded, onToggleExpand,
  onEdit, onDelete, onRetry, onViewImage, onIdentical, tone = 'brand', unprinted = false,
  highlight = false,
}: ActiveScanCardProps) {
  const tr = useT();
  // Blue = information / focus: while a re-read names this carton it wears
  // the brand ring whatever its own tone.
  const borderColor = highlight ? '#13a4ec' : status === 'failed' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : '#13a4ec';
  const badgeBg = tone === 'warn' ? 'rgba(245,158,11,.16)' : 'rgba(19,164,236,.16)';
  const accentInk = tone === 'warn' ? '#fbbf5c' : '#7cc9f2';
  const failed = status === 'failed';

  return (
    <div
      className={`bg-header rounded-[14px] px-3 py-[9px] shadow-[inset_0_2px_10px_rgba(0,0,0,.4)] ${highlight ? 'animate-markerPulse' : ''}`}
      style={{ border: `2px solid ${borderColor}` }}
    >
      {/* The whole summary line is the details expander (as on a history
          row) — the separate "Details" toggle took room the actions needed. */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="w-full flex justify-between items-center gap-2 text-start"
      >
        <span className="flex items-center gap-[9px] min-w-0">
          <span
            className="flex-none w-[33px] h-[33px] rounded-[9px] flex items-center justify-center font-mono font-black text-[15px] text-ink-inverse"
            style={{ background: badgeBg, border: `1px solid ${borderColor}` }}
          >
            {index}
          </span>
          <span className="block min-w-0">
            <span
              className="inline-flex items-center gap-1 text-[8.5px] font-black tracking-[1px] mb-[2px]"
              style={{ color: accentInk }}
            >
              <span
                className={`w-[6px] h-[6px] rounded-full inline-block ${status === 'reading' ? 'animate-shim' : ''}`}
                style={{ background: failed ? '#ef4444' : '#22c55e' }}
              />
              {highlight ? (
                <span className="inline-flex items-center gap-[3px] text-brand-weak-ink tracking-normal whitespace-nowrap">
                  <MI name="done_all" size={13} />
                  {tr('scanner.alreadyCounted')}
                </span>
              ) : failed ? (
                tr('terminal.notRecognized')
              ) : unprinted ? (
                // Amber = needs attention: the carton is on the list, its
                // label is saved but still has to come out of the printer.
                <span className="inline-flex items-center gap-[3px] text-[#fbbf5c] tracking-normal whitespace-nowrap">
                  <MI name="print_disabled" size={13} />
                  {tr('terminal.labelNotPrinted')}
                </span>
              ) : (
                tr('terminal.scanningNow')
              )}
            </span>
            <span className="block text-[14px] font-extrabold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis">
              {name}
            </span>
          </span>
        </span>
        <span className="flex items-center gap-[6px] flex-none">
          <span className="flex items-baseline gap-[2px]" dir="ltr">
            <span className="font-mono font-black text-[23px] leading-none text-ink-inverse">{value}</span>
            <span className="text-[12px] font-extrabold" style={{ color: accentInk }}>{unit}</span>
          </span>
          <MI name={expanded ? 'expand_less' : 'expand_more'} size={18} className="text-[#e8eef2]" />
        </span>
      </button>

      <div className="mt-2 border-t border-white/8 pt-[7px]">
        <ScanActions
          onViewImage={failed ? onViewImage : undefined}
          onRetry={failed ? onRetry : undefined}
          onEdit={onEdit}
          onIdentical={onIdentical}
          onDelete={onDelete}
        />
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
