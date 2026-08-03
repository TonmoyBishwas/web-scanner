'use client';

/**
 * Type A (weight-based non-meat) pallet flow.
 *
 * Every box of a given item has the SAME weight and the invoice already prints
 * the per-carton weight and carton count, so scanning all boxes is pointless.
 * Instead the worker scans ONE box per item on each pallet; the total is
 * invoice unit-weight × per-pallet carton count. An item's cartons may split
 * across pallets, so the count pre-fills with the remaining (invoice total −
 * committed on earlier pallets). Finishing a pallet mints one NM-LPN.
 *
 * This is rendered by pallet-verify/page.tsx instead of the meat scanner when
 * `session.category === 'non_meat'`. The meat path is untouched.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Loader2,
  Scale,
  Trash2,
  Check,
  Printer,
  AlertTriangle,
  X,
  CheckCircle,
  Package,
} from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { LanguageContext, useLangDir, t } from '@/lib/i18n';
import type { Language, MultiPalletSession, ParsedBarcode } from '@/types';
import { matchInvoiceItem, type InvoiceItem } from '@/lib/invoice-match';
import { nonMeatItemKey } from '@/lib/nonmeat-key';
import { scanSuccessFeedback, scanDuplicateFeedback } from '@/lib/scan-feedback';

type Phase = 'scanning' | 'saving' | 'pallet_done' | 'all_done' | 'error';

/** Minimal shape shared by invoice `ocr_data` lines and `matchInvoiceItem`
 *  results — both have names + code; box_count/unit_weight are Type A extras. */
type NmLine = {
  item_code?: string;
  item_name_hebrew?: string;
  item_name_english?: string;
  quantity_kg?: number;
  box_count?: number;
  unit_weight_kg?: number;
};

/** One invoice item captured on the CURRENT pallet. */
interface Capture {
  item_key: string;
  item_code: string;
  name_he: string;
  name_en: string;
  unit_weight_kg: number;
  remaining: number; // invoice cartons − committed on earlier pallets (the max)
  count: number; // cartons of this item on THIS pallet
  sample_barcode: string;
  scanned_weight: number; // OCR'd weight of the sample box (soft cross-check)
}

/** A scanned box whose label OCR didn't confidently match an invoice line. */
interface PendingPick {
  sample_barcode: string;
  scanned_weight: number;
  he: string;
  en: string;
}

const CAPTURE_CACHE_PREFIX = 'nm-captures';
const WEIGHT_MISMATCH_RATIO = 0.1; // >10% off the invoice unit weight → soft warn

function cacheKey(token: string, pallet: number) {
  return `${CAPTURE_CACHE_PREFIX}:${token}:${pallet}`;
}
function saveCaptures(token: string, pallet: number, caps: Capture[]) {
  try {
    localStorage.setItem(cacheKey(token, pallet), JSON.stringify(caps));
  } catch {
    /* private mode / quota — best effort */
  }
}
function loadCaptures(token: string, pallet: number): Capture[] {
  try {
    const raw = localStorage.getItem(cacheKey(token, pallet));
    return raw ? (JSON.parse(raw) as Capture[]) : [];
  } catch {
    return [];
  }
}
function clearCaptures(token: string, pallet: number) {
  try {
    localStorage.removeItem(cacheKey(token, pallet));
  } catch {
    /* ignore */
  }
}

