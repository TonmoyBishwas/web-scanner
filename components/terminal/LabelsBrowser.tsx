'use client';

/**
 * מדבקות — Labels.
 *
 * The print queue for the stickers minted by New carton: pick a label size,
 * select the batches to print, hand them to the browser's print dialog, and
 * see at a glance which have already been printed.
 *
 * Read/write is limited to the `carton_labels` ledger — printing a sticker
 * moves no stock. Selection is per batch (one New carton submission), which is
 * also how the client's design groups them ("×N").
 */

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { CartonSticker } from './CartonSticker';
import { Toast, useToast } from './Toast';
import { LanguageContext, useT } from '@/lib/i18n';
import type { CartonLabel, LabelSize } from '@/types';

type StatusFilter = 'all' | 'created' | 'printed';
type Scope = 'delivery' | 'all';

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
  /** Present on a receiving session; absent on an ISSUE session. */
  documentNumber?: string | null;
  onBack: () => void;
}

export function LabelsBrowser({ token, documentNumber, onBack }: LabelsBrowserProps) {
  const tr = useT();
  const language = useContext(LanguageContext);
  const { toast, showToast } = useToast();

  const [size, setSize] = useState<LabelSize>('10x15');
  // An ISSUE session has no delivery to scope to, so it opens on "all recent".
  const [scope, setScope] = useState<Scope>(documentNumber ? 'delivery' : 'all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [labels, setLabels] = useState<CartonLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<'labels.error' | 'labels.sessionExpired' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
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

  const batches = useMemo(() => groupBatches(labels), [labels]);
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

  function handlePrint() {
    const batchIds = batches.filter(b => selected.has(b.batch_id)).map(b => b.batch_id);
    if (!batchIds.length) return;

    // Opened synchronously inside the click — a window.open after an awaited
    // fetch is what pop-up blockers kill.
    const url =
      `/labels/print?token=${encodeURIComponent(token)}` +
      `&batches=${encodeURIComponent(batchIds.join(','))}` +
      `&size=${size}&lang=${encodeURIComponent(language)}`;
    const win = window.open(url, '_blank');
    if (!win) {
      showToast(tr('labels.printBlocked'), 'error', '#ef8a8a');
      return;
    }

    const printed = totalSelectedLabels;
    fetch('/api/carton-labels/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, batch_ids: batchIds, label_size: size }),
    })
      .then(r => r.json())
      .then(data => {
        if (data?.success) {
          showToast(tr('labels.printSent', { count: printed }), 'print');
          setSelected(new Set());
          void load();
        }
      })
      .catch(() => { /* the sheet is already open; the ledger just missed the flag */ });
  }

  async function handleDelete(batchId: string) {
    try {
      const res = await fetch(
        `/api/carton-labels?token=${encodeURIComponent(token)}&batch=${encodeURIComponent(batchId)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!data?.success) {
        showToast(tr('labels.deleteFailed'), 'error', '#ef8a8a');
        return;
      }
      showToast(tr('labels.deleted'), 'delete');
      setConfirmDelete(null);
      void load();
    } catch {
      showToast(tr('labels.deleteFailed'), 'error', '#ef8a8a');
    }
  }

  const chip = (active: boolean) =>
    `px-3 h-[32px] rounded-[9px] text-[11.5px] font-extrabold border ${
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
                onClick={() => setSize(s.id)}
                className={`flex-1 h-[34px] rounded-[8px] text-[12px] font-extrabold ${
                  size === s.id ? 'bg-brand text-white' : 'text-ink-muted'
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-[6px] overflow-x-auto no-scrollbar">
          {documentNumber ? (
            <>
              <button onClick={() => setScope('delivery')} className={chip(scope === 'delivery')}>
                {tr('labels.scopeDelivery')}
              </button>
              <button onClick={() => setScope('all')} className={chip(scope === 'all')}>
                {tr('labels.scopeAll')}
              </button>
              <span className="w-px bg-line flex-none my-1" />
            </>
          ) : null}
          <button onClick={() => setStatus('all')} className={chip(status === 'all')}>
            {tr('labels.filterAll')}
          </button>
          <button onClick={() => setStatus('created')} className={chip(status === 'created')}>
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
          <p className="text-[12px] font-bold text-ink-muted text-center mt-8 leading-[1.5]">
            {status === 'all' ? tr('labels.empty') : tr('labels.emptyFiltered')}
          </p>
        ) : (
          batches.map(batch => {
            const isSelected = selected.has(batch.batch_id);
            const printed = batch.printedCount === batch.count;
            const label = batch.sample;
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
                    <span className="flex items-center gap-[6px] mt-[5px]">
                      <span
                        className="px-[7px] py-[2px] rounded-[6px] text-[9.5px] font-extrabold"
                        style={
                          printed
                            ? { background: 'rgba(34,197,94,.16)', color: '#86efac' }
                            : { background: 'rgba(19,164,236,.18)', color: '#7cc9f2' }
                        }
                      >
                        {printed
                          ? batch.maxPrintCount > 1
                            ? tr('labels.printedTimes', { count: batch.maxPrintCount })
                            : tr('labels.statusPrinted')
                          : tr('labels.statusCreated')}
                      </span>
                      <span className="text-[10px] font-bold text-ink-muted" dir="ltr">
                        {label.serial}
                      </span>
                    </span>
                  </span>

                  <span className="flex-none text-[16px] font-black text-ink-inverse">×{batch.count}</span>
                </button>

                <div className="flex items-center border-t border-line">
                  {confirmDelete === batch.batch_id ? (
                    <>
                      <button
                        onClick={() => void handleDelete(batch.batch_id)}
                        className="flex-1 py-[9px] text-[11.5px] font-extrabold text-[#ef8a8a]"
                      >
                        {tr('labels.delete')}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="flex-1 py-[9px] text-[11.5px] font-extrabold text-ink-muted border-s border-line"
                      >
                        {tr('labels.clearSelection')}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(batch.batch_id)}
                      className="flex-1 py-[9px] flex items-center justify-center gap-[6px] text-[11.5px] font-extrabold text-ink-muted"
                    >
                      <MI name="delete_outline" size={16} />
                      {tr('labels.delete')}
                    </button>
                  )}
                </div>
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
