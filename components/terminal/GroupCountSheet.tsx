'use client';

/**
 * "Change count" on an identical-label group (client request (c),
 * 2026-10-15): "all boxes identical" saved N labels and put N rows on the
 * list, and the only way to change N was deleting rows one by one or the
 * whole batch in Labels. A small bottom sheet with − / number / + and Save:
 *
 *   fewer → the last rows of the group come off the list, unprinted labels
 *           first, and their unprinted labels are deleted (lib/pallet-clear.ts
 *           rowsToShrink). If printed ones must go too, an amber line says
 *           how many stickers to peel off;
 *   more  → k more labels are saved with the same data and k rows join the
 *           group (growGroupRows).
 *
 * Only before the pallet is confirmed — the page offers it on open lists.
 */

import { useState } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';
import { clampGroupCount } from '@/lib/pallet-clear';

interface GroupCountSheetProps {
  name: string;
  /** Rows of the group on the list now. */
  current: number;
  /** How many of them still have an unprinted label (removed first). */
  unprinted: number;
  onSave: (next: number) => Promise<void>;
  onClose: () => void;
}

export function GroupCountSheet({ name, current, unprinted, onSave, onClose }: GroupCountSheetProps) {
  const tr = useT();
  const [input, setInput] = useState(String(current));
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const parsed = clampGroupCount(Number(input));
  const removing = parsed !== null && parsed < current ? current - parsed : 0;
  const printedToPeel = Math.max(0, removing - unprinted);

  const step = (d: number) => {
    const base = parsed ?? current;
    const next = clampGroupCount(base + d);
    if (next !== null) {
      setInput(String(next));
      setError(false);
    }
  };

  async function save() {
    if (busy) return;
    if (parsed === null) {
      setError(true);
      return;
    }
    if (parsed === current) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await onSave(parsed);
    } finally {
      setBusy(false);
    }
  }

  const stepBtn = 'flex-none w-[52px] h-[52px] rounded-[13px] bg-tile border border-line-strong text-ink-inverse inline-flex items-center justify-center active:bg-brand-weak disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[72] flex flex-col justify-end bg-[rgba(5,8,10,0.74)] backdrop-blur-[3px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] mx-auto bg-overlay-card border-t border-x border-line rounded-t-[20px] px-4 pt-3 pb-4 safe-bottom shadow-[0_-18px_48px_rgba(0,0,0,0.6)] animate-doneRise"
      >
        <div className="mx-auto mb-3 h-[4px] w-10 rounded-full bg-white/20" />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[16px] font-black text-ink-inverse">{tr('terminal.groupCountTitle')}</h2>
            <p className="text-[12px] font-bold text-brand-weak-ink truncate">{name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tr('common.close')}
            className="flex-none w-9 h-9 inline-flex items-center justify-center rounded-full text-ink-muted active:bg-white/10"
          >
            <MI name="close" size={20} />
          </button>
        </div>
        <p className="text-[11px] text-ink-muted mt-1 leading-snug">{tr('terminal.groupCountHint')}</p>

        {/* − on the start side, + on the end side: flips with the page in RTL. */}
        <div className="flex items-center gap-2 mt-3">
          <button type="button" onClick={() => step(-1)} disabled={busy} className={stepBtn} aria-label="-1">
            <MI name="remove" size={24} />
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(false); }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            onFocus={(e) => e.currentTarget.select()}
            dir="ltr"
            className="flex-1 min-w-0 h-[52px] text-center text-2xl font-black font-mono text-ink bg-sunken border-2 border-line-strong rounded-[13px] outline-none focus:border-brand focus:ring-4 focus:ring-brand/20"
          />
          <button type="button" onClick={() => step(1)} disabled={busy} className={stepBtn} aria-label="+1">
            <MI name="add" size={24} />
          </button>
        </div>

        {error && <p className="text-danger-weak-ink text-xs mt-2">{tr('terminal.groupCountInvalid')}</p>}
        {printedToPeel > 0 && (
          <p className="flex items-start gap-[6px] mt-2 text-[11.5px] font-bold text-warn-weak-ink leading-snug">
            <MI name="warning" size={15} className="flex-none mt-[1px]" />
            <span className="min-w-0">{tr('terminal.groupCountPrintedWarn', { count: printedToPeel })}</span>
          </p>
        )}

        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="mt-3 w-full h-[50px] rounded-[13px] bg-brand text-ink-inverse font-black text-[14px] inline-flex items-center justify-center gap-[6px] disabled:opacity-50"
        >
          <MI name="check" size={19} />
          {tr('terminal.groupCountSave')}
          {parsed !== null && parsed !== current && (
            <span className="font-mono" dir="ltr">({current} → {parsed})</span>
          )}
        </button>
      </div>
    </div>
  );
}
