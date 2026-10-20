'use client';

import { MI } from './MI';
import { ScanActions } from './ScanActions';
import { SelectBox } from './SelectBox';
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
  /** Identical-label group: change its carton count (see ScanActions). */
  onChangeCount?: () => void;
  groupCount?: number;
  tone?: 'brand' | 'warn';
  /** This row's barcode is a saved label that has not been printed yet. */
  unprinted?: boolean;
  /** A re-read just named this carton ("already counted"): blue ring + pulse
   *  for a moment, so the worker sees WHICH carton the camera saw again. */
  highlight?: boolean;
  /** Selection mode (the Delete chip, client's design): a checkbox on this
   *  card too, the summary line ticks it instead of expanding, and the
   *  action bar steps aside (the design hides Edit while selecting). */
  select?: { checked: boolean; locked?: boolean; onToggle: () => void };
  /** Why this carton needs a look, in a few words — an amber line under the
   *  name (a doubted weight, a missing value). Wraps, never truncated. */
  note?: string;
  /** The weight / expiry is the carton's own barcode reading (client rule
   *  19/10, lib/barcode-reconcile.ts): a small neutral marker, nothing to do. */
  fromBarcode?: { weight?: boolean; expiry?: boolean };
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
  onEdit, onDelete, onRetry, onViewImage, onIdentical, onChangeCount, groupCount, tone = 'brand', unprinted = false,
  highlight = false, select, note, fromBarcode,
}: ActiveScanCardProps) {
  const tr = useT();
  // Blue = information / focus: while a re-read names this carton it wears
  // the brand ring whatever its own tone.
  const picked = !!select?.checked;
  const borderColor = highlight || picked ? '#13a4ec' : status === 'failed' ? '#ef4444' : tone === 'warn' || note ? '#f59e0b' : '#13a4ec';
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
        onClick={select ? select.onToggle : onToggleExpand}
        aria-expanded={select ? undefined : expanded}
        role={select ? 'checkbox' : undefined}
        aria-checked={select ? picked : undefined}
        aria-disabled={select?.locked || undefined}
        className="w-full flex justify-between items-center gap-2 text-start"
      >
        <span className="flex items-center gap-[9px] min-w-0">
          {select && <SelectBox checked={picked} locked={select.locked} />}
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
            {note && (
              <span className="flex items-start gap-[3px] mt-[2px] text-[10.5px] font-extrabold text-[#fbbf5c] leading-[1.3]">
                <MI name="report_problem" size={13} className="flex-none" />
                <span className="min-w-0">{note}</span>
              </span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-[6px] flex-none">
          <span className="flex items-baseline gap-[2px]" dir="ltr">
            {fromBarcode?.weight && (
              <span title={tr('terminal.fromBarcode')} aria-label={tr('terminal.fromBarcode')} className="self-center text-ink-muted">
                <MI name="qr_code_scanner" size={13} />
              </span>
            )}
            <span className="font-mono font-black text-[23px] leading-none text-ink-inverse">{value}</span>
            <span className="text-[12px] font-extrabold" style={{ color: accentInk }}>{unit}</span>
          </span>
          {!select && <MI name={expanded ? 'expand_less' : 'expand_more'} size={18} className="text-[#e8eef2]" />}
        </span>
      </button>

      {!select && <div className="mt-2 border-t border-white/8 pt-[7px]">
        <ScanActions
          // A new scan becomes this card: an armed Delete must not carry over to it.
          key={`${index}:${barcode ?? ''}`}
          onViewImage={failed ? onViewImage : undefined}
          onRetry={failed ? onRetry : undefined}
          onEdit={onEdit}
          onIdentical={onIdentical}
          onChangeCount={failed ? undefined : onChangeCount}
          groupCount={groupCount}
          onDelete={onDelete}
        />
      </div>}

      {expanded && !select && (
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
              <span className="flex items-center gap-[5px] min-w-0">
                {fromBarcode?.expiry && (
                  <span className="flex items-center gap-[2px] text-[9.5px] font-bold text-ink-muted">
                    <MI name="qr_code_scanner" size={11} className="flex-none" />
                    {tr('terminal.fromBarcode')}
                  </span>
                )}
                <span className="font-mono text-[11px] font-semibold text-ink-inverse" dir="ltr">{expiry}</span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
