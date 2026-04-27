'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, XCircle, Loader2, Package, ChevronRight, Camera } from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import type { MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';

// ── GS1-128 barcode field extraction (mirrors bot/services/barcode_service.py) ──

function parseGS1Weight(barcode: string): number {
  const d = barcode.replace(/\D/g, '');
  if (d.length >= 31) return parseInt(d.slice(19, 25), 10) / 1000;
  if (d.length >= 25) {
    const w1 = parseInt(d.slice(13, 19), 10) / 1000;
    const w2 = parseInt(d.slice(12, 18), 10) / 1000;
    return w1 >= 5 && w1 <= 40 ? w1 : w2 >= 5 && w2 <= 40 ? w2 : 0;
  }
  return 0;
}

function parseGS1Sku(barcode: string): string {
  const d = barcode.replace(/\D/g, '');
  return d.length >= 13 ? d.slice(0, 13) : d || barcode;
}

function parseGS1Expiry(barcode: string): string {
  const d = barcode.replace(/\D/g, '');
  if (d.length >= 31) return d.slice(25, 31);
  if (d.length >= 25) return d.slice(19, 25);
  return '';
}

function formatExpiry(raw: string): string {
  if (!raw) return '';
  if (/^\d{6}$/.test(raw)) return `${raw.slice(0, 2)}/${raw.slice(2, 4)}/20${raw.slice(4, 6)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-');
    return `${d}/${m}/${y}`;
  }
  return raw;
}

// ── Type detection ──

type DetectedType = 'unknown' | 'single-uniform' | 'single-nonuniform' | 'mix';

function detectType(boxes: BoxScan[]): DetectedType {
  if (boxes.length < 2) return 'unknown';
  const skus = new Set(boxes.map((b) => b.sku).filter(Boolean));
  if (skus.size > 1) return 'mix';
  const weights = boxes.map((b) => b.weight).filter((w) => w > 0);
  if (weights.length < 2) return 'single-uniform';
  const range = Math.max(...weights) - Math.min(...weights);
  return range < 0.5 ? 'single-uniform' : 'single-nonuniform';
}

// ── Local box type extended with OCR state ──

type OcrStatus = 'idle' | 'processing' | 'done' | 'failed' | 'skipped';

interface BoxScan extends MultiPalletBoxScan {
  ocr_status: OcrStatus;
}

// ── Page state machine ──

type Phase = 'loading' | 'box_count' | 'scanning' | 'confirming' | 'pallet_done' | 'all_done' | 'error';

export default function PalletVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<MultiPalletSession | null>(null);
  const [currentPallet, setCurrentPallet] = useState(1);
  const [boxCountInput, setBoxCountInput] = useState('');
  const [confirmedBoxCount, setConfirmedBoxCount] = useState(0);
  const [scannedBoxes, setScannedBoxes] = useState<BoxScan[]>([]);
  const [detectedType, setDetectedType] = useState<DetectedType>('unknown');
  const [lpn, setLpn] = useState('');
  const [lpnUrl, setLpnUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const processedRef = useRef<Set<string>>(new Set());
  // Track per-card OCR file input refs
  const ocrInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());

  // ── Load session ──

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/multi-pallet-session?token=${token}`);
        if (!res.ok) {
          setError('Session not found or expired. Ask the manager to resend the link.');
          setPhase('error');
          return;
        }
        const data: MultiPalletSession = await res.json();
        if (data.status === 'completed') {
          setPhase('all_done');
          setSession(data);
          return;
        }
        setSession(data);
        setCurrentPallet(data.current_pallet);
        if (data.current_box_count && data.current_box_count > 0) {
          setConfirmedBoxCount(data.current_box_count);
          setBoxCountInput(String(data.current_box_count));
          setPhase('scanning');
        } else {
          setPhase('box_count');
        }
      } catch {
        setError('Failed to load session.');
        setPhase('error');
      }
    }
    load();
  }, [token]);

  // ── Barcode detected ──

  const handleBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode) => {
      const barcode = _barcode.trim();
      if (processedRef.current.has(barcode)) return;
      processedRef.current.add(barcode);

      const weight = parseGS1Weight(barcode);
      const expiry = parseGS1Expiry(barcode);
      const sku = parseGS1Sku(barcode);

      const box: BoxScan = {
        barcode,
        sku,
        item_name: '',
        item_name_hebrew: '',
        weight,
        expiry,
        scanned_at: new Date().toISOString(),
        ocr_status: 'idle',
      };

      setScannedBoxes((prev) => {
        const updated = [...prev, box];
        setDetectedType(detectType(updated));
        return updated;
      });
    },
    []
  );

  // ── Sticker OCR per card ──

  function handleStickerFile(capturedIndex: number, file: File) {
    setScannedBoxes((prev) =>
      prev.map((b, i) => (i === capturedIndex ? { ...b, ocr_status: 'processing' } : b))
    );

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target?.result as string;
      const barcode = scannedBoxes[capturedIndex]?.barcode;
      try {
        const res = await fetch('/api/multi-pallet-ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64, barcode }),
        });
        const data = await res.json();

        setScannedBoxes((prev) =>
          prev.map((b, i) => {
            if (i !== capturedIndex) return b;
            if (data.success && data.ocr_data) {
              return {
                ...b,
                ocr_status: 'done' as OcrStatus,
                item_name: data.ocr_data.product_name_english || b.item_name,
                item_name_hebrew: data.ocr_data.product_name_hebrew || b.item_name_hebrew,
                weight:
                  data.ocr_data.weight_kg != null && data.ocr_data.weight_kg > 0
                    ? data.ocr_data.weight_kg
                    : b.weight,
                expiry: data.ocr_data.expiry_date || b.expiry,
              };
            }
            return { ...b, ocr_status: 'failed' as OcrStatus };
          })
        );
      } catch {
        setScannedBoxes((prev) =>
          prev.map((b, i) => (i === capturedIndex ? { ...b, ocr_status: 'failed' } : b))
        );
      }
    };
    reader.readAsDataURL(file);
  }

  // ── Box count submitted ──

  function handleBoxCountSubmit() {
    const count = parseInt(boxCountInput, 10);
    if (isNaN(count) || count < 1) {
      setError('Please enter a valid number of boxes (minimum 1).');
      return;
    }
    setError(null);
    setConfirmedBoxCount(count);
    setScannedBoxes([]);
    processedRef.current.clear();
    setDetectedType('unknown');
    setPhase('scanning');
    fetch('/api/multi-pallet-session', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, current_box_count: count }),
    }).catch(() => {});
  }

  // ── Confirm pallet ──

  async function handleConfirmPallet() {
    if (scannedBoxes.length < 2) return;
    setPhase('confirming');
    setError(null);

    try {
      const res = await fetch('/api/multi-pallet-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          // Strip ocr_status before sending — not part of the API contract
          scanned_boxes: scannedBoxes.map(({ ocr_status: _, ...box }) => box),
          box_count: confirmedBoxCount,
        }),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'Failed to complete pallet.');
        setPhase('scanning');
        return;
      }

      setLpn(data.lpn || '');
      setLpnUrl(data.lpn_url || '');

      if (data.all_done) {
        setPhase('all_done');
      } else {
        setPhase('pallet_done');
        fetch('/api/multi-pallet-session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, current_box_count: 0 }),
        }).catch(() => {});
        setTimeout(() => {
          setCurrentPallet(data.next_pallet);
          setBoxCountInput('');
          setConfirmedBoxCount(0);
          setScannedBoxes([]);
          processedRef.current.clear();
          ocrInputRefs.current.clear();
          setDetectedType('unknown');
          setPhase('box_count');
        }, 4000);
      }
    } catch {
      setError('Network error. Please try again.');
      setPhase('scanning');
    }
  }

  // ── Derived ──

  const pallet_count = session?.pallet_count || 1;
  const canConfirm = scannedBoxes.length >= 2;

  const groupedBySku = scannedBoxes.reduce<Record<string, BoxScan[]>>((acc, box) => {
    const key = box.sku || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(box);
    return acc;
  }, {});

  // ── Type badge ──

  function TypeBadge() {
    if (detectedType === 'unknown')
      return <span className="text-xs text-gray-400">Scan 2+ boxes to detect type</span>;
    if (detectedType === 'single-uniform')
      return (
        <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
          ✅ Single · uniform weight
        </span>
      );
    if (detectedType === 'single-nonuniform')
      return (
        <span className="text-xs bg-yellow-100 text-yellow-700 rounded-full px-2 py-0.5 font-medium">
          ⚖️ Single · scan all boxes
        </span>
      );
    return (
      <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
        📦 Mix · scan all boxes
      </span>
    );
  }

  // ── Box card ──

  function BoxCard({ box, idx }: { box: BoxScan; idx: number }) {
    const firstSku = scannedBoxes[0]?.sku;
    const skuMatch = box.sku === firstSku;
    const displayName = box.item_name_hebrew || box.item_name;

    const cardColor =
      idx === 0
        ? 'bg-blue-50 border-blue-200'
        : detectedType === 'mix' || skuMatch
        ? 'bg-green-50 border-green-200'
        : 'bg-yellow-50 border-yellow-200';

    return (
      <div className={`rounded-xl p-3 border text-sm ${cardColor}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {/* Weight — primary datum */}
            <div className="flex items-baseline gap-1.5">
              <span className="font-bold text-gray-900 text-base">
                {box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '— kg'}
              </span>
              {box.expiry && (
                <span className="text-xs text-gray-400">exp {formatExpiry(box.expiry)}</span>
              )}
            </div>

            {/* Item name from OCR */}
            {displayName ? (
              <p className="text-xs text-gray-700 mt-0.5 truncate">{displayName}</p>
            ) : box.ocr_status === 'processing' ? (
              <p className="text-xs text-blue-500 mt-0.5 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> reading label…
              </p>
            ) : box.ocr_status === 'failed' ? (
              <p className="text-xs text-red-400 mt-0.5">OCR failed</p>
            ) : null}
          </div>

          {/* Right: match indicator + OCR camera button */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            {idx === 0 ? (
              <span className="text-xs bg-blue-200 text-blue-800 rounded px-1.5 py-0.5">#1</span>
            ) : detectedType !== 'mix' && !skuMatch ? (
              <XCircle className="text-yellow-500 w-4 h-4" />
            ) : (
              <CheckCircle className="text-green-500 w-4 h-4" />
            )}

            {/* OCR trigger — only if no name yet and not currently processing */}
            {!displayName && box.ocr_status !== 'processing' && (
              <label className="flex items-center gap-0.5 text-xs text-blue-600 cursor-pointer hover:text-blue-700">
                <Camera className="w-3.5 h-3.5" />
                <span>label</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  ref={(el) => {
                    if (el) ocrInputRefs.current.set(idx, el);
                  }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleStickerFile(idx, file);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Screens ──

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
        <p className="text-gray-600">Loading session…</p>
      </div>
    );
  }

  if (phase === 'all_done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-green-50 text-center">
        <CheckCircle className="text-green-500 w-16 h-16 mb-4" />
        <h1 className="text-2xl font-bold text-green-700 mb-2">
          All {pallet_count} pallets complete!
        </h1>
        <p className="text-gray-600 mb-1">LPN sticker links have been sent via WhatsApp.</p>
        <p className="text-sm text-gray-500 mt-4">You can close this page.</p>
      </div>
    );
  }

  if (phase === 'pallet_done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-green-50 text-center">
        <CheckCircle className="text-green-500 w-14 h-14 mb-4" />
        <h1 className="text-xl font-bold text-green-700 mb-1">
          Pallet {currentPallet}/{pallet_count} done!
        </h1>
        <p className="text-gray-700 mb-1">
          LPN: <span className="font-mono font-bold">{lpn}</span>
        </p>
        {lpnUrl && (
          <a
            href={lpnUrl}
            className="mt-2 inline-block bg-green-600 text-white px-5 py-2 rounded-xl text-sm font-semibold hover:bg-green-700 transition"
          >
            View & Print Sticker →
          </a>
        )}
        <div className="mt-6 flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 className="animate-spin w-4 h-4" />
          <span>Moving to pallet {currentPallet + 1}…</span>
        </div>
      </div>
    );
  }

  if (phase === 'box_count') {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <div className="bg-white border-b px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <Package className="text-blue-600 w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-gray-800">
                Pallet {currentPallet} of {pallet_count}
              </p>
              <p className="text-xs text-gray-500">Doc: {session?.document_number || '—'}</p>
            </div>
          </div>
          <div className="flex gap-1 mt-2">
            {Array.from({ length: pallet_count }, (_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full ${
                  i + 1 < currentPallet
                    ? 'bg-green-500'
                    : i + 1 === currentPallet
                    ? 'bg-blue-500'
                    : 'bg-gray-200'
                }`}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-sm">
            <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
              📦 How many boxes?
            </h2>
            <p className="text-sm text-gray-500 text-center mb-6">
              Total boxes on pallet {currentPallet}.
            </p>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              value={boxCountInput}
              onChange={(e) => setBoxCountInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleBoxCountSubmit()}
              placeholder="e.g. 10"
              className="w-full text-center text-3xl font-bold border-2 border-gray-300 rounded-xl py-4 px-4 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            {error && <p className="text-red-500 text-sm text-center mt-2">{error}</p>}
            <button
              onClick={handleBoxCountSubmit}
              className="w-full mt-4 py-3 rounded-xl bg-blue-600 text-white font-semibold text-base hover:bg-blue-700 transition flex items-center justify-center gap-2"
            >
              Start Scanning <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // scanning / confirming
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="text-blue-600 w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-gray-800">
                Pallet {currentPallet}/{pallet_count} · {confirmedBoxCount} boxes
              </p>
              <p className="text-xs text-gray-500">Doc: {session?.document_number || '—'}</p>
            </div>
          </div>
          <TypeBadge />
        </div>

        {/* Scan progress bar */}
        <div className="mt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{scannedBoxes.length} scanned</span>
            <span className={canConfirm ? 'text-green-600 font-semibold' : 'text-gray-400'}>
              {canConfirm
                ? '✅ Ready to confirm'
                : `Scan ${2 - scannedBoxes.length} more to detect type`}
            </span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all rounded-full ${canConfirm ? 'bg-green-500' : 'bg-blue-400'}`}
              style={{
                width: `${Math.min(
                  (scannedBoxes.length / Math.max(confirmedBoxCount, 2)) * 100,
                  100
                )}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Scanner */}
      <div className="relative">
        <SmartScanner
          onBarcodeDetected={handleBarcodeDetected}
          scannedBarcodes={new Map()}
          ocrResults={new Map()}
        />
      </div>

      {/* Scanned boxes list */}
      {scannedBoxes.length > 0 && (
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          {detectedType === 'mix' ? (
            /* Mix: grouped by SKU */
            <div className="space-y-2">
              {Object.entries(groupedBySku).map(([sku, boxes]) => {
                const displayName =
                  boxes[0].item_name_hebrew || boxes[0].item_name || sku;
                const avgWeight =
                  boxes.filter((b) => b.weight > 0).length > 0
                    ? boxes.filter((b) => b.weight > 0).reduce((s, b) => s + b.weight, 0) /
                      boxes.filter((b) => b.weight > 0).length
                    : 0;
                return (
                  <div key={sku} className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-blue-800 truncate max-w-[70%]">
                        {displayName}
                      </span>
                      <span className="text-xs bg-blue-200 text-blue-800 rounded-full px-2 py-0.5 font-semibold shrink-0">
                        {boxes.length} box{boxes.length !== 1 ? 'es' : ''}
                      </span>
                    </div>
                    {avgWeight > 0 && (
                      <p className="text-xs text-gray-600">avg {avgWeight.toFixed(3)} kg/box</p>
                    )}
                    {/* Individual box sub-rows */}
                    <div className="space-y-1 pl-1">
                      {boxes.map((box, bi) => (
                        <div key={box.barcode + bi} className="flex items-center gap-1 text-xs text-gray-500">
                          <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                          {box.expiry && <span className="text-gray-400">· {formatExpiry(box.expiry)}</span>}
                          {!box.item_name_hebrew && box.ocr_status !== 'processing' && (
                            <label className="ml-auto flex items-center gap-0.5 text-blue-500 cursor-pointer">
                              <Camera className="w-3 h-3" />
                              <input
                                type="file"
                                accept="image/*"
                                capture="environment"
                                className="sr-only"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  const globalIdx = scannedBoxes.indexOf(box);
                                  if (file && globalIdx !== -1) handleStickerFile(globalIdx, file);
                                  e.target.value = '';
                                }}
                              />
                            </label>
                          )}
                          {box.ocr_status === 'processing' && (
                            <Loader2 className="ml-auto w-3 h-3 animate-spin text-blue-400" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-gray-400 text-center mt-1">
                {Object.keys(groupedBySku).length} item type
                {Object.keys(groupedBySku).length !== 1 ? 's' : ''} detected
              </p>
            </div>
          ) : (
            /* Single item */
            <div className="space-y-2">
              {scannedBoxes.map((box, idx) => (
                <BoxCard key={box.barcode + idx} box={box} idx={idx} />
              ))}
            </div>
          )}

          {canConfirm && (
            <p className="text-xs text-gray-400 text-center mt-3">
              Confirm now or keep scanning to add more boxes
            </p>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="p-4 bg-white border-t space-y-2 sticky bottom-0">
        {error && <p className="text-red-600 text-sm text-center">{error}</p>}

        {phase === 'confirming' ? (
          <div className="flex items-center justify-center gap-2 py-3">
            <Loader2 className="animate-spin w-5 h-5 text-blue-500" />
            <span className="text-sm text-gray-600">Saving pallet…</span>
          </div>
        ) : (
          <button
            onClick={handleConfirmPallet}
            disabled={!canConfirm}
            className={`w-full py-3 rounded-xl font-semibold text-base transition ${
              canConfirm
                ? 'bg-green-600 text-white hover:bg-green-700 active:bg-green-800'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {canConfirm
              ? `✅ Confirm Pallet ${currentPallet}`
              : `Scan ${Math.max(0, 2 - scannedBoxes.length)} more box${
                  2 - scannedBoxes.length === 1 ? '' : 'es'
                } to continue`}
          </button>
        )}
      </div>
    </div>
  );
}
