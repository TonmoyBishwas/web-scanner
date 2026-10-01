'use client';

/**
 * מדבקות — Labels.
 *
 * The print queue for every label this job SAVED — New carton, "all boxes
 * identical" and the edit panel's new barcode: pick a label size, select the
 * batches to print, hand them to the browser's print dialog, and see at a
 * glance which still need printing. Saving and printing are separate steps
 * (2026-10-01): the floor saves labels while scanning and prints them here in
 * one go, any time before the pallet is closed.
 *
 * "Printed" is recorded by the print sheet itself for the labels it rendered,
 * not by this screen when the tab opens. "Mark as printed" is the fallback
 * for a sheet printed elsewhere. Unprinted = amber with a crossed-out
 * printer; printed = green.
 *
 * Writes only the `carton_labels` ledger — except that deleting a batch whose
 * cartons are still rows on the scan list also takes those rows off it (the
 * page does that through `onBatchDeleted`; the confirm says so first). A
 * batch already booked on an LPN cannot be deleted, only reprinted.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { CartonSticker } from './CartonSticker';
import { Toast, useToast } from './Toast';
import { LanguageContext, useT } from '@/lib/i18n';
import {
  labelSheetUrl,
  labelTags,
  loadLabelSize,
  rowsOnList,
  saveLabelSize,
  sortUnprintedFirst,
  type LabelTag,
  type LiveRowPlace,
} from '@/lib/label-batches';
import { trace } from '@/lib/scanner-trace';
import type { CartonLabel, LabelSize } from '@/types';

type StatusFilter = 'all' | 'created' | 'printed';
type Scope = 'session' | 'all';

const SIZES: { id: LabelSize; name: string }[] = [
  { id: '10x10', name: '10×10' },
  { id: '10x15', name: '10×15' },
  { id: 'a4', name: 'A4' },
];

interface LabelBatch {
  batch_id: string;
  sample: CartonLabel;
  count: number;
  printedCount: number;
  maxPrintCount: number;
}

/** Collapse the per-carton rows back into the submissions that created them. */
function groupBatches(labels: CartonLabel[]): LabelBatch[] {
  const byBatch = new Map<string, LabelBatch>();
  for (const label of labels) {
    const existing = byBatch.get(label.batch_id);
    if (existing) {
      existing.count += 1;
      if (label.status === 'printed') existing.printedCount += 1;
      existing.maxPrintCount = Math.max(existing.maxPrintCount, label.print_count);
    } else {
      byBatch.set(label.batch_id, {
        batch_id: label.batch_id,
        sample: label,
        count: 1,
        printedCount: label.status === 'printed' ? 1 : 0,
        maxPrintCount: label.print_count,
      });
    }
  }
  return [...byBatch.values()];
}

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : '';
}

interface LabelsBrowserProps {
  token: string;
  onBack: () => void;
  /** Which status filter to open on — 'created' when labels await printing. */
  initialStatus?: 'created' | 'all';
  /** Something changed in the ledger (printed, marked, deleted). */
  onChanged?: () => void;
  /** barcode → where its row sits on the scanner's live lists right now. */
  liveRows?: ReadonlyMap<string, LiveRowPlace>;
  /** A batch was deleted: drop these barcodes' rows from the lists. */
  onBatchDeleted?: (batchId: string, barcodes: string[], sourceBarcode: string | null) => void;
}

type Confirm = { batchId: string; kind: 'delete' | 'mark' };

