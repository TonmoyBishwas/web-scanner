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
import { splitErrorKey } from '@/components/terminal/SplitJobScreen';

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
  workerChatId,
  onComplete,
  onCancel,
  onReleased,
}: {
  token: string;
  session: MultiPalletSession;
  lang: Language;
  /** Split jobs only: which worker is declaring this pallet's counts. Ignored
   *  server-side on a single-scanner session. Without it, a split-session
   *  submit through this (damaged-sticker) path 409s with no_claimed_pallet —
   *  same guard as the normal scan-every-box confirm. */
  workerChatId?: string;
  onComplete: (data: PalletCompleteResult, palletType: 'single' | 'mix', totalBoxes: number) => void;
  onCancel: () => void;
  /** Split jobs only: the manager released/reassigned this pallet while the
   *  worker was declaring counts (409 no_claimed_pallet — same guard the
   *  normal scan-every-box confirm hits). Nothing was written server-side;
   *  the parent owns discarding local state and returning to the job screen
   *  (it already has this exact handler for its own confirm path). Ignored
   *  on a single-scanner session — that guard can't fire there. */
  onReleased?: () => void;
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
          worker_chat_id: workerChatId,
        }),
      });
      const data: PalletCompleteResult = await res.json();

      if (res.status === 409 && data.error === 'no_claimed_pallet' && onReleased) {
        // Split jobs only: the manager released/reassigned this pallet while
        // we were counting. Nothing was written server-side — hand back to
        // the job screen via the parent's shared handler rather than
        // stranding the worker on this screen with now-orphaned counts.
        onReleased();
        return;
      }

      if (!data.success) {
        // A raw reason code (no_claimed_pallet with no onReleased wired, or
        // any other split-only code) must never reach the worker as literal
        // text — route it through the same translation table the job screen
        // and the normal scan-every-box confirm both use. splitErrorKey
        // always returns a translated key (falls back to a generic retry
        // message), never the raw string.
        setError(tr(splitErrorKey(data.error)));
        setSaving(false);
        return;
      }
      onComplete(data, withCounts.length > 1 ? 'mix' : 'single', totalBoxes);
    } catch {
      setError(tr('meatManual.failed'));
      setSaving(false);
    }
  }, [withCounts, token, tr, onComplete, totalBoxes, workerChatId, onReleased]);

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
            <h1 className="text-lg font-extrabold text-ink">{tr('meatManual.title')}</h1>
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            {tr('meatManual.pallet', { current: session.current_pallet, total: session.pallet_count })}
            {session.document_number ? ` · ${session.document_number}` : ''}
          </div>
          <p className="mt-2 text-sm text-ink-body">{tr('meatManual.instruction')}</p>
        </div>

        {error && (
          <div className="mx-4 mt-3 bg-danger-weak border border-danger/40 text-danger-weak-ink rounded-xl px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="px-4 py-3 space-y-2 flex-1">
          {rows.length === 0 && (
            <div className="text-sm text-ink-muted py-4">{tr('meatManual.noItems')}</div>
          )}
          {rows.map((r) => (
            <div key={r.item_key} className="bg-raised rounded-[14px] border border-line p-3">
              <div className="min-w-0">
                <div className="font-bold text-ink truncate">{r.name}</div>
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
                  className="w-11 h-11 rounded-xl bg-hover border border-line-strong text-ink disabled:opacity-40 flex items-center justify-center"
                  aria-label="decrease"
                >
                  <Minus className="w-5 h-5" />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={r.capped ? r.remaining : undefined}
                  value={r.count}
                  dir="ltr"
                  onChange={(e) => setCount(r.item_key, Number(e.target.value))}
                  className="w-20 text-center text-xl font-bold font-mono text-ink bg-sunken border border-line-strong rounded-xl py-2 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
                <button
                  onClick={() => setCount(r.item_key, r.count + 1)}
                  disabled={r.capped && r.count >= r.remaining}
                  className="w-11 h-11 rounded-xl bg-brand-weak border border-brand/40 text-brand-weak-ink disabled:opacity-40 flex items-center justify-center"
                  aria-label="increase"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 bg-header border-t border-line px-4 py-3 safe-bottom">
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="text-ink-muted">{tr('meatManual.totalBoxes', { count: totalBoxes })}</span>
          </div>
          {!canFinish && !saving && (
            <p className="text-xs text-ink-muted mb-2">{tr('meatManual.needCount')}</p>
          )}
          <button
            onClick={finish}
            disabled={!canFinish}
            className="w-full py-3.5 rounded-xl font-extrabold text-base bg-ok text-canvas disabled:bg-sunken disabled:text-ink-muted inline-flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
            {tr('meatManual.finish', { current: session.current_pallet })}
          </button>
        </div>
      </div>
    </LanguageContext.Provider>
  );
}
