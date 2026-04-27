'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, XCircle, Loader2, Package, ChevronRight } from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import type { MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';

// ── GS1-128 client-side weight parser (mirrors bot/services/barcode_service.py) ──

function parseGS1Weight(barcode: string): number {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length >= 31) {
    return parseInt(digits.slice(19, 25), 10) / 1000;
  }
  if (digits.length >= 25) {
    const w1 = parseInt(digits.slice(13, 19), 10) / 1000;
    const w2 = parseInt(digits.slice(12, 18), 10) / 1000;
    return w1 >= 5 && w1 <= 40 ? w1 : w2;
  }
  return 0;
}

function parseGS1Sku(barcode: string): string {
  const digits = barcode.replace(/\D/g, '');
  return digits.slice(0, 13) || barcode;
}

function parseGS1Expiry(barcode: string): string {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length >= 31) return digits.slice(25, 31);
  if (digits.length >= 25) return digits.slice(19, 25);
  return '';
}

// ── Type detection ──

type DetectedType = 'unknown' | 'single-uniform' | 'single-nonuniform' | 'mix';

function detectType(boxes: MultiPalletBoxScan[]): DetectedType {
  if (boxes.length < 2) return 'unknown';
  const skus = new Set(boxes.map((b) => b.sku).filter(Boolean));
  if (skus.size > 1) return 'mix';
  const weights = boxes.map((b) => b.weight).filter((w) => w > 0);
  if (weights.length < 2) return 'single-uniform';
  const range = Math.max(...weights) - Math.min(...weights);
  return range < 0.5 ? 'single-uniform' : 'single-nonuniform';
}

// ── Page state machine ──

