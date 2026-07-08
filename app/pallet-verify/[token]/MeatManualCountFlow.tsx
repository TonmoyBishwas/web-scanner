'use client';

/**
 * Meat damaged-sticker manual-count flow (ONE pallet).
 *
 * When box stickers are damaged/unreadable the worker can't scan every box.
 * This screen lists the invoice items and lets the worker type how many boxes
 * of each are on THIS pallet — no scanning required, so they never get stuck.
 * Counts default to 0 and cap at the invoice remaining (invoice box_count −
 * committed on earlier manual pallets, so an item split across pallets isn't
 * double-counted). On finish it POSTs a `manual_declared` payload; the parent
 * (pallet-verify/page.tsx) owns advancing to the next pallet, so this component
 * handles a single pallet and hands the result back via `onComplete`.
 *
 * Rendered by page.tsx in place of the scanner when the worker taps
 * "Stickers damaged — enter counts" (only offered when the session has the
 * meat-discrepancy feature enabled). The normal scanning path is untouched.
 */

import { useCallback, useMemo, useState } from 'react';
import { Check, Minus, Plus, AlertTriangle, Loader2, ArrowLeft } from 'lucide-react';
import { LanguageContext, t } from '@/lib/i18n';
import type { Language, MultiPalletSession } from '@/types';
import { nonMeatItemKey } from '@/lib/nonmeat-key';

/** Result shape returned by POST /api/multi-pallet-complete. */
export interface PalletCompleteResult {
  success?: boolean;
  lpn?: string;
  lpn_url?: string;
  pallet_number?: number;
  next_pallet?: number | null;
  all_done?: boolean;
  error?: string;
}

interface Row {
  item_key: string;
  name: string;
  invoice_boxes: number; // invoice box_count for the line (0 if absent)
  remaining: number; // invoice_boxes − committed (or a large cap when absent)
  capped: boolean; // whether `remaining` is a real invoice cap
  count: number;
}

export function MeatManualCountFlow({
  token,
  session,
  lang,
  onComplete,
  onCancel,
}: {
  token: string;
  session: MultiPalletSession;
  lang: Language;
  onComplete: (data: PalletCompleteResult, palletType: 'single' | 'mix', totalBoxes: number) => void;
  onCancel: () => void;
}) {
  const tr = useCallback(
    (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(lang, key, vars),
    [lang],
  );

  const initialRows: Row[] = useMemo(() => {
    const committed = session.meat_committed || {};
    return (session.ocr_data || []).map((line) => {
      const key = nonMeatItemKey(line);
      const invoice = Math.max(0, Math.floor(Number(line.box_count) || 0));
      const done = committed[key] || 0;
      const remaining = invoice > 0 ? Math.max(0, invoice - done) : Number.MAX_SAFE_INTEGER;
      const name =
        (lang === 'Hebrew' ? line.item_name_hebrew : line.item_name_english) ||
        line.item_name_english ||
        line.item_name_hebrew ||
        line.item_code ||
        '—';
      return { item_key: key, name, invoice_boxes: invoice, remaining, capped: invoice > 0, count: 0 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [rows, setRows] = useState<Row[]>(initialRows);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCount = useCallback((key: string, value: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.item_key === key
          ? { ...r, count: Math.max(0, Math.min(r.remaining, Math.floor(value || 0))) }
          : r,
      ),
    );
  }, []);

  const totalBoxes = rows.reduce((s, r) => s + r.count, 0);
  const withCounts = rows.filter((r) => r.count > 0);
  const canFinish = withCounts.length > 0 && !saving;

  const finish = useCallback(async () => {
    if (withCounts.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/multi-pallet-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          manual_declared: true,
          manual_items: withCounts.map((r) => ({ item_key: r.item_key, box_count: r.count })),
        }),
      });
      const data: PalletCompleteResult = await res.json();
      if (!data.success) {
        setError(data.error || tr('meatManual.failed'));
        setSaving(false);
        return;
      }
      onComplete(data, withCounts.length > 1 ? 'mix' : 'single', totalBoxes);
    } catch {
      setError(tr('meatManual.failed'));
      setSaving(false);
    }
  }, [withCounts, token, tr, onComplete, totalBoxes]);

  return (
    <LanguageContext.Provider value={lang}>
      <div className="min-h-screen bg-canvas text-ink flex flex-col">
        <div className="px-4 pt-4">
          <button
            onClick={onCancel}
            className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink-body mb-2"
          >
            <ArrowLeft className="w-4 h-4" /> {tr('meatManual.cancel')}
          </button>
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-warn" />
            <h1 className="text-lg font-bold">{tr('meatManual.title')}</h1>
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            {tr('meatManual.pallet', { current: session.current_pallet, total: session.pallet_count })}
            {session.document_number ? ` · ${session.document_number}` : ''}
          </div>
          <p className="mt-2 text-sm text-ink-body">{tr('meatManual.instruction')}</p>
        </div>

        {error && (
          <div className="mx-4 mt-3 bg-danger-weak border border-danger text-danger rounded-xl px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="px-4 py-3 space-y-2 flex-1">
          {rows.length === 0 && (
            <div className="text-sm text-ink-muted py-4">{tr('meatManual.noItems')}</div>
          )}
          {rows.map((r) => (
            <div key={r.item_key} className="bg-raised rounded-xl border border-line p-3">
              <div className="min-w-0">
                <div className="font-medium truncate">{r.name}</div>
                <div className="text-xs text-ink-muted">
                  {r.capped
                    ? `${tr('meatManual.invoiceBoxes', { count: r.invoice_boxes })} · ${tr('meatManual.remaining', { count: r.remaining })}`
                    : tr('meatManual.invoiceBoxes', { count: r.invoice_boxes })}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => setCount(r.item_key, r.count - 1)}
                  disabled={r.count <= 0}
                  className="w-9 h-9 rounded-lg bg-sunken text-ink-body disabled:opacity-40 flex items-center justify-center"
                  aria-label="decrease"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={r.capped ? r.remaining : undefined}
                  value={r.count}
                  onChange={(e) => setCount(r.item_key, Number(e.target.value))}
                  className="w-20 text-center text-lg font-bold text-ink bg-sunken rounded-lg py-1.5 outline-none focus:ring-2 focus:ring-blue-300"
                />
                <button
                  onClick={() => setCount(r.item_key, r.count + 1)}
                  disabled={r.capped && r.count >= r.remaining}
                  className="w-9 h-9 rounded-lg bg-sunken text-ink-body disabled:opacity-40 flex items-center justify-center"
                  aria-label="increase"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 bg-raised border-t border-line px-4 py-3">
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="text-ink-muted">{tr('meatManual.totalBoxes', { count: totalBoxes })}</span>
          </div>
          {!canFinish && !saving && (
            <p className="text-xs text-ink-muted mb-2">{tr('meatManual.needCount')}</p>
          )}
          <button
            onClick={finish}
            disabled={!canFinish}
            className="w-full py-3.5 rounded-xl font-semibold text-base bg-ok text-ink-inverse disabled:bg-sunken disabled:text-ink-muted inline-flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
            {tr('meatManual.finish', { current: session.current_pallet })}
          </button>
        </div>
      </div>
    </LanguageContext.Provider>
  );
}
