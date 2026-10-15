'use client';

/**
 * The "מחק" (Delete) chip's sheet (client request (c), 2026-10-15).
 *
 * Until now the chip only said "tap a row to delete it" — 47 one-by-one
 * deletes on IN26013461. This bottom sheet offers the bulk actions for the
 * list in front of the worker (the open pallet, or the loose pile):
 *
 *   1. Delete all cartons on this pallet (N) — the list starts again; the
 *      unprinted labels of those rows go with them (the per-row rule).
 *   2. Delete all unprinted labels (M) — New carton labels included; their
 *      rows leave the list.
 *   3. Cancel printed labels (K) — only when some printed label of this
 *      pallet was never booked: they are voided, never deleted, and the
 *      worker is told to peel the stickers off (amber warning).
 *
 * Every action is two taps on the same button (the first arms it, as the
 * row's Delete does) — an in-page confirm, never window.confirm. Booked
 * cartons are never touched: the server refuses them (lib/pallet-clear.ts).
 * The printed count is read when the sheet opens; the unprinted count comes
 * from the page's own unprinted-labels list.
 */

import { useEffect, useState } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';
import type { LabelClearMode } from '@/lib/pallet-clear';

export type DeleteAllAction = 'rows' | Exclude<LabelClearMode, 'rows'>;

interface DeleteAllSheetProps {
  token: string;
  /** Pallet being scanned; 0 = the loose pile. */
  pallet: number;
  /** Rows on the open list. */
  rowCount: number;
  /** This pallet's labels still unprinted (the page's live list). */
  unprintedCount: number;
  /** Barcodes already booked in this session — never offered for voiding. */
  booked: ReadonlySet<string>;
  /** Runs the action; resolves when it is done (the sheet then closes). */
  onAction: (action: DeleteAllAction) => Promise<void>;
  onClose: () => void;
}

const ARM_MS = 3000;

export function DeleteAllSheet({
  token, pallet, rowCount, unprintedCount, booked, onAction, onClose,
}: DeleteAllSheetProps) {
  const tr = useT();
  const [armed, setArmed] = useState<DeleteAllAction | null>(null);
  const [busy, setBusy] = useState(false);
  // Printed labels of this pallet whose carton was never booked.
  const [printedCount, setPrintedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/carton-labels?token=${encodeURIComponent(token)}&scope=session&status=printed`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.success || !Array.isArray(data.labels)) return;
        const n = (data.labels as { barcode: string; pallet_number: number | null }[])
          .filter((l) => l.pallet_number === pallet && !booked.has(l.barcode)).length;
        setPrintedCount(n);
      })
      .catch(() => { /* no void option offered */ });
    return () => { cancelled = true; };
    // booked is read once per opening on purpose: the sheet is short-lived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pallet]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  async function press(action: DeleteAllAction) {
    if (busy) return;
    if (armed !== action) {
      setArmed(action);
      return;
    }
    setArmed(null);
    setBusy(true);
    try {
      await onAction(action);
    } finally {
      setBusy(false);
    }
  }

  const loose = pallet === 0;
  const nothing = rowCount === 0 && unprintedCount === 0 && printedCount === 0;

  const option = (opts: {
    action: DeleteAllAction;
    icon: string;
    title: string;
    hint: string;
    tone: 'danger' | 'warn';
    disabled?: boolean;
  }) => {
    const isArmed = armed === opts.action;
    const base = 'w-full min-h-[58px] flex items-center gap-[11px] rounded-[13px] border px-[13px] py-[10px] text-start disabled:opacity-40';
    const tone = isArmed
      ? opts.tone === 'danger' ? 'bg-danger border-danger text-white' : 'bg-warn border-warn text-canvas'
      : opts.tone === 'danger' ? 'bg-danger-weak border-danger/45 text-danger-weak-ink' : 'bg-warn-weak border-warn/45 text-warn-weak-ink';
    return (
      <button
        key={opts.action}
        type="button"
        disabled={busy || opts.disabled}
        onClick={() => void press(opts.action)}
        className={`${base} ${tone}`}
      >
        <MI name={isArmed ? 'delete_forever' : opts.icon} size={22} className="flex-none" />
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-black leading-tight wrap-anywhere">
            {isArmed ? tr('terminal.deleteAllConfirm') : opts.title}
          </span>
          <span className={`block text-[11px] font-semibold leading-snug mt-[2px] ${isArmed ? 'opacity-90' : 'opacity-80'}`}>
            {opts.hint}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[72] flex flex-col justify-end bg-[rgba(5,8,10,0.74)] backdrop-blur-[3px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] mx-auto bg-overlay-card border-t border-x border-line rounded-t-[20px] px-4 pt-3 pb-4 safe-bottom shadow-[0_-18px_48px_rgba(0,0,0,0.6)] animate-doneRise"
      >
        <div className="mx-auto mb-3 h-[4px] w-10 rounded-full bg-white/20" />
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="flex items-center gap-[7px] text-[16px] font-black text-ink-inverse min-w-0">
            <MI name="delete_sweep" size={20} className="flex-none text-[#ef8a8a]" />
            <span className="min-w-0 truncate">
              {loose ? tr('terminal.deleteAllTitleLoose') : tr('terminal.deleteAllTitle', { n: pallet })}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tr('common.close')}
            className="flex-none w-9 h-9 inline-flex items-center justify-center rounded-full text-ink-muted active:bg-white/10"
          >
            <MI name="close" size={20} />
          </button>
        </div>

        {nothing ? (
          <p className="text-center text-[12px] font-semibold text-ink-muted py-4">{tr('terminal.deleteAllNothing')}</p>
        ) : (
          <div className="flex flex-col gap-[9px]">
            {option({
              action: 'rows',
              icon: 'remove_shopping_cart',
              title: loose
                ? tr('terminal.deleteAllRowsLoose', { count: rowCount })
                : tr('terminal.deleteAllRows', { count: rowCount }),
              hint: tr('terminal.deleteAllRowsHint'),
              tone: 'danger',
              disabled: rowCount === 0,
            })}
            {option({
              action: 'unprinted',
              icon: 'label_off',
              title: tr('terminal.deleteAllLabels', { count: unprintedCount }),
              hint: tr('terminal.deleteAllLabelsHint'),
              tone: 'danger',
              disabled: unprintedCount === 0,
            })}
            {printedCount > 0 &&
              option({
                action: 'void_printed',
                icon: 'block',
                title: tr('terminal.voidPrinted', { count: printedCount }),
                hint: tr('terminal.voidPrintedWarn'),
                tone: 'warn',
              })}
          </div>
        )}
        <p className="flex items-center justify-center gap-1 text-[10.5px] font-semibold text-ink-muted text-center mt-3">
          <MI name="lock" size={13} className="flex-none" />
          {tr('terminal.deleteAllBookedNote')}
        </p>
      </div>
    </div>
  );
}