type Phase =
  | 'loading'
  | 'box_count'     // ask how many boxes in this pallet
  | 'scanning'      // barcode scan UI active
  | 'processing'    // a single scan being processed
  | 'confirming'    // posting to multi-pallet-complete
  | 'pallet_done'   // one pallet done, showing LPN
  | 'all_done'      // all pallets complete
  | 'error';

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
  const [scannedBoxes, setScannedBoxes] = useState<MultiPalletBoxScan[]>([]);
  const [detectedType, setDetectedType] = useState<DetectedType>('unknown');
  const [lpn, setLpn] = useState('');
  const [lpnUrl, setLpnUrl] = useState('');
  const [allDone, setAllDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const processedRef = useRef<Set<string>>(new Set());

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
          setAllDone(true);
          setPhase('all_done');
          return;
        }
        setSession(data);
        setCurrentPallet(data.current_pallet);
        setPhase('box_count');
      } catch {
        setError('Failed to load session.');
        setPhase('error');
      }
    }
    load();
  }, [token]);

  // ── Resolve item name from OCR data by SKU ──

  function resolveItemName(sku: string): { en: string; he: string } {
    if (!session?.ocr_data) return { en: '', he: '' };
    const match = session.ocr_data.find(
      (item) => item.item_code === sku || sku.startsWith(item.item_code)
    );
    return { en: match?.item_name_english || '', he: match?.item_name_hebrew || '' };
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
  }

  // ── Barcode detected ──

  const handleBarcodeDetected = useCallback(
    (_barcode: string, parsed: ParsedBarcode) => {
      const barcode = _barcode;
      if (processedRef.current.has(barcode)) return;
      processedRef.current.add(barcode);
      setPhase('processing');

      const sku = parsed.sku || parseGS1Sku(barcode);
      const weight = parsed.weight || parseGS1Weight(barcode);
      const expiry = parseGS1Expiry(barcode);
      const { en, he } = resolveItemName(sku);

      const box: MultiPalletBoxScan = {
        barcode,
        sku,
        item_name: en,
        item_name_hebrew: he,
        weight,
        expiry,
        scanned_at: new Date().toISOString(),
      };

      setScannedBoxes((prev) => {
        const updated = [...prev, box];
        setDetectedType(detectType(updated));
        return updated;
      });

      setPhase('scanning');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session]
  );

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
          scanned_boxes: scannedBoxes,
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
        setAllDone(true);
        setPhase('all_done');
      } else {
        setPhase('pallet_done');
        // Auto-advance to next pallet after 4 seconds
        setTimeout(() => {
          setCurrentPallet(data.next_pallet);
          setBoxCountInput('');
          setScannedBoxes([]);
          processedRef.current.clear();
          setDetectedType('unknown');
          setPhase('box_count');
        }, 4000);
      }
    } catch {
      setError('Network error. Please try again.');
      setPhase('scanning');
    }
  }

  // ── Derived values ──

  const pallet_count = session?.pallet_count || 1;
  const canConfirm = scannedBoxes.length >= 2;

  // Group scanned boxes by SKU for mix display
  const groupedBySku = scannedBoxes.reduce<Record<string, MultiPalletBoxScan[]>>((acc, box) => {
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
          ✅ Single item · uniform weight
        </span>
      );
    if (detectedType === 'single-nonuniform')
      return (
        <span className="text-xs bg-yellow-100 text-yellow-700 rounded-full px-2 py-0.5 font-medium">
          ⚖️ Single item · scan all boxes
        </span>
      );
    return (
      <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
        📦 Mix pallet · scan all boxes
      </span>
    );
  }

  // ── Renders ──

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
        <p className="text-gray-600">Loading session...</p>
      </div>
    );
  }

  if (phase === 'all_done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-green-50 text-center">
        <CheckCircle className="text-green-500 w-16 h-16 mb-4" />
        <h1 className="text-2xl font-bold text-green-700 mb-2">All {pallet_count} pallets complete!</h1>
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
          <span>Moving to pallet {currentPallet + 1}...</span>
        </div>
      </div>
    );
  }

  if (phase === 'box_count') {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {/* Header */}
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
          {/* Overall progress pills */}
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

        {/* Box count input */}
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-sm">
            <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
              📦 How many boxes?
            </h2>
            <p className="text-sm text-gray-500 text-center mb-6">
              Enter the total number of boxes on pallet {currentPallet}.
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

  // scanning / processing / confirming phases
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

        {/* Scan progress */}
        <div className="mt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{scannedBoxes.length} scanned</span>
            <span className={canConfirm ? 'text-green-600 font-semibold' : 'text-gray-400'}>
              {canConfirm ? '✅ Ready to confirm' : `Need ${2 - scannedBoxes.length} more to detect type`}
            </span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all rounded-full ${canConfirm ? 'bg-green-500' : 'bg-blue-400'}`}
              style={{
                width: `${Math.min(
                  detectedType === 'single-uniform'
                    ? (scannedBoxes.length / confirmedBoxCount) * 100
                    : (scannedBoxes.length / Math.max(confirmedBoxCount, 2)) * 100,
                  100
                )}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Scanner */}
      {(phase === 'scanning' || phase === 'processing') && (
        <div className="relative">
          <SmartScanner
            onBarcodeDetected={handleBarcodeDetected}
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
            className="w-full"
          />
          {phase === 'processing' && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="bg-white rounded-xl px-4 py-3 flex items-center gap-2">
                <Loader2 className="animate-spin w-5 h-5 text-blue-500" />
                <span className="text-sm font-medium">Processing scan...</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scanned boxes */}
      {scannedBoxes.length > 0 && (
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          {detectedType === 'mix' ? (
            // Mix: grouped by SKU
            <div className="space-y-3">
              {Object.entries(groupedBySku).map(([sku, boxes]) => {
                const firstName = boxes[0].item_name || boxes[0].item_name_hebrew || sku;
                const weights = boxes.map((b) => b.weight).filter((w) => w > 0);
                const totalW = weights.reduce((a, b) => a + b, 0);
                return (
                  <div key={sku} className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                    <p className="text-sm font-semibold text-blue-800 truncate">{firstName}</p>
                    <p className="text-xs text-blue-600">
                      {boxes.length} boxes · {totalW > 0 ? `${Math.round(totalW * 100) / 100} kg total` : 'weight from sticker'}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            // Single: list of boxes
            <div className="space-y-2">
              {scannedBoxes.map((box, idx) => {
                const first = scannedBoxes[0];
                const skuMatch = !box.sku || !first.sku || box.sku === first.sku;
                const weightOk =
                  !box.weight ||
                  !first.weight ||
                  Math.abs(box.weight - first.weight) <= 0.5;

                return (
                  <div
                    key={box.barcode + idx}
                    className={`rounded-xl p-3 border text-sm ${
                      idx === 0
                        ? 'bg-blue-50 border-blue-200'
                        : skuMatch && weightOk
                        ? 'bg-green-50 border-green-200'
                        : 'bg-yellow-50 border-yellow-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-gray-500 truncate max-w-[55%]">
                        {box.barcode}
                      </span>
                      {idx === 0 ? (
                        <span className="text-xs bg-blue-200 text-blue-800 rounded px-2 py-0.5">
                          Reference
                        </span>
                      ) : skuMatch ? (
                        <CheckCircle className="text-green-500 w-4 h-4" />
                      ) : (
                        <XCircle className="text-red-500 w-4 h-4" />
                      )}
                    </div>
                    {box.item_name && (
                      <p className="text-gray-700 font-medium truncate mt-0.5">{box.item_name}</p>
                    )}
                    <div className="flex gap-3 text-gray-500 text-xs mt-1">
                      {box.weight > 0 && (
                        <span className={!weightOk && idx > 0 ? 'text-orange-600 font-semibold' : ''}>
                          ⚖️ {box.weight} kg
                        </span>
                      )}
                      {box.expiry && <span>📅 {box.expiry}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Uniform single: show box count confirmation */}
      {detectedType === 'single-uniform' && canConfirm && (
        <div className="px-4 py-2">
          <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-800">
            <p className="font-semibold">
              {scannedBoxes[0].item_name || scannedBoxes[0].sku} — uniform weight ~{scannedBoxes[0].weight} kg
            </p>
            <p className="text-xs mt-0.5">
              You declared {confirmedBoxCount} boxes total. Total ≈{' '}
              {Math.round(scannedBoxes[0].weight * confirmedBoxCount * 100) / 100} kg
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="p-4 bg-white border-t space-y-2 sticky bottom-0">
        {error && <p className="text-red-600 text-sm text-center">{error}</p>}

        {phase === 'confirming' ? (
          <div className="flex items-center justify-center gap-2 py-3">
            <Loader2 className="animate-spin w-5 h-5 text-blue-500" />
            <span className="text-sm text-gray-600">Saving pallet...</span>
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
