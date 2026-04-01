'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Package, Loader2, RefreshCw, ScanLine } from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { normalizeString } from '@/lib/string-utils';
import type { MixItem, PalletBoxScan, PalletSession, ParsedBarcode } from '@/types';

/** Hebrew-first name comparison (same logic as pallet-ocr / pallet-complete). */
function namesMatchUI(
  nameA: string,
  hebrewA: string,
  nameB: string,
  hebrewB: string
): boolean {
  if (hebrewA && hebrewB) {
    const hA = normalizeString(hebrewA);
    const hB = normalizeString(hebrewB);
    return hA === hB || hA.includes(hB) || hB.includes(hA);
  }
  if (nameA && nameB) {
    const eA = normalizeString(nameA);
    const eB = normalizeString(nameB);
    return eA === eB || eA.includes(eB) || eB.includes(eA);
  }
  return true;
}

/** Strip Hebrew niqqud (vowel points U+05B0–U+05C7). */
function stripNiqqud(s: string): string {
  return s.replace(/[\u05B0-\u05C7]/g, '');
}

/** Extract significant Hebrew words (≥4 base letters), splitting on any
 *  non-Hebrew character (hyphens, dots, spaces, punctuation, etc.). */
function hebrewWords(s: string): Set<string> {
  return new Set(stripNiqqud(s).split(/[^\u05D0-\u05EA]+/).filter((w) => w.length >= 4));
}

/** True if any significant Hebrew word from a appears in b, or vice versa. */
function hebrewWordsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  const wA = hebrewWords(a);
  const wB = hebrewWords(b);
  return [...wA].some((w) => wB.has(w)) || [...wB].some((w) => wA.has(w));
}

/** Assign a scanned box to a mix item index.
 *  Manual assignments (worker tap) are checked first; name matching is the fallback. */
function assignBoxToMixItem(box: PalletBoxScan, mixItems: MixItem[], manualAssignments?: Map<string, number>): number {
  // Pass 0: explicit manual assignment by worker
  if (manualAssignments?.has(box.barcode)) return manualAssignments.get(box.barcode)!;

  const normHeb = (s: string) => normalizeString(stripNiqqud(s));

  // Pass 1: Hebrew full-string match (niqqud-stripped)
  if (box.item_name_hebrew) {
    const hA = normHeb(box.item_name_hebrew);
    for (let i = 0; i < mixItems.length; i++) {
      if (mixItems[i].item_name_hebrew) {
        const hB = normHeb(mixItems[i].item_name_hebrew);
        if (hA && hB && (hA === hB || hA.includes(hB) || hB.includes(hA))) return i;
      }
    }
  }
  // Pass 2: Hebrew word-level match
  if (box.item_name_hebrew) {
    for (let i = 0; i < mixItems.length; i++) {
      if (mixItems[i].item_name_hebrew &&
          hebrewWordsOverlap(box.item_name_hebrew, mixItems[i].item_name_hebrew)) return i;
    }
  }
  // Pass 3: English name fallback
  if (box.item_name) {
    const eA = normalizeString(box.item_name);
    for (let i = 0; i < mixItems.length; i++) {
      if (mixItems[i].item_name_english) {
        const eB = normalizeString(mixItems[i].item_name_english);
        if (eA && eB && (eA === eB || eA.includes(eB) || eB.includes(eA))) return i;
      }
    }
  }
  return -1;
}

type VerifyPhase =
  | 'loading'
  | 'scanning'
  | 'generating'
  | 'done'
  | 'error';

type OcrStatus = 'pending' | 'done' | 'failed';