export function LabelsBrowser({
  token, onBack, initialStatus = 'all', onChanged, liveRows, onBatchDeleted,
}: LabelsBrowserProps) {
  const tr = useT();
  const language = useContext(LanguageContext);
  const { toast, showToast } = useToast();

  // Remembered per device: a warehouse's printer takes one stock.
  const [size, setSize] = useState<LabelSize>(loadLabelSize);
  // Opens on THIS job's labels. Anything older is a different job, even when
  // it carries the same invoice number — re-scanning an invoice mints a new
  // session, and showing both runs side by side is how a worker reprints
  // yesterday's label onto today's carton.
  const [scope, setScope] = useState<Scope>('session');
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [labels, setLabels] = useState<CartonLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<'labels.error' | 'labels.sessionExpired' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  // Opening on "Not printed" puts the active chip at the far end of the
  // scrolling filter row, half off a 320 px screen — bring it into view.
  const activeStatusRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeStatusRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  /** `quiet` = refresh in place (returning from the print tab) without the loading line. */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setErrorKey(null);
    try {
      const res = await fetch(
        `/api/carton-labels?token=${encodeURIComponent(token)}&scope=${scope}&status=${status}`
      );
      if (res.status === 401) {
        setErrorKey('labels.sessionExpired');
        setLabels([]);
        return;
      }
      const data = await res.json();
      if (!data?.success) {
        setErrorKey('labels.error');
        setLabels([]);
        return;
      }
      setLabels(data.labels as CartonLabel[]);
    } catch {
      setErrorKey('labels.error');
      setLabels([]);
    } finally {
      setLoading(false);
    }
  }, [token, scope, status]);

  useEffect(() => { void load(); }, [load]);

  // Back from the print tab: the sheet has flipped what it printed by now.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void load(true);
      onChanged?.();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [load, onChanged]);

  const batches = useMemo(() => sortUnprintedFirst(groupBatches(labels)), [labels]);
  const totalSelectedLabels = useMemo(
    () => batches.filter(b => selected.has(b.batch_id)).reduce((n, b) => n + b.count, 0),
    [batches, selected]
  );

  // Drop selections whose batch left the current filter, so the print button's
  // count can never promise stickers the list is no longer showing.
  useEffect(() => {
    setSelected(prev => {
      const live = new Set(batches.map(b => b.batch_id));
      const next = new Set([...prev].filter(id => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [batches]);

  function toggleBatch(batchId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => (prev.size === batches.length ? new Set() : new Set(batches.map(b => b.batch_id))));
  }

  function pickSize(next: LabelSize) {
    setSize(next);
    saveLabelSize(next);
  }

  function handlePrint() {
    const batchIds = batches.filter(b => selected.has(b.batch_id)).map(b => b.batch_id);
    if (!batchIds.length) return;

    // Opened synchronously inside the click — a window.open after an awaited
    // fetch is what pop-up blockers kill. Nothing is marked here: the sheet
    // marks the labels it actually rendered, right before its print dialog.
    const win = window.open(labelSheetUrl({ token, batchIds, size, language }), '_blank');
    if (!win) {
      showToast(tr('labels.printBlocked'), 'error', '#ef8a8a');
      return;
    }
    trace('ui', 'labels_print_opened', { batch_ids: batchIds, count: totalSelectedLabels, size });
    showToast(tr('labels.printSent', { count: totalSelectedLabels }), 'print');
    setSelected(new Set());
  }

  /** "Mark as printed" — for a sheet printed elsewhere, or a tab killed before it could report. */
  async function handleMarkPrinted(batch: LabelBatch) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/carton-labels/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, batch_ids: [batch.batch_id], via: 'manual' }),
      });
      const data = await res.json();
      if (!data?.success) {
        showToast(tr('labels.markFailed'), 'error', '#ef8a8a');
        return;
      }
      trace('ui', 'labels_marked_printed', { batch_id: batch.batch_id, count: batch.count });
      showToast(tr('labels.markedPrinted', { count: batch.count }), 'task_alt');
      setConfirm(null);
      void load(true);
      onChanged?.();
    } catch {
      showToast(tr('labels.markFailed'), 'error', '#ef8a8a');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(batchId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/carton-labels?token=${encodeURIComponent(token)}&batch=${encodeURIComponent(batchId)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (res.status === 409 && data?.error === 'labels_booked') {
        // Already stock on an LPN: the stickers are on boxes in the
        // warehouse, so the ledger keeps them (reprint only).
        showToast(tr('labels.deleteBooked'), 'info', '#fbbf5c');
        setConfirm(null);
        return;
      }
      if (!data?.success) {
        showToast(tr('labels.deleteFailed'), 'error', '#ef8a8a');
        return;
      }
      const barcodes: string[] = Array.isArray(data.barcodes) ? data.barcodes : [];
      trace('ui', 'labels_batch_deleted', { batch_id: batchId, count: barcodes.length });
      onBatchDeleted?.(batchId, barcodes, typeof data.source_barcode === 'string' ? data.source_barcode : null);
      showToast(tr('labels.deleted'), 'delete');
      setConfirm(null);
      void load(true);
      onChanged?.();
    } catch {
      showToast(tr('labels.deleteFailed'), 'error', '#ef8a8a');
    } finally {
      setBusy(false);
    }
  }

  function tagText(tag: LabelTag): string {
    if (tag.kind === 'pallet') return tr('labels.palletTag', { n: tag.n });
    if (tag.kind === 'loose') return tr('labels.looseTag');
    return tr('labels.newCartonTag');
  }

  // flex-none + nowrap: in the scrolling filter row a chip used to shrink and
  // break its label onto two lines ("לא / הודפסו") on a 320 px phone.
  const chip = (active: boolean) =>
    `flex-none whitespace-nowrap px-3 h-[32px] rounded-[9px] text-[11.5px] font-extrabold border ${
      active ? 'bg-brand-weak border-brand text-ink-inverse' : 'bg-tile border-line text-ink-muted'
    }`;

  return (
    <ScreenOverlay title={tr('labels.title')} onBack={onBack}>
      <div className="flex-none px-3 pt-3 pb-2 flex flex-col gap-[10px] border-b border-line">
        <div>
          <div className="text-[10px] font-extrabold tracking-[1px] text-brand-weak-ink mb-[7px] mx-[2px]">
            {tr('labels.size')}
          </div>
          <div className="flex gap-[6px] bg-sunken border border-line rounded-[11px] p-[4px]">
            {SIZES.map(s => (
              <button
                key={s.id}
                onClick={() => pickSize(s.id)}
                className={`flex-1 h-[34px] rounded-[8px] text-[12px] font-extrabold ${
                  size === s.id ? 'bg-brand text-white' : 'text-ink-muted'
                }`}
              >
                {/* Without an explicit LTR run, bidi reorders "10×15" to read
                    "15×10" inside the RTL screen — and that is a physical
                    label dimension the worker has to get right. */}
                <span dir="ltr">{s.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-[6px] overflow-x-auto no-scrollbar">
          <button onClick={() => setScope('session')} className={chip(scope === 'session')}>
            {tr('labels.scopeSession')}
          </button>
          <button onClick={() => setScope('all')} className={chip(scope === 'all')}>
            {tr('labels.scopeAll')}
          </button>
          <span className="w-px bg-line flex-none my-1" />
          <button onClick={() => setStatus('all')} className={chip(status === 'all')}>
            {tr('labels.filterAll')}
          </button>
          <button
            ref={initialStatus === 'created' ? activeStatusRef : undefined}
            onClick={() => setStatus('created')}
            className={chip(status === 'created')}
          >
            {tr('labels.filterCreated')}
          </button>
          <button onClick={() => setStatus('printed')} className={chip(status === 'printed')}>
            {tr('labels.filterPrinted')}
          </button>
        </div>

        {batches.length > 0 ? (
          <div className="flex items-center justify-between mx-[2px]">
            <span className="text-[10px] font-extrabold tracking-[1px] text-brand-weak-ink">
              {tr('labels.selectedCount', { selected: totalSelectedLabels, total: labels.length })}
            </span>
            <button onClick={toggleAll} className="text-[10px] font-extrabold text-brand-weak-ink">
              {selected.size === batches.length ? tr('labels.clearSelection') : tr('labels.selectAll')}
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        {loading ? (
          <p className="text-[12px] font-bold text-ink-muted text-center mt-8">{tr('labels.sheetLoading')}</p>
        ) : errorKey ? (
          <p className="text-[12px] font-bold text-ink-muted text-center mt-8">{tr(errorKey)}</p>
        ) : batches.length === 0 ? (
          status === 'created' ? (
            // Green = done: nothing is waiting for the printer.
            <p className="flex items-center justify-center gap-[6px] text-[12px] font-bold text-ok-weak-ink text-center mt-8 leading-[1.5]">
              <MI name="task_alt" size={18} />
              {tr('labels.emptyUnprinted')}
            </p>
          ) : (
            <p className="text-[12px] font-bold text-ink-muted text-center mt-8 leading-[1.5]">
              {status !== 'all'
                ? tr('labels.emptyFiltered')
                : scope === 'session'
                  ? tr('labels.empty')
                  : tr('labels.emptyAll')}
            </p>
          )
        ) : (
          batches.map(batch => {
            const isSelected = selected.has(batch.batch_id);
            const printed = batch.printedCount === batch.count;
            const label = batch.sample;
            const confirming = confirm?.batchId === batch.batch_id ? confirm.kind : null;
            const onList = confirming === 'delete'
              ? rowsOnList(labels.filter(l => l.batch_id === batch.batch_id).map(l => l.barcode), liveRows)
              : { count: 0, place: null };
            return (
              <div
                key={batch.batch_id}
                className={`rounded-[13px] border bg-raised ${isSelected ? 'border-brand' : 'border-line'}`}
              >
                <button onClick={() => toggleBatch(batch.batch_id)} className="w-full p-[11px] flex items-center gap-[11px] text-start">
                  <span
                    className="flex-none w-[22px] h-[22px] rounded-[7px] border flex items-center justify-center"
                    style={{
                      background: isSelected ? '#13a4ec' : 'transparent',
                      borderColor: isSelected ? '#13a4ec' : '#2a3a47',
                    }}
                  >
                    {isSelected ? <MI name="check" size={15} className="text-white" /> : null}
                  </span>

                  {/* Sticker thumbnail — the physical thing this row prints. */}
                  <span
                    className="flex-none rounded-[5px] overflow-hidden"
                    style={{ width: 46, height: 62, boxShadow: '0 2px 6px rgba(0,0,0,.4)' }}
                  >
                    <CartonSticker label={label} fontSize="2.6px" />
                  </span>

                  <span className="flex-1 min-w-0">
                    <span className="block text-[13.5px] font-extrabold text-ink-inverse truncate">
                      {label.item_name_hebrew || label.item_name_english}
                    </span>
                    <span className="block text-[10.5px] font-bold text-ink-muted mt-[3px] truncate">
                      {[
                        label.weight_kg != null ? `${tr('labels.weightLabel')} ${label.weight_kg}` : '',
                        label.expiry_date ? `${tr('labels.expiryLabel')} ${shortDate(label.expiry_date)}` : '',
                        label.print_barcode ? '' : tr('labels.noBarcode'),
                      ].filter(Boolean).join(' · ')}
                    </span>
                    <span className="flex flex-wrap items-center gap-[6px] mt-[5px]">
                      {/* Amber + crossed-out printer = still to print;
                          green + tick = printed. */}
                      <span
                        className="inline-flex items-center gap-[3px] px-[7px] py-[2px] rounded-[6px] text-[9.5px] font-extrabold"
                        style={
                          printed
                            ? { background: 'rgba(34,197,94,.16)', color: '#86efac' }
                            : { background: 'rgba(245,158,11,.18)', color: '#fbbf5c' }
                        }
                      >
                        <MI name={printed ? 'check_circle' : 'print_disabled'} size={11} />
                        {printed
                          ? batch.maxPrintCount > 1
                            ? tr('labels.printedTimes', { count: batch.maxPrintCount })
                            : tr('labels.statusPrinted')
                          : tr('labels.statusCreated')}
                      </span>
                      {labelTags(label).map(tag => (
                        <span
                          key={tag.kind}
                          className="px-[6px] py-[1px] rounded-[6px] border border-line bg-tile text-[9.5px] font-extrabold text-ink-inverse"
                        >
                          {tagText(tag)}
                        </span>
                      ))}
                      <span className="text-[10px] font-bold text-ink-muted" dir="ltr">
                        {label.serial}
                      </span>
                    </span>
                  </span>

                  <span className="flex-none text-[16px] font-black text-ink-inverse">×{batch.count}</span>
                </button>

                {confirming === 'mark' ? (
                  <div className="border-t border-line">
                    <p className="flex items-start gap-[6px] px-[11px] pt-[9px] text-[11px] font-bold text-ink-inverse leading-[1.45]">
                      <MI name="task_alt" size={15} className="flex-none text-ok-weak-ink mt-[1px]" />
                      {tr('labels.markPrintedConfirm', { count: batch.count })}
                    </p>
                    <div className="flex items-center">
                      <button
                        onClick={() => void handleMarkPrinted(batch)}
                        disabled={busy}
                        className="flex-1 py-[10px] flex items-center justify-center gap-[6px] text-[11.5px] font-extrabold text-ok-weak-ink disabled:opacity-50"
                      >
                        <MI name="task_alt" size={16} />
                        {tr('labels.markPrinted')}
                      </button>
                      <button
                        onClick={() => setConfirm(null)}
                        className="flex-1 py-[10px] text-[11.5px] font-extrabold text-ink-muted border-s border-line"
                      >
                        {tr('labels.cancelDelete')}
                      </button>
                    </div>
                  </div>
                ) : confirming === 'delete' ? (
                  <div className="border-t border-line">
                    {onList.count > 0 && onList.place !== null ? (
                      // Red: deleting the batch also takes its boxes off the pallet list.
                      <p className="flex items-start gap-[6px] px-[11px] pt-[9px] text-[11px] font-bold text-danger-weak-ink leading-[1.45]">
                        <MI name="warning" size={15} className="flex-none mt-[1px]" />
                        {onList.place === 'loose'
                          ? tr('labels.deleteAlsoRemovesLoose', { count: onList.count })
                          : tr('labels.deleteAlsoRemoves', { count: onList.count, n: onList.place })}
                      </p>
                    ) : null}
                    <div className="flex items-center">
                      <button
                        onClick={() => void handleDelete(batch.batch_id)}
                        disabled={busy}
                        className="flex-1 py-[10px] flex items-center justify-center gap-[6px] text-[11.5px] font-extrabold text-[#ef8a8a] disabled:opacity-50"
                      >
                        <MI name="delete_outline" size={16} />
                        {tr('labels.delete')}
                      </button>
                      <button
                        onClick={() => setConfirm(null)}
                        className="flex-1 py-[10px] text-[11.5px] font-extrabold text-ink-muted border-s border-line"
                      >
                        {tr('labels.cancelDelete')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center border-t border-line">
                    {!printed ? (
                      <button
                        onClick={() => setConfirm({ batchId: batch.batch_id, kind: 'mark' })}
                        className="flex-1 min-w-0 py-[9px] px-2 flex items-center justify-center gap-[6px] text-[11.5px] font-extrabold text-ink-inverse border-e border-line"
                      >
                        <MI name="task_alt" size={16} className="flex-none text-ok-weak-ink" />
                        <span className="truncate">{tr('labels.markPrinted')}</span>
                      </button>
                    ) : null}
                    <button
                      onClick={() => setConfirm({ batchId: batch.batch_id, kind: 'delete' })}
                      className="flex-1 min-w-0 py-[9px] px-2 flex items-center justify-center gap-[6px] text-[11.5px] font-extrabold text-ink-muted"
                    >
                      <MI name="delete_outline" size={16} className="flex-none" />
                      <span className="truncate">{tr('labels.delete')}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex-none px-3 py-[11px] border-t border-line bg-header safe-bottom">
        <button
          onClick={handlePrint}
          disabled={totalSelectedLabels === 0}
          className="w-full h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <MI name="print" size={20} />
          {totalSelectedLabels === 0
            ? tr('labels.printNone')
            : tr('labels.print', { count: totalSelectedLabels })}
        </button>
      </div>

      <Toast toast={toast} />
    </ScreenOverlay>
  );
}
