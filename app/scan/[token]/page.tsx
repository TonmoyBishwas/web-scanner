'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { IssueResolution } from '@/components/progress/IssueResolution';
import type {
  ParsedBarcode,
  BoxStickerOCR,
  ScanSession,
  ScanEntry,
  InvoiceItem,
  OCRIssue,
  ManualEntryData,
} from '@/types';

// Phase enum for flow control
type ScanPhase =
  | 'loading'          // Fetching session
  | 'scanning'         // Active scanning
  | 'processing'       // Waiting for background OCR
  | 'issues'           // Resolving OCR issues
  | 'ready_confirm'    // All clear, ready to confirm
  | 'confirming'       // Submitting to backend
  | 'complete'         // Done
  | 'error';

export default function ScanPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  // Session state
  const [session, setSession] = useState<ScanSession | null>(null);
  const [phase, setPhase] = useState<ScanPhase>('loading');
  const [error, setError] = useState<string | null>(null);

  // Scan tracking
  const [scannedBarcodes, setScannedBarcodes] = useState<Map<string, ParsedBarcode>>(new Map());
  const [ocrResults, setOcrResults] = useState<Map<string, BoxStickerOCR>>(new Map());
  const [boxesScanned, setBoxesScanned] = useState(0);
  const [boxesExpected, setBoxesExpected] = useState(0);

  // OCR tracking
  const [pendingOCR, setPendingOCR] = useState<Set<string>>(new Set());
  const [ocrIssues, setOcrIssues] = useState<OCRIssue[]>([]);
  const [allIssuesResolved, setAllIssuesResolved] = useState(true);

  // Force confirm
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [manualEntries, setManualEntries] = useState<ManualEntryData[]>([]);

  // Error logging for mobile debugging
  const [errorLog, setErrorLog] = useState<Array<{ time: string, msg: string }>>([]);
  const [showErrorLog, setShowErrorLog] = useState(false);
  const addErrorLog = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setErrorLog(prev => [...prev, { time, msg }]);
    console.error(`[ERROR ${time}]`, msg);
  }, []);

  // Polling ref
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // ── Load Session ──────────────────────────────────────────────
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`/api/session?token=${token}`);
        if (!res.ok) throw new Error('Session not found or expired');
        const sessionData: ScanSession = await res.json();
        setSession(sessionData);

        // Calculate expected boxes
        const totalExpected = sessionData.invoice_items.reduce(
          (sum: number, item: InvoiceItem) => sum + (item.expected_boxes || 0),
          0
        );
        setBoxesExpected(totalExpected);
        setBoxesScanned(sessionData.scanned_barcodes?.length || 0);

        // Load existing scanned barcodes
        if (sessionData.scanned_barcodes) {
          const barcodeMap = new Map<string, ParsedBarcode>();
          sessionData.scanned_barcodes.forEach((entry: ScanEntry) => {
            barcodeMap.set(entry.barcode, {
              type: 'id-only',
              sku: entry.barcode,
              weight: 0,
              expiry: '',
              raw_barcode: entry.barcode,
              expiry_source: 'ocr_required',
            });
          });
          setScannedBarcodes(barcodeMap);
        }

        setPhase('scanning');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session');
        setPhase('error');
      }
    }
    fetchSession();
  }, [token]);

  // ── Upload Image to Cloudinary ────────────────────────────────
  const uploadToCloudinary = useCallback(async (imageData: string): Promise<{ url: string, publicId: string } | null> => {
    try {
      const res = await fetch('/api/gdrive/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageData,
          barcode: `capture_${Date.now()}`,
          document_number: session?.document_number,
        })
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Upload failed (${res.status}): ${errorText}`);
      }
      const data = await res.json();
      return { url: data.secure_url, publicId: data.public_id };
    } catch (err) {
      const msg = `Cloudinary upload error: ${err instanceof Error ? err.message : String(err)}`;
      addErrorLog(msg);
      return null;
    }
  }, [addErrorLog]);

  // ── Trigger Background OCR ───────────────────────────────────
  const triggerOCR = useCallback(async (barcode: string, imageUrl: string) => {
    setPendingOCR(prev => new Set(prev).add(barcode));

    try {
      await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          barcode,
          image_url: imageUrl,
        })
      });
    } catch (err) {
      console.error('OCR trigger error:', err);
    }
  }, [token]);

  // ── Poll for OCR Results ─────────────────────────────────────
  const pollForResults = useCallback(async () => {
    if (pendingOCR.size === 0) return;

    try {
      const res = await fetch(`/api/session?token=${token}`);
      if (!res.ok) return;
      const updatedSession: ScanSession = await res.json();
      setSession(updatedSession);

      // Check which OCR calls are done
      const stillPending = new Set<string>();
      const newOcrResults = new Map(ocrResults);
      const issues: OCRIssue[] = [];

      updatedSession.scanned_barcodes.forEach((entry: ScanEntry) => {
        if (entry.ocr_status === 'pending') {
          stillPending.add(entry.barcode);
        } else if (entry.ocr_status === 'complete' && entry.ocr_data) {
          newOcrResults.set(entry.barcode, entry.ocr_data);

          // Check for issues
          if (!entry.ocr_data.product_name && !entry.ocr_data.weight_kg) {
            issues.push({
              barcode: entry.barcode,
              image_url: entry.image_url,
              type: 'missing_both',
              ocr_data: entry.ocr_data
            });
          } else if (!entry.ocr_data.product_name) {
            issues.push({
              barcode: entry.barcode,
              image_url: entry.image_url,
              type: 'missing_name',
              ocr_data: entry.ocr_data
            });
          } else if (!entry.ocr_data.weight_kg) {
            // Try smart weight inference
            const inferredWeight = inferWeight(entry, updatedSession);
            issues.push({
              barcode: entry.barcode,
              image_url: entry.image_url,
              type: 'missing_weight',
              inferred_weight: inferredWeight,
              ocr_data: entry.ocr_data
            });
          }
        } else if (entry.ocr_status === 'failed') {
          issues.push({
            barcode: entry.barcode,
            image_url: entry.image_url,
            type: 'missing_both',
          });
        }
      });

      setPendingOCR(stillPending);
      setOcrResults(newOcrResults);

      if (issues.length > 0) {
        setOcrIssues(issues);
        setAllIssuesResolved(false);
      }

      // If nothing pending and we have issues, go to issues phase
      if (stillPending.size === 0 && issues.length > 0) {
        setPhase('issues');
      } else if (stillPending.size === 0 && issues.length === 0) {
        // All done with no issues
        setPhase('ready_confirm');
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, [token, pendingOCR, ocrResults]);

  // Smart weight inference
  function inferWeight(entry: ScanEntry, session: ScanSession): number | undefined {
    if (!entry.ocr_data?.product_name) return undefined;

    // Find matching invoice item
    const matchedItem = session.invoice_items.find(
      i => i.item_name_hebrew === entry.ocr_data?.product_name
    );
    if (!matchedItem) return undefined;

    // Get all scanned entries for the same product with weights
    const sameProductEntries = session.scanned_barcodes.filter(
      e => e.ocr_data?.product_name === entry.ocr_data?.product_name &&
        e.ocr_data?.weight_kg && e.barcode !== entry.barcode
    );

    const scannedWeight = sameProductEntries.reduce(
      (sum, e) => sum + (e.ocr_data?.weight_kg || 0), 0
    );

    const remainingWeight = matchedItem.quantity_kg - scannedWeight;
    const remainingBoxes = matchedItem.expected_boxes - sameProductEntries.length - 1;

    if (remainingBoxes <= 0) return remainingWeight > 0 ? remainingWeight : undefined;
    return remainingWeight / (remainingBoxes + 1);
  }

  // ── Start/stop polling ────────────────────────────────────────
  useEffect(() => {
    if (pendingOCR.size > 0) {
      pollIntervalRef.current = setInterval(pollForResults, 3000);
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [pendingOCR.size, pollForResults]);

  // ── Barcode Detected Handler ─────────────────────────────────
  const handleBarcodeDetected = useCallback(async (
    barcode: string,
    data: ParsedBarcode,
    imageData?: string
  ) => {
    // Already scanned?
    if (scannedBarcodes.has(barcode)) return;

    // Add to scanned set immediately
    setScannedBarcodes(prev => new Map(prev).set(barcode, data));
    setBoxesScanned(prev => prev + 1);

    // Check if image was captured
    if (!imageData) {
      addErrorLog(`Barcode ${barcode}: No image captured by scanner`);
    } else {
      addErrorLog(`Barcode ${barcode}: Image captured (${Math.round(imageData.length / 1024)}KB)`);
    }

    // Upload image to Cloudinary
    let imageUrl = '';
    let publicId = '';
    if (imageData) {
      const upload = await uploadToCloudinary(imageData);
      if (upload) {
        imageUrl = upload.url;
        publicId = upload.publicId;
        addErrorLog(`Barcode ${barcode}: Uploaded to Cloudinary`);
      } else {
        addErrorLog(`Barcode ${barcode}: Cloudinary upload failed`);
      }
    }

    // Submit scan to API (deduplication + session update)
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          barcode,
          parsed_data: data,
          image_url: imageUrl,
          image_public_id: publicId,
          detected_at: new Date().toISOString(),
          scan_method: 'barcode'
        })
      });
      const result = await res.json();

      if (!result.success) {
        if (result.is_duplicate) {
          addErrorLog(`Barcode ${barcode}: Duplicate (ignored)`);
          return;
        }
        addErrorLog(`/api/scan failed: ${result.error}`);
        return;
      }

      addErrorLog(`Barcode ${barcode}: Saved to session`);

      // Trigger background OCR
      if (imageUrl) {
        triggerOCR(barcode, imageUrl);
        addErrorLog(`Barcode ${barcode}: OCR started`);
      } else {
        addErrorLog(`Barcode ${barcode}: No OCR (no image)`);
      }
    } catch (err) {
      addErrorLog(`/api/scan error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [scannedBarcodes, token, uploadToCloudinary, triggerOCR, addErrorLog]);

  // ── Manual Capture Handler ────────────────────────────────────
  const handleManualCapture = useCallback(async (imageData: string) => {
    const tempBarcode = `manual_${Date.now()}`;

    setBoxesScanned(prev => prev + 1);

    // Upload to Cloudinary
    const upload = await uploadToCloudinary(imageData);
    if (!upload) {
      console.error('Manual capture upload failed');
      return;
    }

    // Submit as a manual capture scan
    try {
      await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          barcode: tempBarcode,
          image_url: upload.url,
          image_public_id: upload.publicId,
          detected_at: new Date().toISOString(),
          scan_method: 'manual_capture'
        })
      });

      // Trigger OCR
      triggerOCR(tempBarcode, upload.url);
    } catch (err) {
      console.error('Manual capture error:', err);
    }
  }, [token, uploadToCloudinary, triggerOCR]);

  // ── Force Confirm (add remaining boxes manually) ─────────────
  const handleForceConfirmEntry = useCallback(async (entry: ManualEntryData) => {
    const tempBarcode = `force_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Upload photo if provided
    let imageUrl = '';
    let publicId = '';
    if (entry.image_url) {
      const upload = await uploadToCloudinary(entry.image_url);
      if (upload) {
        imageUrl = upload.url;
        publicId = upload.publicId;
      }
    }

    // Submit as force confirm entry
    try {
      await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          barcode: tempBarcode,
          image_url: imageUrl,
          image_public_id: publicId,
          detected_at: new Date().toISOString(),
          scan_method: 'force_confirm'
        })
      });

      setBoxesScanned(prev => prev + 1);
      setManualEntries(prev => [...prev, { ...entry, image_url: imageUrl }]);
    } catch (err) {
      console.error('Force confirm entry error:', err);
    }
  }, [token, uploadToCloudinary]);

  // ── Issue Resolution Handler ──────────────────────────────────
  const handleIssueResolve = useCallback(async (
    barcode: string,
    resolved: { item_name?: string; weight?: number; expiry?: string }
  ) => {
    // Update session data with resolved values
    try {
      await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          barcode,
          resolved_item_name: resolved.item_name,
          resolved_weight: resolved.weight,
          resolved_expiry: resolved.expiry,
        })
      });
    } catch (err) {
      console.error('Issue resolve error:', err);
    }
  }, [token]);

  // ── Final Confirm ─────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    setPhase('confirming');
    try {
      const res = await fetch('/api/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const result = await res.json();
      if (result.success) {
        setPhase('complete');
      } else {
        setError(result.error || 'Failed to complete scan');
        setPhase('error');
      }
    } catch (err) {
      setError('Network error during confirmation');
      setPhase('error');
    }
  }, [token]);

  // Check transition to processing
  const handleCheckProgress = useCallback(() => {
    if (boxesScanned >= boxesExpected && boxesExpected > 0) {
      if (pendingOCR.size > 0) {
        setPhase('processing');
      } else if (ocrIssues.length > 0 && !allIssuesResolved) {
        setPhase('issues');
      } else {
        setPhase('ready_confirm');
      }
    }
  }, [boxesScanned, boxesExpected, pendingOCR.size, ocrIssues.length, allIssuesResolved]);

  useEffect(() => {
    if (phase === 'scanning') handleCheckProgress();
  }, [boxesScanned, phase, handleCheckProgress]);

  // ── RENDER ────────────────────────────────────────────────────

  // Loading
  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-300">Loading scanner session...</p>
        </div>
      </div>
    );
  }

  // Error
  if (phase === 'error') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-red-900/30 border border-red-600 rounded-lg p-6 max-w-md text-center">
          <p className="text-2xl mb-2">❌</p>
          <p className="text-red-400 font-medium">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Complete
  if (phase === 'complete') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-green-900/30 border border-green-600 rounded-lg p-6 max-w-md text-center">
          <p className="text-4xl mb-3">✅</p>
          <h2 className="text-xl font-bold text-green-400 mb-2">Scan Complete!</h2>
          <p className="text-gray-300 text-sm mb-1">
            {boxesScanned} boxes scanned and submitted
          </p>
          <p className="text-gray-400 text-xs">
            Data has been sent to warehouse system. You can close this page.
          </p>
        </div>
      </div>
    );
  }

  // Processing (OCR in progress - full page loading)
  if (phase === 'processing') {
    const totalPending = pendingOCR.size;
    const totalScanned = boxesScanned;
    const completed = totalScanned - totalPending;

    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md text-center">
          <div className="animate-spin w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <h2 className="text-lg font-bold text-white mb-2">Processing OCR...</h2>
          <p className="text-gray-400 text-sm mb-3">
            Extracting data from box stickers via Gemini AI
          </p>
          <div className="bg-gray-900 rounded-full h-2 mb-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${totalScanned > 0 ? (completed / totalScanned) * 100 : 0}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-500">
            {completed} / {totalScanned} processed ({totalPending} remaining)
          </p>
        </div>
      </div>
    );
  }

  // Confirming
  if (phase === 'confirming') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-300">Submitting scan data...</p>
        </div>
      </div>
    );
  }

  // ── Main Scanner UI ───────────────────────────────────────────
  const isReadyToConfirm = phase === 'ready_confirm' ||
    (boxesScanned >= boxesExpected && pendingOCR.size === 0 && allIssuesResolved);

  const canForceConfirm = boxesScanned < boxesExpected && boxesScanned > 0;

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* ── Header: Box Counter ──────────────────────────────── */}
      <div className="sticky top-0 z-50 bg-gray-800/95 backdrop-blur border-b border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📦</span>
            <div>
              <h1 className="text-lg font-bold">
                <span className={boxesScanned >= boxesExpected ? 'text-green-400' : 'text-white'}>
                  {boxesScanned}
                </span>
                <span className="text-gray-500 mx-1">/</span>
                <span className="text-gray-400">{boxesExpected}</span>
                <span className="text-sm text-gray-500 ml-2">boxes</span>
              </h1>
              <p className="text-xs text-gray-500">
                {session?.document_number ? `Doc: ${session.document_number}` : 'Scanning...'}
              </p>
            </div>
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-2">
            {pendingOCR.size > 0 && (
              <span className="flex items-center gap-1 text-xs text-yellow-400">
                <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></div>
                OCR: {pendingOCR.size}
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-2 bg-gray-700 rounded-full h-1.5">
          <div
            className={`h-1.5 rounded-full transition-all duration-500 ${boxesScanned >= boxesExpected ? 'bg-green-500' : 'bg-blue-500'
              }`}
            style={{ width: `${boxesExpected > 0 ? Math.min(100, (boxesScanned / boxesExpected) * 100) : 0}%` }}
          ></div>
        </div>
      </div>

      {/* ── Scanner View ─────────────────────────────────────── */}
      {(phase === 'scanning' || phase === 'ready_confirm') && (
        <div className="flex-1">
          <SmartScanner
            onBarcodeDetected={handleBarcodeDetected}
            onManualCapture={handleManualCapture}
            scannedBarcodes={scannedBarcodes}
            ocrResults={ocrResults}
          />
        </div>
      )}

      {/* ── Issue Resolution Phase ────────────────────────────── */}
      {phase === 'issues' && session && (
        <div className="flex-1 p-4 overflow-y-auto">
          <IssueResolution
            issues={ocrIssues}
            invoiceItems={session.invoice_items}
            onResolve={handleIssueResolve}
            onAllResolved={() => {
              setAllIssuesResolved(true);
              setPhase('ready_confirm');
            }}
          />
        </div>
      )}

      {/* ── Footer: Action Buttons ────────────────────────────── */}
      <div className="sticky bottom-0 bg-gray-800/95 backdrop-blur border-t border-gray-700 p-4 space-y-2">
        {/* Force Confirm button */}
        {canForceConfirm && phase === 'scanning' && (
          <button
            onClick={() => setShowForceConfirm(true)}
            className="w-full py-3 bg-yellow-600 hover:bg-yellow-700 rounded-lg text-sm font-medium transition-colors"
          >
            ⚡ Force Confirm ({boxesExpected - boxesScanned} boxes remaining)
          </button>
        )}

        {/* Confirm button */}
        {isReadyToConfirm && (
          <button
            onClick={handleConfirm}
            className="w-full py-3 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-bold transition-colors"
          >
            ✓ Confirm All Scans
          </button>
        )}

        {/* Scanned barcodes summary */}
        {boxesScanned > 0 && phase === 'scanning' && (
          <p className="text-center text-xs text-gray-500">
            {boxesScanned} box{boxesScanned !== 1 ? 'es' : ''} scanned
            {pendingOCR.size > 0 ? ` • ${pendingOCR.size} OCR pending` : ''}
          </p>
        )}
      </div>

      {/* ── Error Log Panel (Mobile Debug) ──────────────────── */}
      {errorLog.length > 0 && (
        <div className="fixed bottom-20 right-4 z-50">
          {!showErrorLog ? (
            <button
              onClick={() => setShowErrorLog(true)}
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-full shadow-lg text-sm font-bold"
            >
              🐛 Debug Log ({errorLog.length})
            </button>
          ) : (
            <div className="bg-gray-900 border border-red-500 rounded-lg shadow-2xl w-80 max-h-96 flex flex-col">
              <div className="flex justify-between items-center p-3 border-b border-gray-700">
                <span className="text-white font-bold text-sm">🐛 Debug Log</span>
                <button
                  onClick={() => setShowErrorLog(false)}
                  className="text-gray-400 hover:text-white text-lg"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {errorLog.map((entry, i) => (
                  <div key={i} className="text-xs bg-black/50 p-2 rounded">
                    <span className="text-gray-500">{entry.time}</span>
                    <div className="text-yellow-300 mt-1">{entry.msg}</div>
                  </div>
                ))}
              </div>
              <div className="p-2 border-t border-gray-700">
                <button
                  onClick={() => {
                    const text = errorLog.map(e => `${e.time}: ${e.msg}`).join('\n');
                    navigator.clipboard.writeText(text);
                    alert('Log copied to clipboard!');
                  }}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs"
                >
                  Copy All
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Force Confirm Modal ───────────────────────────────── */}
      {showForceConfirm && session && (
        <ForceConfirmModal
          session={session}
          boxesScanned={boxesScanned}
          boxesExpected={boxesExpected}
          onAddEntry={handleForceConfirmEntry}
          onClose={() => {
            setShowForceConfirm(false);
            // After force confirm entries are added, check progress
            if (pendingOCR.size > 0) {
              setPhase('processing');
            } else {
              setPhase('ready_confirm');
            }
          }}
        />
      )}
    </div>
  );
}

// ── Force Confirm Modal ─────────────────────────────────────────
function ForceConfirmModal({
  session,
  boxesScanned,
  boxesExpected,
  onAddEntry,
  onClose,
}: {
  session: ScanSession;
  boxesScanned: number;
  boxesExpected: number;
  onAddEntry: (entry: ManualEntryData) => Promise<void>;
  onClose: () => void;
}) {
  const remaining = boxesExpected - boxesScanned;
  const [entries, setEntries] = useState<Array<{
    item_name: string;
    weight: string;
    expiry: string;
    submitted: boolean;
  }>>(
    Array.from({ length: remaining }, () => ({
      item_name: '',
      weight: '',
      expiry: '',
      submitted: false,
    }))
  );

  const [submitting, setSubmitting] = useState(false);

  const handleSubmitAll = async () => {
    setSubmitting(true);
    for (const entry of entries) {
      if (entry.submitted) continue;
      if (!entry.item_name || !entry.weight) continue;

      await onAddEntry({
        token: session.token,
        item_name: entry.item_name,
        weight: parseFloat(entry.weight),
        expiry: entry.expiry,
      });
    }
    setSubmitting(false);
    onClose();
  };

  const allFilled = entries.every(e => e.item_name && e.weight);

  return (
    <div className="fixed inset-0 z-60 bg-black/80 flex items-end xl:items-center justify-center">
      <div className="bg-gray-800 w-full max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl xl:rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-yellow-400">
            ⚡ Manual Entry ({remaining} boxes)
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>

        <p className="text-xs text-gray-400">
          Enter details for the remaining {remaining} unscanned boxes.
        </p>

        {entries.map((entry, idx) => (
          <div key={idx} className="bg-gray-900 rounded-lg p-3 space-y-2">
            <p className="text-sm font-medium text-gray-300">Box #{boxesScanned + idx + 1}</p>

            <select
              value={entry.item_name}
              onChange={e => {
                const updated = [...entries];
                updated[idx].item_name = e.target.value;
                setEntries(updated);
              }}
              className="w-full p-2 bg-gray-800 border border-gray-700 rounded text-sm"
            >
              <option value="">Select item *</option>
              {session.invoice_items.map(item => (
                <option key={item.item_index} value={item.item_name_english}>
                  {item.item_name_english} ({item.quantity_kg} kg)
                </option>
              ))}
            </select>

            <input
              type="number"
              step="0.001"
              placeholder="Weight (kg) *"
              value={entry.weight}
              onChange={e => {
                const updated = [...entries];
                updated[idx].weight = e.target.value;
                setEntries(updated);
              }}
              className="w-full p-2 bg-gray-800 border border-gray-700 rounded text-sm"
            />

            <input
              type="date"
              placeholder="Expiry (optional)"
              value={entry.expiry}
              onChange={e => {
                const updated = [...entries];
                updated[idx].expiry = e.target.value;
                setEntries(updated);
              }}
              className="w-full p-2 bg-gray-800 border border-gray-700 rounded text-sm"
            />
          </div>
        ))}

        <button
          onClick={handleSubmitAll}
          disabled={!allFilled || submitting}
          className="w-full py-3 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg text-sm font-bold transition-colors"
        >
          {submitting ? 'Submitting...' : `Submit ${remaining} Manual Entries`}
        </button>
      </div>
    </div>
  );
}