export default function PalletVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [phase, setPhase] = useState<VerifyPhase>('loading');
  const [session, setSession] = useState<PalletSession | null>(null);
  const [scannedBoxes, setScannedBoxes] = useState<PalletBoxScan[]>([]);
  const [unified, setUnified] = useState(true);
  const [mismatches, setMismatches] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lpn, setLpn] = useState<string>('');
  const [lpnUrl, setLpnUrl] = useState<string>('');

  // Track OCR status per barcode: 'pending' | 'done' | 'failed'
  const [ocrStatus, setOcrStatus] = useState<Map<string, OcrStatus>>(new Map());
  // Local image data for thumbnail display (base64 from scanner)
  const [imageDataMap, setImageDataMap] = useState<Map<string, string>>(new Map());
  // Manual entry form values for failed-OCR boxes { item_name, weight, expiry }
  const [manualEdits, setManualEdits] = useState<Map<string, { item_name: string; item_name_hebrew?: string; weight: string; expiry: string; selected_item_index?: number }>>(new Map());
  const [savingBarcode, setSavingBarcode] = useState<string | null>(null);
  // Manual box→item assignments made by worker tapping "Assign to item →"
  const [manualAssignments, setManualAssignments] = useState<Map<string, number>>(new Map());
  // Which unassigned box is currently showing the item picker
  const [assigningBarcode, setAssigningBarcode] = useState<string | null>(null);

  // Track processed barcodes locally for fast dedup
  const processedRef = useRef<Set<string>>(new Set());
  // Store imageData per barcode so we can retry OCR without re-scanning
  const imageDataRef = useRef<Map<string, string>>(new Map());

  // Load session on mount
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`/api/pallet-session?token=${token}`);
        if (!res.ok) {
          setError('Session not found or expired. Please ask the manager to resend the link.');
          setPhase('error');
          return;
        }
        const data: PalletSession = await res.json();
        setSession(data);
        setScannedBoxes(data.scanned_boxes || []);
        if (data.manual_assignments) {
          setManualAssignments(new Map(Object.entries(data.manual_assignments).map(([k, v]) => [k, v as number])));
        }
        // Populate local dedup set
        (data.scanned_boxes || []).forEach((b) => processedRef.current.add(b.barcode));
        setPhase('scanning');
      } catch (err) {
        console.error('[pallet-verify] fetch session error:', err);
        setError('Failed to load session.');
        setPhase('error');
      }
    }
    fetchSession();
  }, [token]);

  const initManualEdit = useCallback((barcode: string, partial: Partial<PalletBoxScan>) => {
    setManualEdits((prev) => {
      if (prev.has(barcode)) return prev; // don't overwrite if already editing
      return new Map(prev).set(barcode, {
        item_name: partial.item_name || '',
        weight: partial.weight && partial.weight > 0 ? String(partial.weight) : '',
        expiry: partial.expiry || '',
      });
    });
  }, []);

  const runOcr = useCallback(
    async (barcode: string, imageData: string) => {
      setOcrStatus((prev) => new Map(prev).set(barcode, 'pending'));
      try {
        const ocrRes = await fetch('/api/pallet-ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, barcode, image: imageData }),
        });
        const ocrData = await ocrRes.json();
        if (ocrData.success && ocrData.scan_result) {
          const result = ocrData.scan_result as PalletBoxScan;
          setScannedBoxes((prev) =>
            prev.map((b) => (b.barcode === barcode ? result : b))
          );
          setUnified(ocrData.unified ?? true);
          setMismatches(ocrData.mismatches || []);
          const weightOk = result.weight > 0;
          setOcrStatus((prev) =>
            new Map(prev).set(barcode, weightOk ? 'done' : 'failed')
          );
          if (!weightOk) {
            initManualEdit(barcode, result);
          } else {
            // Clear manual edit form if OCR succeeded on retry
            setManualEdits((prev) => { const n = new Map(prev); n.delete(barcode); return n; });
          }
        } else {
          setOcrStatus((prev) => new Map(prev).set(barcode, 'failed'));
          initManualEdit(barcode, {});
        }
      } catch (err) {
        console.warn('[pallet-verify] OCR failed:', err);
        setOcrStatus((prev) => new Map(prev).set(barcode, 'failed'));
        initManualEdit(barcode, {});
      }
    },
    [token, initManualEdit]
  );

  const handleAssign = useCallback(async (barcode: string, mixItemIndex: number) => {
    // Optimistic update — move box out of Unassigned immediately
    setManualAssignments((prev) => new Map(prev).set(barcode, mixItemIndex));
    setAssigningBarcode(null);
    try {
      await fetch('/api/pallet-assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, barcode, mix_item_index: mixItemIndex }),
      });
    } catch (err) {
      console.warn('[pallet-verify] Failed to persist manual assignment:', err);
    }
  }, [token]);

  const selectMixItemForEdit = useCallback((barcode: string, itemIndex: number, mi: MixItem) => {
    setManualEdits((prev) => new Map(prev).set(barcode, {
      ...(prev.get(barcode) ?? { weight: '', expiry: '' }),
      item_name: mi.item_name_english || mi.item_name_hebrew || '',
      item_name_hebrew: mi.item_name_hebrew || '',
      selected_item_index: itemIndex,
    }));
  }, []);

  const clearMixItemSelection = useCallback((barcode: string) => {
    setManualEdits((prev) => {
      const existing = prev.get(barcode);
      if (!existing) return prev;
      const { selected_item_index: _idx, item_name: _n, item_name_hebrew: _nh, ...rest } = existing;
      return new Map(prev).set(barcode, { ...rest, item_name: '', item_name_hebrew: '' });
    });
  }, []);

  const handleBarcodeDetected = useCallback(
    async (rawBarcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const barcode = rawBarcode.trim();
      if (processedRef.current.has(barcode)) return;
      processedRef.current.add(barcode);

      // Store imageData for retry and thumbnail display
      if (imageData) {
        imageDataRef.current.set(barcode, imageData);
        setImageDataMap((prev) => new Map(prev).set(barcode, imageData));
      }

      try {
        // 1. Record scan immediately — scanner stays live for the next box
        const scanRes = await fetch('/api/pallet-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, barcode, image_url: '' }),
        });

        const scanData = await scanRes.json();

        if (scanData.success) {
          setScannedBoxes((prev) => [...prev, scanData.scan_result as PalletBoxScan]);
        } else if (!scanData.is_duplicate) {
          console.error('[pallet-verify] scan error:', scanData.error);
        }
      } catch (err) {
        console.error('[pallet-verify] scan submit error:', err);
      }

      // 2. OCR runs in the background — does NOT block scanning the next box.
      if (imageData) {
        runOcr(barcode, imageData);
      } else {
        // No image — mark immediately as failed so user knows
        setOcrStatus((prev) => new Map(prev).set(barcode, 'failed'));
      }
    },
    [token, runOcr]
  );

  const handleRetryOcr = useCallback(
    (barcode: string) => {
      const imageData = imageDataRef.current.get(barcode);
      if (imageData) {
        runOcr(barcode, imageData);
      }
    },
    [runOcr]
  );

  // Re-scan: remove from dedup set so the always-on scanner accepts it again
  const handleRescan = useCallback((barcode: string) => {
    processedRef.current.delete(barcode);
    setOcrStatus((prev) => { const n = new Map(prev); n.delete(barcode); return n; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleManualSave = useCallback(async (barcode: string) => {
    const edits = manualEdits.get(barcode);
    if (!edits) return;
    setSavingBarcode(barcode);
    try {
      const res = await fetch('/api/pallet-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          barcode,
          item_name: edits.item_name,
          weight: parseFloat(edits.weight),
          expiry: edits.expiry,
        }),
      });
      const data = await res.json();
      if (data.success && data.scan_result) {
        setScannedBoxes((prev) => prev.map((b) => b.barcode === barcode ? data.scan_result as PalletBoxScan : b));
        setOcrStatus((prev) => new Map(prev).set(barcode, 'done'));
        // If worker selected a mix item, persist the assignment so routing is definitive
        if (edits.selected_item_index !== undefined) {
          handleAssign(barcode, edits.selected_item_index);
        }
        setManualEdits((prev) => { const n = new Map(prev); n.delete(barcode); return n; });
      } else {
        setError(data.error || 'Failed to save manual entry.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSavingBarcode(null);
    }
  }, [token, manualEdits, handleAssign]);

  const handleGenerateLPN = useCallback(async () => {
    setPhase('generating');
    try {
      const res = await fetch('/api/pallet-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.success) {
        setLpn(data.lpn || '');
        setLpnUrl(data.lpn_url || '');
        setPhase('done');
      } else {
        setError(data.error || 'Failed to generate LPN.');
        setPhase('scanning');
      }
    } catch (err) {
      console.error('[pallet-verify] complete error:', err);
      setError('Network error. Please try again.');
      setPhase('scanning');
    }
  }, [token]);

  const hasPendingOcr = scannedBoxes.some((b) => ocrStatus.get(b.barcode) === 'pending');
  // Only block completion if weight could not be extracted (image upload failure is non-blocking)
  const hasFailedOcr = scannedBoxes.some(
    (b) => ocrStatus.get(b.barcode) === 'failed'
  );

  const isMix = session?.pallet_type === 'mix' && (session?.mix_items?.length ?? 0) > 0;

  let canComplete = false;
  let mixReadinessLabel = '';

  if (isMix && session?.mix_items) {
    const mixItems = session.mix_items;
    const groups = mixItems.map((mi, i) => ({
      mi,
      boxes: scannedBoxes.filter((b) => assignBoxToMixItem(b, mixItems, manualAssignments) === i && b.weight > 0),
    }));
    const allGroupsReady = groups.every((g) =>
      g.mi.uniform_weight ? g.boxes.length >= 2 : g.boxes.length >= g.mi.expected_box_count
    );
    canComplete = allGroupsReady && !hasPendingOcr && !hasFailedOcr;

    if (!allGroupsReady) {
      const pending = groups.filter((g) =>
        g.mi.uniform_weight ? g.boxes.length < 2 : g.boxes.length < g.mi.expected_box_count
      );
      mixReadinessLabel = pending
        .map((g) => {
          const name = g.mi.item_name_english || g.mi.item_name_hebrew || 'item';
          const need = g.mi.uniform_weight ? 2 : g.mi.expected_box_count;
          return `${name}: ${g.boxes.length}/${need}`;
        })
        .join(', ');
    }
  } else {
    canComplete = scannedBoxes.length >= 2 && !hasPendingOcr && !hasFailedOcr;
  }

  const getButtonLabel = () => {
    if (isMix) {
      if (mixReadinessLabel) return `Scan more boxes — ${mixReadinessLabel}`;
      if (hasPendingOcr) return '⏳ Waiting for OCR to complete...';
      if (hasFailedOcr) return '⚠️ Fix OCR errors before continuing';
      return '✅ Generate LPN & Print Sticker';
    }
    if (scannedBoxes.length < 2) {
      return `Scan ${Math.max(0, 2 - scannedBoxes.length)} more box${
        2 - scannedBoxes.length === 1 ? '' : 'es'
      } to continue`;
    }
    if (hasPendingOcr) return '⏳ Waiting for OCR to complete...';
    if (hasFailedOcr) return '⚠️ Fix OCR errors before continuing';
    return '✅ Generate LPN & Print Sticker';
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50">
        <XCircle className="text-red-500 w-12 h-12 mb-4" />
        <p className="text-lg font-semibold text-red-700 text-center">{error}</p>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50">
        <Loader2 className="animate-spin text-blue-500 w-10 h-10 mb-4" />
        <p className="text-gray-600">Loading pallet session...</p>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-green-50 text-center">
        <CheckCircle className="text-green-500 w-14 h-14 mb-4" />
        <h1 className="text-2xl font-bold text-green-700 mb-2">Pallet Verified!</h1>
        <p className="text-gray-700 mb-4">
          LPN: <span className="font-mono font-bold text-lg">{lpn}</span>
        </p>
        {lpnUrl && (
          <a
            href={lpnUrl}
            className="bg-green-600 text-white px-6 py-3 rounded-xl font-semibold text-base hover:bg-green-700 transition"
          >
            View & Print Sticker →
          </a>
        )}
        <p className="text-sm text-gray-500 mt-4">You can now close this tab.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Package className="text-blue-600 w-5 h-5" />
          <div>
            <p className="text-sm font-bold text-gray-800">
              Pallet {session?.pallet_number} of {session?.pallet_count}
            </p>
            <p className="text-xs text-gray-500">
              Doc: {session?.invoice_document_number || '—'} · Scale: {session?.scale_weight} kg ·{' '}
              {session?.expected_box_count} boxes
            </p>
          </div>
        </div>

        {/* Progress */}
        <div className="mt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Scanned: {scannedBoxes.length} boxes</span>
            <span className={canComplete ? 'text-green-600 font-semibold' : 'text-gray-400'}>
              {canComplete ? '✅ Ready to generate LPN' : isMix ? 'Scan per item below' : `Need ${Math.max(0, 2 - scannedBoxes.length)} more`}
            </span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all rounded-full ${
                canComplete ? 'bg-green-500' : 'bg-blue-400'
              }`}
              style={{ width: isMix ? (canComplete ? '100%' : '50%') : `${Math.min((scannedBoxes.length / 2) * 100, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Scanner — always active until pallet is completed */}
      {phase === 'scanning' && (
        <div className="relative">
          <SmartScanner
            onBarcodeDetected={handleBarcodeDetected}
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
          />
        </div>
      )}

      {/* Scanned Boxes List */}
      {scannedBoxes.length > 0 && (
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          {/* Mismatch warning */}
          {mismatches.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-3 mb-3 flex gap-2 items-start">
              <AlertTriangle className="text-yellow-500 w-5 h-5 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-yellow-800">Boxes don&apos;t fully match</p>
                <p className="text-xs text-yellow-700 mt-1">
                  Mismatches: {mismatches.join(', ')}.{' '}
                  {isMix ? 'Check boxes are in the right group.' : 'This may not be a single-item pallet.'}
                </p>
              </div>
            </div>
          )}

          {/* ── Shared box card renderer ───────────────────────────────── */}
          {(() => {
            const renderBoxCard = (
              box: PalletBoxScan,
              badge?: React.ReactNode,
              extraWeightClass?: string,
            ) => {
              const status = ocrStatus.get(box.barcode);
              const isPending = status === 'pending';
              const isFailed = status === 'failed';
              const canRetry = isFailed && imageDataRef.current.has(box.barcode);
              const thumbSrc = imageDataMap.get(box.barcode) || box.image_url || null;
              const edits = manualEdits.get(box.barcode);
              const isSaving = savingBarcode === box.barcode;

              let cardClass = 'bg-green-50 border-green-200';
              if (isPending) cardClass = 'bg-gray-50 border-gray-200';
              else if (isFailed) cardClass = 'bg-orange-50 border-orange-300';
              else if (badge === 'reference') cardClass = 'bg-blue-50 border-blue-200';

              return (
                <div key={box.barcode} className={`rounded-xl p-3 border text-sm ${cardClass}`}>
                  {/* Top row: barcode + status icon */}
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-xs text-gray-500 truncate max-w-[55%]">{box.barcode}</span>
                    <div className="flex items-center gap-1.5">
                      {badge === 'reference' && (
                        <span className="text-xs bg-blue-200 text-blue-800 rounded px-2 py-0.5 font-medium">Reference</span>
                      )}
                      {isPending && <Loader2 className="animate-spin text-gray-400 w-4 h-4" />}
                      {!isPending && isFailed && <AlertTriangle className="text-orange-500 w-4 h-4" />}
                      {!isPending && !isFailed && badge !== 'reference' && (
                        extraWeightClass
                          ? <XCircle className="text-red-500 w-4 h-4" />
                          : <CheckCircle className="text-green-500 w-4 h-4" />
                      )}
                    </div>
                  </div>

                  {/* Image thumbnail + OCR data side by side */}
                  <div className="flex gap-2 mt-1">
                    {thumbSrc && (
                      <img
                        src={thumbSrc}
                        alt="box label"
                        className="w-20 h-20 object-cover rounded-lg border border-gray-200 flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      {isPending && <p className="text-xs text-gray-400 italic mt-1">Reading box label...</p>}
                      {!isPending && !isFailed && (
                        <>
                          {box.item_name && <p className="text-gray-800 font-semibold truncate">{box.item_name}</p>}
                          <div className="flex gap-3 text-gray-500 text-xs mt-1 flex-wrap">
                            {box.weight > 0 && (
                              <span className={extraWeightClass || ''}>⚖️ {box.weight} kg</span>
                            )}
                            {box.expiry && <span>📅 {box.expiry}</span>}
                          </div>
                        </>
                      )}
                      {isFailed && (
                        <p className="text-xs text-orange-700 font-medium mt-1">
                          ⚠️ OCR failed — enter details below or re-scan
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Manual entry form — only for failed OCR */}
                  {isFailed && edits !== undefined && (
                    <div className="mt-3 border-t border-orange-200 pt-3">
                      {/* Mix pallet: Step 1 — pick which item this box belongs to */}
                      {isMix && edits.selected_item_index === undefined ? (
                        <div className="space-y-2">
                          <p className="text-xs font-semibold text-gray-700 mb-1">Which item is this box?</p>
                          {session!.mix_items!.map((mi, i) => (
                            <button
                              key={i}
                              onClick={() => selectMixItemForEdit(box.barcode, i, mi)}
                              className="w-full text-left text-sm bg-white border border-orange-200 rounded-lg px-3 py-2 text-gray-800 font-medium active:bg-orange-50"
                            >
                              {mi.item_name_english || mi.item_name_hebrew}
                            </button>
                          ))}
                          <div className="flex gap-2 pt-1">
                            <button
                              onClick={() => handleRescan(box.barcode)}
                              className="flex items-center gap-1 text-xs text-blue-700 font-semibold bg-blue-100 rounded-lg px-3 py-1.5"
                            >
                              <ScanLine className="w-3 h-3" /> Re-scan
                            </button>
                            {canRetry && (
                              <button
                                onClick={() => handleRetryOcr(box.barcode)}
                                className="flex items-center gap-1 text-xs text-orange-700 font-semibold bg-orange-100 rounded-lg px-3 py-1.5"
                              >
                                <RefreshCw className="w-3 h-3" /> Retry OCR
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        /* Step 2 (mix) or direct form (single): weight + expiry */
                        <div className="space-y-2">
                          {/* Show resolved item name as a label */}
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-gray-700 truncate">
                              📦 {isMix
                                ? edits.item_name
                                : (session?.ocr_data?.[0]?.item_name_english || box.item_name || 'Unknown item')}
                            </p>
                            {isMix && (
                              <button
                                onClick={() => clearMixItemSelection(box.barcode)}
                                className="text-xs text-blue-500 flex-shrink-0 ml-2"
                              >
                                Change
                              </button>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="number"
                              placeholder="Weight (kg)"
                              value={edits.weight}
                              onChange={(e) => setManualEdits((prev) => new Map(prev).set(box.barcode, { ...edits, weight: e.target.value }))}
                              className="flex-1 text-sm text-gray-900 bg-white border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                              step="0.1"
                              min="0"
                            />
                            <input
                              type="text"
                              placeholder="Expiry (YYYY-MM-DD)"
                              value={edits.expiry}
                              onChange={(e) => setManualEdits((prev) => new Map(prev).set(box.barcode, { ...edits, expiry: e.target.value }))}
                              className="flex-1 text-sm text-gray-900 bg-white border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleManualSave(box.barcode)}
                              disabled={isSaving || !edits.weight || parseFloat(edits.weight) <= 0}
                              className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-green-600 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-lg px-3 py-1.5 transition"
                            >
                              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : '✓ Save'}
                            </button>
                            <button
                              onClick={() => handleRescan(box.barcode)}
                              className="flex items-center gap-1 text-xs text-blue-700 font-semibold bg-blue-100 rounded-lg px-3 py-1.5"
                            >
                              <ScanLine className="w-3 h-3" /> Re-scan
                            </button>
                            {canRetry && (
                              <button
                                onClick={() => handleRetryOcr(box.barcode)}
                                className="flex items-center gap-1 text-xs text-orange-700 font-semibold bg-orange-100 rounded-lg px-3 py-1.5"
                              >
                                <RefreshCw className="w-3 h-3" /> Retry
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            };

            if (isMix && session?.mix_items) {
              // ── Mix pallet: grouped by item ──────────────────────────────
              return (
                <div className="space-y-4">
                  {session.mix_items.map((mi, groupIdx) => {
                    const groupBoxes = scannedBoxes.filter(
                      (b) => assignBoxToMixItem(b, session.mix_items!, manualAssignments) === groupIdx
                    );
                    const readyBoxes = groupBoxes.filter((b) => b.weight > 0);
                    const required = mi.uniform_weight ? 2 : mi.expected_box_count;
                    const groupDone = readyBoxes.length >= required;
                    const itemLabel = mi.item_name_english || mi.item_name_hebrew || `Item ${groupIdx + 1}`;
                    return (
                      <div key={groupIdx}>
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-sm font-semibold text-gray-700 truncate max-w-[70%]">{itemLabel}</p>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${groupDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                            {readyBoxes.length}/{required} {groupDone ? '✓' : 'needed'}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mb-2">
                          {mi.uniform_weight ? 'Same weight – 2 samples required' : 'Individual weights – scan all boxes'}
                        </p>
                        <div className="space-y-2">
                          {groupBoxes.map((box) => renderBoxCard(box))}
                          {groupBoxes.length === 0 && (
                            <p className="text-xs text-gray-400 italic pl-1">No boxes scanned yet</p>
                          )}
                        </div>
                        {mi.uniform_weight && readyBoxes.length >= 2 && (
                          <p className="text-xs text-blue-600 mt-1 pl-1">
                            ℹ️ {mi.expected_box_count - readyBoxes.length} more box{mi.expected_box_count - readyBoxes.length === 1 ? '' : 'es'} will be calculated from avg weight
                          </p>
                        )}
                      </div>
                    );
                  })}

                  {/* Unassigned boxes */}
                  {(() => {
                    const unassigned = scannedBoxes.filter(
                      (b) => assignBoxToMixItem(b, session.mix_items!, manualAssignments) === -1
                    );
                    if (unassigned.length === 0) return null;
                    return (
                      <div>
                        <p className="text-sm font-semibold text-orange-500 mb-1">Unassigned</p>
                        <p className="text-xs text-gray-400 mb-2">OCR could not identify item — tap to assign manually</p>
                        <div className="space-y-2">
                          {unassigned.map((box) => (
                            <div key={box.barcode}>
                              {renderBoxCard(box)}
                              {assigningBarcode === box.barcode ? (
                                <div className="mt-2 border border-blue-200 rounded-xl p-3 bg-blue-50 space-y-2">
                                  <p className="text-xs font-semibold text-gray-600">Assign to:</p>
                                  {session.mix_items!.map((mi, i) => (
                                    <button
                                      key={i}
                                      onClick={() => handleAssign(box.barcode, i)}
                                      className="w-full text-left text-sm bg-white border border-blue-200 rounded-lg px-3 py-2 text-blue-800 active:bg-blue-100"
                                    >
                                      {mi.item_name_english || mi.item_name_hebrew}
                                    </button>
                                  ))}
                                  <button
                                    onClick={() => setAssigningBarcode(null)}
                                    className="w-full text-xs text-gray-400 py-1"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setAssigningBarcode(box.barcode)}
                                  className="w-full mt-1 text-xs text-blue-600 border border-blue-200 rounded-xl py-2 bg-blue-50 active:bg-blue-100"
                                >
                                  Assign to item →
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            }

            // ── Single-item pallet: flat list ─────────────────────────────
            const firstBox = scannedBoxes[0];
            return (
              <>
                <h2 className="text-sm font-semibold text-gray-600 mb-2">Scanned Boxes</h2>
                <div className="space-y-2">
                  {scannedBoxes.map((box, idx) => {
                    const isFirst = idx === 0;
                    const weightOk = !box.weight || !firstBox.weight ||
                      (firstBox.weight > 0 && Math.abs(box.weight - firstBox.weight) / firstBox.weight <= 0.05);
                    const nameMatch = !box.item_name || !firstBox.item_name ||
                      namesMatchUI(firstBox.item_name, firstBox.item_name_hebrew || '', box.item_name, box.item_name_hebrew || '');
                    return renderBoxCard(
                      box,
                      isFirst ? 'reference' : undefined,
                      !isFirst && (!nameMatch || !weightOk) ? 'text-orange-600 font-semibold' : undefined,
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
      )}


      {/* Footer Actions */}
      <div className="p-4 bg-white border-t space-y-2 sticky bottom-0">
        {error && (
          <p className="text-red-600 text-sm text-center mb-2">{error}</p>
        )}

        {phase === 'generating' ? (
          <div className="flex items-center justify-center gap-2 py-3">
            <Loader2 className="animate-spin w-5 h-5 text-blue-500" />
            <span className="text-sm text-gray-600">Generating LPN...</span>
          </div>
        ) : (
          <button
            onClick={handleGenerateLPN}
            disabled={!canComplete}
            className={`w-full py-3 rounded-xl font-semibold text-base transition ${
              canComplete
                ? 'bg-green-600 text-white hover:bg-green-700 active:bg-green-800'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {getButtonLabel()}
          </button>
        )}

        {phase === 'scanning' && scannedBoxes.length > 0 && !canComplete && !hasPendingOcr && !hasFailedOcr && (
          <p className="text-center text-xs text-gray-500">
            Point camera at another box to keep scanning
          </p>
        )}
      </div>
    </div>
  );
}
