'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Package, Loader2, RefreshCw } from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import type { PalletBoxScan, PalletSession, ParsedBarcode } from '@/types';

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
          // Mark as failed if weight came back as 0 (OCR couldn't extract)
          setOcrStatus((prev) =>
            new Map(prev).set(barcode, result.weight > 0 ? 'done' : 'failed')
          );
        } else {
          setOcrStatus((prev) => new Map(prev).set(barcode, 'failed'));
        }
      } catch (err) {
        console.warn('[pallet-verify] OCR failed:', err);
        setOcrStatus((prev) => new Map(prev).set(barcode, 'failed'));
      }
    },
    [token]
  );

  const handleBarcodeDetected = useCallback(
    async (barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      if (processedRef.current.has(barcode)) return;
      processedRef.current.add(barcode);

      // Store imageData for potential retry
      if (imageData) {
        imageDataRef.current.set(barcode, imageData);
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

  // All conditions for generating LPN:
  // 1. At least 2 boxes scanned
  // 2. No OCR still pending
  // 3. All scanned boxes have weight > 0 (OCR succeeded)
  const hasPendingOcr = scannedBoxes.some((b) => ocrStatus.get(b.barcode) === 'pending');
  const hasFailedOcr = scannedBoxes.some(
    (b) => (ocrStatus.get(b.barcode) === 'failed') || (ocrStatus.has(b.barcode) && b.weight === 0)
  );
  const canComplete = scannedBoxes.length >= 2 && !hasPendingOcr && !hasFailedOcr;

  // Human-readable button label
  const getButtonLabel = () => {
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
            <span>Scanned: {scannedBoxes.length} verification boxes</span>
            <span className={canComplete ? 'text-green-600 font-semibold' : 'text-gray-400'}>
              {canComplete ? '✅ Ready to generate LPN' : `Need ${Math.max(0, 2 - scannedBoxes.length)} more`}
            </span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all rounded-full ${
                canComplete ? 'bg-green-500' : 'bg-blue-400'
              }`}
              style={{ width: `${Math.min((scannedBoxes.length / 2) * 100, 100)}%` }}
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
                <p className="text-sm font-semibold text-yellow-800">Boxes don't fully match</p>
                <p className="text-xs text-yellow-700 mt-1">
                  Mismatches: {mismatches.join(', ')}. This may not be a single-item pallet.
                </p>
              </div>
            </div>
          )}

          <h2 className="text-sm font-semibold text-gray-600 mb-2">Scanned Boxes</h2>
          <div className="space-y-2">
            {scannedBoxes.map((box, idx) => {
              const isFirst = idx === 0;
              const firstBox = scannedBoxes[0];
              const status = ocrStatus.get(box.barcode);
              const isPending = status === 'pending';
              const isFailed = status === 'failed' || (status === 'done' && box.weight === 0);
              const canRetry = isFailed && imageDataRef.current.has(box.barcode);

              // Compare item_name (not sku which may be empty) for visual mismatch
              const nameMatch =
                !box.item_name || !firstBox.item_name || box.item_name === firstBox.item_name;
              const weightOk =
                !box.weight ||
                !firstBox.weight ||
                Math.abs(box.weight - firstBox.weight) <= 0.5;

              let cardClass = 'bg-blue-50 border-blue-200';
              if (!isFirst) {
                if (isPending) cardClass = 'bg-gray-50 border-gray-200';
                else if (isFailed) cardClass = 'bg-orange-50 border-orange-300';
                else if (!nameMatch) cardClass = 'bg-red-50 border-red-200';
                else cardClass = 'bg-green-50 border-green-200';
              }

              return (
                <div
                  key={box.barcode}
                  className={`rounded-xl p-3 border text-sm ${cardClass}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-xs text-gray-500 truncate max-w-[60%]">
                      {box.barcode}
                    </span>
                    {isFirst ? (
                      <span className="text-xs bg-blue-200 text-blue-800 rounded px-2 py-0.5 font-medium">
                        Reference
                      </span>
                    ) : isPending ? (
                      <Loader2 className="animate-spin text-gray-400 w-4 h-4" />
                    ) : isFailed ? (
                      <AlertTriangle className="text-orange-500 w-4 h-4" />
                    ) : nameMatch ? (
                      <CheckCircle className="text-green-500 w-4 h-4" />
                    ) : (
                      <XCircle className="text-red-500 w-4 h-4" />
                    )}
                  </div>

                  {isPending && (
                    <p className="text-xs text-gray-400 italic">Reading box label...</p>
                  )}

                  {isFailed && (
                    <p className="text-xs text-orange-700 font-medium">
                      ⚠️ Could not read weight/name from label
                    </p>
                  )}

                  {box.item_name && (
                    <p className="text-gray-700 font-medium truncate">{box.item_name}</p>
                  )}
                  <div className="flex gap-4 text-gray-500 text-xs mt-1">
                    {box.weight > 0 && (
                      <span className={!weightOk && !isFirst ? 'text-orange-600 font-semibold' : ''}>
                        ⚖️ {box.weight} kg
                      </span>
                    )}
                    {box.expiry && <span>📅 {box.expiry}</span>}
                  </div>

                  {canRetry && (
                    <button
                      onClick={() => handleRetryOcr(box.barcode)}
                      className="mt-2 flex items-center gap-1 text-xs text-orange-700 font-semibold bg-orange-100 hover:bg-orange-200 rounded-lg px-3 py-1 transition"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Retry OCR
                    </button>
                  )}
                </div>
              );
            })}
          </div>
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