export function NonMeatTypeAFlow({
  token,
  initialSession,
}: {
  token: string;
  initialSession: MultiPalletSession;
}) {
  const lang: Language = initialSession.language === 'Hebrew' ? 'Hebrew' : 'English';
  const tr = useCallback(
    (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(lang, key, vars),
    [lang],
  );
  useLangDir(lang);

  const [session, setSession] = useState<MultiPalletSession>(initialSession);
  const [phase, setPhase] = useState<Phase>('scanning');
  const [captures, setCaptures] = useState<Capture[]>(() =>
    loadCaptures(token, initialSession.current_pallet),
  );
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLpn, setLastLpn] = useState<{ lpn: string; url: string } | null>(null);

  // Sample barcodes seen on this pallet (dedup re-scans of the same sticker).
  const processedRef = useRef<Set<string>>(new Set());
  const dupFlashRef = useRef<(() => void) | null>(null);
  // The invoice catalog, mirrored into a ref so the scan callback stays stable.
  const invoiceRef = useRef(initialSession.ocr_data || []);
  invoiceRef.current = session.ocr_data || [];

  const currentPallet = session.current_pallet;
  const palletCount = session.pallet_count;
  const invoiceItems = session.ocr_data || [];

  // Repopulate the dedup set from any restored captures on first mount.
  useEffect(() => {
    captures.forEach((c) => c.sample_barcode && processedRef.current.add(c.sample_barcode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the current pallet's captures so a refresh doesn't lose them.
  useEffect(() => {
    if (phase === 'scanning') saveCaptures(token, currentPallet, captures);
  }, [token, currentPallet, phase, captures]);

  const committedFor = useCallback(
    (key: string) => session.nonmeat_committed?.[key] ?? 0,
    [session.nonmeat_committed],
  );

  /** invoice cartons − committed on earlier pallets, for a given item key. */
  const remainingFor = useCallback(
    (key: string, invoiceBoxCount: number) => Math.max(0, invoiceBoxCount - committedFor(key)),
    [committedFor],
  );

  const addCapture = useCallback(
    (line: NmLine, pick: PendingPick) => {
      const key = nonMeatItemKey(line);
      if (captures.some((c) => c.item_key === key)) {
        dupFlashRef.current?.();
        scanDuplicateFeedback();
        return; // already on this pallet
      }
      const invoiceBox = line.box_count ?? 0;
      const remaining = remainingFor(key, invoiceBox);
      if (remaining <= 0) {
        dupFlashRef.current?.();
        scanDuplicateFeedback();
        return; // fully accounted for on earlier pallets
      }
      const unit =
        line.unit_weight_kg && line.unit_weight_kg > 0
          ? line.unit_weight_kg
          : invoiceBox > 0 && line.quantity_kg
            ? line.quantity_kg / invoiceBox
            : 0;
      setCaptures((prev) => [
        ...prev,
        {
          item_key: key,
          item_code: line.item_code || '',
          name_he: line.item_name_hebrew || '',
          name_en: line.item_name_english || '',
          unit_weight_kg: Math.round(unit * 1000) / 1000,
          remaining,
          count: remaining, // pre-fill: usually the whole item is on this pallet
          sample_barcode: pick.sample_barcode,
          scanned_weight: pick.scanned_weight,
        },
      ]);
    },
    [captures, remainingFor],
  );

  const runOcr = useCallback(
    (sampleBarcode: string, imageData: string) => {
      const candidates = invoiceRef.current.map((it) => ({
        name_hebrew: it.item_name_hebrew,
        name_english: it.item_name_english,
        code: it.item_code,
      }));
      setReading(true);
      fetch('/api/multi-pallet-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageData, barcode: sampleBarcode, candidates }),
      })
        .then((r) => r.json())
        .then((data) => {
          setReading(false);
          const he = data?.ocr_data?.product_name_hebrew || '';
          const en = data?.ocr_data?.product_name_english || '';
          const wt = data?.ocr_data?.weight_kg ?? 0;
          const match = matchInvoiceItem(he, en, invoiceRef.current as InvoiceItem[]);
          if (match) {
            addCapture(match, { sample_barcode: sampleBarcode, scanned_weight: wt, he, en });
          } else {
            // OCR read the label but it didn't match an invoice line — ask.
            setPendingPick({ sample_barcode: sampleBarcode, scanned_weight: wt, he, en });
          }
        })
        .catch(() => {
          setReading(false);
          setPendingPick({ sample_barcode: sampleBarcode, scanned_weight: 0, he: '', en: '' });
        });
    },
    [addCapture],
  );

  const handleBarcodeDetected = useCallback(
    (barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const bc = barcode.trim();
      if (processedRef.current.has(bc)) {
        scanDuplicateFeedback();
        return;
      }
      processedRef.current.add(bc);
      scanSuccessFeedback();
      if (imageData) {
        runOcr(bc, imageData);
      } else {
        // No frame to OCR — let the worker pick the item manually.
        setPendingPick({ sample_barcode: bc, scanned_weight: 0, he: '', en: '' });
      }
    },
    [runOcr],
  );

  const handleManualCapture = useCallback(
    (imageData: string) => {
      const provisional = `MANUAL-${currentPallet}-${processedRef.current.size}`;
      processedRef.current.add(provisional);
      scanSuccessFeedback();
      runOcr(provisional, imageData);
    },
    [currentPallet, runOcr],
  );

  const setCount = useCallback((key: string, value: number) => {
    setCaptures((prev) =>
      prev.map((c) =>
        c.item_key === key
          ? { ...c, count: Math.max(1, Math.min(c.remaining, Math.floor(value || 0))) }
          : c,
      ),
    );
  }, []);

  const removeCapture = useCallback((cap: Capture) => {
    processedRef.current.delete(cap.sample_barcode);
    setCaptures((prev) => prev.filter((c) => c.item_key !== cap.item_key));
  }, []);

  const cancelPick = useCallback(() => {
    if (pendingPick) processedRef.current.delete(pendingPick.sample_barcode);
    setPendingPick(null);
  }, [pendingPick]);

  const refetchSession = useCallback(async () => {
    const res = await fetch(`/api/multi-pallet-session?token=${token}`);
    if (res.ok) {
      const data: MultiPalletSession = await res.json();
      setSession(data);
      return data;
    }
    return null;
  }, [token]);

  const finishPallet = useCallback(async () => {
    if (!captures.length) return;
    setError(null);
    setPhase('saving');
    try {
      const res = await fetch('/api/multi-pallet-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          nonmeat_items: captures.map((c) => ({
            item_key: c.item_key,
            box_count: c.count,
            sample_barcode: c.sample_barcode,
          })),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || tr('palletVerify.failedComplete'));
        setPhase('scanning');
        return;
      }
      setLastLpn({ lpn: data.lpn, url: data.lpn_url });
      clearCaptures(token, currentPallet);
      if (data.all_done) {
        await refetchSession();
        setPhase('all_done');
      } else {
        setPhase('pallet_done');
      }
    } catch {
      setError(tr('palletVerify.networkError'));
      setPhase('scanning');
    }
  }, [captures, token, currentPallet, tr, refetchSession]);

  const goNextPallet = useCallback(async () => {
    await refetchSession();
    setCaptures([]);
    processedRef.current = new Set();
    setLastLpn(null);
    setPhase('scanning');
  }, [refetchSession]);

  // ── Render ──────────────────────────────────────────────────────────────

  const totalKg = captures.reduce((s, c) => s + c.unit_weight_kg * c.count, 0);
  const canFinish = captures.length > 0 && captures.every((c) => c.count >= 1);

  let body: ReactNode;

  if (phase === 'all_done') {
    body = (
      <div className="p-6 text-center space-y-4">
        <div className="w-20 h-20 rounded-full bg-ok-weak flex items-center justify-center mx-auto animate-donePop">
          <CheckCircle className="w-10 h-10 text-ok" />
        </div>
        <h1 className="text-xl font-extrabold text-ok-weak-ink">
          {tr('nonmeatTypeA.allDone', { count: palletCount })}
        </h1>
        <p className="text-sm text-ink-muted">{tr('nonmeatTypeA.allDoneHint')}</p>
        <div className="space-y-2 text-start">
          {(session.completed_pallets || []).map((p) => (
            <a
              key={p.lpn}
              href={`/pallet/${p.lpn}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between bg-raised rounded-[14px] px-4 py-3 border border-line hover:border-ok/50 transition"
            >
              <span className="font-mono text-sm font-bold text-ink" dir="ltr">{p.lpn}</span>
              <span className="inline-flex items-center gap-1 text-brand-weak-ink text-sm font-bold">
                <Printer className="w-4 h-4" /> {tr('nonmeatTypeA.viewSticker')}
              </span>
            </a>
          ))}
        </div>
      </div>
    );
  } else if (phase === 'pallet_done' && lastLpn) {
    body = (
      <div className="p-6 text-center space-y-4">
        <div className="w-20 h-20 rounded-full bg-ok-weak flex items-center justify-center mx-auto animate-donePop">
          <CheckCircle className="w-10 h-10 text-ok" />
        </div>
        <h1 className="text-xl font-extrabold text-ok-weak-ink">
          {tr('nonmeatTypeA.palletDone', { current: currentPallet, total: palletCount })}
        </h1>
        <p className="font-mono text-sm font-bold text-ink" dir="ltr">{tr('nonmeatTypeA.lpn', { lpn: lastLpn.lpn })}</p>
        <a
          href={lastLpn.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 bg-tile border border-line-strong rounded-xl px-4 py-3 font-bold text-ink"
        >
          <Printer className="w-4 h-4" /> {tr('nonmeatTypeA.viewSticker')}
        </a>
        <button
          onClick={goNextPallet}
          className="w-full bg-brand text-ink-inverse rounded-xl py-3.5 font-extrabold hover:bg-brand-hover transition"
        >
          {tr('nonmeatTypeA.nextPallet', { next: currentPallet + 1 })}
        </button>
      </div>
    );
  } else {
    // scanning / saving
    body = (
      <>
        <div className="px-4 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-extrabold text-ink">
                {tr('nonmeatTypeA.palletHeader', { current: currentPallet, total: palletCount })}
              </div>
              {session.document_number && (
                <div className="text-xs font-mono text-ink-muted" dir="ltr">
                  {tr('palletVerify.docPrefix', { doc: session.document_number })}
                </div>
              )}
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-bold bg-brand-weak text-brand-weak-ink rounded-full px-2.5 py-1">
              <Scale className="w-3.5 h-3.5" /> {tr('nonmeatTypeA.badge')}
            </span>
          </div>
          <p className="mt-2 text-sm text-ink-muted">{tr('nonmeatTypeA.instruction')}</p>
        </div>

        {/* Scanner */}
        <div className="relative mt-3">
          <SmartScanner
            key={`nm-scanner-${currentPallet}`}
            frame="corner"
            onBarcodeDetected={handleBarcodeDetected}
            onManualCapture={handleManualCapture}
            onDuplicateFlash={(fn) => {
              dupFlashRef.current = fn;
            }}
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
          />
          {(reading || phase === 'saving') && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              <div className="bg-raised border border-line rounded-xl px-4 py-3 flex items-center gap-2">
                <Loader2 className="animate-spin w-5 h-5 text-brand" />
                <span className="text-sm font-medium text-ink">
                  {phase === 'saving' ? tr('nonmeatTypeA.saving') : tr('palletVerify.readingLabel')}
                </span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-4 mt-3 bg-danger-weak border border-danger/40 text-danger-weak-ink rounded-xl px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {/* Captured items on this pallet */}
        <div className="px-4 py-3 space-y-2">
          <div className="eyebrow">
            {tr('nonmeatTypeA.capturedTitle')}
          </div>
          {captures.length === 0 && (
            <div className="text-sm text-ink-muted py-2">{tr('nonmeatTypeA.scanHint')}</div>
          )}
          {captures.map((c) => {
            const mismatch =
              c.unit_weight_kg > 0 &&
              c.scanned_weight > 0 &&
              Math.abs(c.scanned_weight - c.unit_weight_kg) / c.unit_weight_kg > WEIGHT_MISMATCH_RATIO;
            const subtotal = Math.round(c.unit_weight_kg * c.count * 1000) / 1000;
            return (
              <div key={c.item_key} className="bg-raised rounded-[14px] border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-ink truncate">{c.name_he || c.name_en || c.item_code}</div>
                    <div className="text-xs text-ink-muted">
                      {tr('nonmeatTypeA.perCarton', { weight: c.unit_weight_kg })} ·{' '}
                      {tr('nonmeatTypeA.remainingLeft', { count: c.remaining })}
                    </div>
                  </div>
                  <button
                    onClick={() => removeCapture(c)}
                    className="text-ink-muted hover:text-danger p-1"
                    aria-label={tr('nonmeatTypeA.remove')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-sm text-ink-muted">{tr('nonmeatTypeA.cartonsQ')}</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={c.remaining}
                    value={c.count}
                    onChange={(e) => setCount(c.item_key, Number(e.target.value))}
                    className="w-20 bg-sunken border border-line-strong rounded-lg px-2 py-1.5 text-center font-bold font-mono text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                  <span className="text-sm text-ink-muted">{tr('nonmeatTypeA.subtotal', { total: subtotal })}</span>
                </div>
                {mismatch && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-warn-weak-ink">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {tr('nonmeatTypeA.weightMismatch', {
                      scanned: c.scanned_weight,
                      invoice: c.unit_weight_kg,
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-header/95 backdrop-blur border-t border-line px-4 py-3 safe-bottom">
          {canFinish ? (
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="text-ink-muted">{tr('nonmeatTypeA.capturedTitle')}</span>
              <span className="font-bold font-mono text-ink" dir="ltr">{Math.round(totalKg * 1000) / 1000} {tr('common.kg')}</span>
            </div>
          ) : (
            <p className="text-xs text-ink-muted mb-2">{tr('nonmeatTypeA.needItem')}</p>
          )}
          <button
            onClick={finishPallet}
            disabled={!canFinish || phase === 'saving'}
            className="w-full bg-brand text-ink-inverse rounded-xl py-3.5 font-extrabold disabled:opacity-40 hover:bg-brand-hover transition inline-flex items-center justify-center gap-2"
          >
            <Check className="w-5 h-5" />
            {tr('nonmeatTypeA.finish', { current: currentPallet })}
          </button>
        </div>
      </>
    );
  }

  return (
    <LanguageContext.Provider value={lang}>
      <div className="min-h-screen bg-canvas text-ink flex flex-col">
        {body}

        {/* Item picker — shown when OCR didn't confidently match a line */}
        {pendingPick && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center">
            <div className="bg-raised border-t border-line sm:border w-full sm:max-w-md rounded-t-[20px] sm:rounded-2xl p-4 pt-2 space-y-3 shadow-[0_-18px_44px_rgba(0,0,0,0.72)]">
              <div className="w-9 h-1 rounded-full bg-line-strong mx-auto sm:hidden" />
              <div className="flex items-center justify-between">
                <h2 className="font-extrabold text-ink flex items-center gap-2">
                  <Package className="w-5 h-5 text-brand" /> {tr('nonmeatTypeA.pickTitle')}
                </h2>
                <button onClick={cancelPick} className="text-ink-muted p-1" aria-label={tr('common.cancel')}>
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-sm text-ink-muted">{tr('nonmeatTypeA.pickHint')}</p>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {invoiceItems.map((it) => {
                  const key = nonMeatItemKey(it);
                  const remaining = remainingFor(key, it.box_count ?? 0);
                  const onPallet = captures.some((c) => c.item_key === key);
                  const disabled = remaining <= 0 || onPallet;
                  return (
                    <button
                      key={key}
                      disabled={disabled}
                      onClick={() => {
                        addCapture(it, pendingPick);
                        setPendingPick(null);
                      }}
                      className="w-full text-start bg-tile border border-line-strong rounded-xl px-3 py-2.5 disabled:opacity-40 hover:bg-hover transition flex items-center justify-between"
                    >
                      <span className="min-w-0 truncate text-ink">
                        {it.item_name_hebrew || it.item_name_english || it.item_code}
                      </span>
                      <span className="text-xs text-ink-muted whitespace-nowrap ms-2">
                        {onPallet
                          ? tr('nonmeatTypeA.alreadyOnPallet')
                          : remaining <= 0
                            ? tr('nonmeatTypeA.itemDone')
                            : tr('nonmeatTypeA.remainingLeft', { count: remaining })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </LanguageContext.Provider>
  );
}
