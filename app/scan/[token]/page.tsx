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
  const [showDebugPanel, setShowDebugPanel] = useState(false);
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
      const res = await fetch('/api/cloudinary/upload', {
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
  }, [addErrorLog, session]);

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
    if (scannedBarcodes.has(barcode)) {
      // Vibrate if supported
      if ('vibrate' in navigator) {
        navigator.vibrate([200, 100, 200]); // Double vibration pattern
      }

      // Show warning toast
      addErrorLog(`⚠️ Barcode ${barcode}: DUPLICATE - Already scanned!`);

      // Play error sound if available
      try {
        const audio = new Audio('data:audio/wav;base64,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*/UPUAwOU6/p66xgGoY8kdfxxHkpBiiCzPPaiDoIFV910O6qWhYKRqLh7sRuJB4v4DDv1Yo2Bx9ruvDams8NDlOw6uutYBoHPJHX8cR4KQYogszy2ok6CBVddtDuqloVCkaj4e7EbiQfL+Ew79WKNQcfa7rw2prPDQ5TsOrrrF8aBzyS1/HDeCkGKYPN89qJOggUXnbQ7qpaFQpGpOHuxG4kHy/hMO/VijUHH2u78Nqazw0NU6/q66tgGgc8kdfxw3gpBimDzvLaiToIVF530O6pWhYKRqPh7sPuJB4v4TDv1I00Bh9ru/Dams8MDlOv6uurYBoGPJHX8cN4KQUpg87y2ok6CFRddtDuq1oWCkak4e7D7iQeL+Ew b9SNNAYfa7rw2pvODA9Tr+rrq2AaBjyR1vLDeCkFKYPP8tmJOghUXnfQ7qtZFQpGpOHuw+4kHy/gMe/UjTMGHmu68NqbzgwPU67q66tgGgY8kdbyw3kpBSiDzvLZiToIVF520e6rWhUKRqTh7sPuIx4u4THv1I00Bh5ru/Dam84MD1Ou6uurYBoGPJHW8sN5KQUpg87y2Yk6CFRdd9Huq1oVCkak4e7D7iMfL+Ex79SNMwYea7vv2pvODA5Tr+rrq2AaBjyR1vLDeSkFKYPO8tiJOghUXXbR7qtaFQpGpOHuw+4jHy/gMe/VjTMGH2u68Nqbzg wOU6/r66tfGgU8kdbyw3kpBSiDzvLYiToIVF120e6rWhULRqPh7sLuIx8v4DHv1Y0zBh9ru+/am84MDlOu6+uqYBoGO5HW8sN5KQUpgs/y2Ik6CVRddtHuq1oVC0aj4e7C7iMfL+Ax79WNNAYfa7vv2pvNDA9Tr+vrqmAaBjuS1vLCeSkFKYPO8tiJOglUX3bR7qpaFQtGo+HuwO8jHy/gMe/VjDQGH2m679qbzgwPU6/r66phGgY7ktbywngpBiiDzvLYiToJVF910e6rWhUKRqTg7sDvIx8v4DHv1Yw0Bh9puO/am84MD1Ou6+uqYBoGPJLW8sJ4KQYog8/y2Ik6CVRfdtHuqloVCkak4e7A7yMfL+Ax79WMNAYfabjv2pvODA5TsOvrq mAaBjyS1vLCeCkGKIPO8tiJOglUX3bR7qpaFQpGpeHuwO8jHy/hMe/VjDMGHmi479qbzgwOU7Dq66tgGgY8ktbywngpBimDz/LYiTkJVF920u2rWhUKR6Xh7sDvIx4vfvLYino/VF920u2qWRYLR6Hg7sPuJB8v4THv1I0zBh5ru+/am84NE1Ou6+urYBoGO5LW8sJ5KQUpgs7y2Ik6CVRead9Huq1kWC0el4e7D7yQfL+Ex79SNMgYea7vv2pvODRNTrurrqWEaBTuS1vHCeSsFKYPP8tmJOglUXnbS7qtZFgtHpeHuw+8kHy/hMe/VjDIGHmu779qbzg0TU67q66lhGwU7ktXxw3kpBSiDz/LZiToJVF520u6rWRYLR6Xh7sPuJB8v4THv1YwyBh9ru+/ams4NE1Ou6+upYRoFO5LW8cN5KQUog8/y2Yo6CVRedtLuqlkWC0el4e7D7iQfL+Ex79WMMgYfa7rv2prPDRNTr+vrqmAaBjuR1vHDeCkFKIPP8tmKOglTXnfS7qpZFgtHpbDuw... (truncated)');
        audio.volume = 0.3;
        audio.play().catch(() => { }); // Ignore if audio fails
      } catch (e) { }

      return; // Exit early - don't process duplicate
    }

    // Add to scanned set (counter uses scannedBarcodes.size to avoid duplicate bugs)
    setScannedBarcodes(prev => new Map(prev).set(barcode, data));

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
                <span className={scannedBarcodes.size >= boxesExpected ? 'text-green-400' : 'text-white'}>
                  {scannedBarcodes.size}
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
            className={`h-1.5 rounded-full transition-all duration-500 ${scannedBarcodes.size >= boxesExpected ? 'bg-green-500' : 'bg-blue-500'}`}
            aria-label="Progress"
            style={{ width: `${boxesExpected > 0 ? Math.min(100, (scannedBarcodes.size / boxesExpected) * 100) : 0}%` }}
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

      {/* ── OCR Status Panel (Redesigned) ──────────────────────────── */}
      {pendingOCR.size > 0 && (
        <div className="fixed top-24 left-2 right-2 z-40 bg-gradient-to-r from-purple-900/95 to-blue-900/95 backdrop-blur-sm border border-purple-400 rounded-xl p-3 shadow-2xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="animate-spin h-5 w-5 border-3 border-purple-300 border-t-transparent rounded-full"></div>
                <div className="absolute inset-0 animate-pulse">🤖</div>
              </div>
              <div>
                <div className="text-white font-bold text-sm">AI Reading Box Labels...</div>
                <div className="text-purple-200 text-xs">Extracting product names &amp; weights from {pendingOCR.size} {pendingOCR.size === 1 ? 'box' : 'boxes'}</div>
              </div>
            </div>
          </div>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {Array.from(pendingOCR).slice(0, 3).map((barcode) => {
              const result = ocrResults.get(barcode);
              return (
                <div key={barcode} className="bg-black/40 p-2.5 rounded-lg border border-purple-500/30">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-purple-200 text-xs font-mono mb-1">Box #{barcode.slice(-6)}</div>
                      {result ? (
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1">
                            <span className="text-green-400 text-lg">✓</span>
                            <span className="text-green-300 text-sm font-semibold truncate">
                              {result.product_name || 'Product name unclear'}
                            </span>
                          </div>
                          <div className="text-blue-200 text-xs ml-6">
                            {result.weight_kg ? `Weight: ${result.weight_kg} kg` : 'Weight: Not found on label'}
                          </div>
                          {result.expiry_date && (
                            <div className="text-yellow-200 text-xs ml-6">Expiry: {result.expiry_date}</div>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <div className="animate-bounce text-yellow-400">⏳</div>
                          <span className="text-yellow-200 text-xs">Gemini AI analyzing image...</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {pendingOCR.size > 3 && (
              <div className="text-center py-2 text-purple-300 text-xs font-medium">
                + {pendingOCR.size - 3} more boxes being analyzed...
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Debug Toggle Button (Always Visible) ──────────────────── */}
      {errorLog.length > 0 && (
        <button
          onClick={() => setShowDebugPanel(!showDebugPanel)}
          className="fixed bottom-24 right-4 z-50 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-full shadow-lg text-sm font-bold"
        >
          🐛 {showDebugPanel ? 'Hide' : 'Debug'} ({errorLog.length})
        </button>
      )}

      {/* ── Debug Panel (Bottom Drawer) ──────────────────────────── */}
      {showDebugPanel && errorLog.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900 border-t-2 border-red-500 shadow-2xl" style={{ maxHeight: '40vh' }}>
          <div className="flex justify-between items-center p-3 border-b border-gray-700 bg-gray-800">
            <span className="text-white font-bold text-sm">🐛 Debug Log</span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const text = errorLog.map(e => `${e.time}: ${e.msg}`).join('\n');
                  navigator.clipboard.writeText(text);
                  alert('Debug log copied!');
                }}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
              >
                📋 Copy All
              </button>
              <button
                onClick={() => setShowDebugPanel(false)}
                className="text-gray-400 hover:text-white text-lg px-2"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="overflow-y-auto p-3 space-y-1" style={{ maxHeight: 'calc(40vh - 60px)' }}>
            {errorLog.map((entry, i) => (
              <div key={i} className="text-xs bg-black/50 p-2 rounded border border-gray-800">
                <span className="text-gray-500">{entry.time}</span>
                <div className={`mt-1 ${entry.msg.includes('DUPLICATE') || entry.msg.includes('⚠️') ? 'text-red-400' : entry.msg.includes('✓') || entry.msg.includes('Uploaded') ? 'text-green-400' : 'text-yellow-300'}`}>
                  {entry.msg}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Force Confirm Modal ───────────────────────────────── */}
      {
        showForceConfirm && session && (
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
        )
      }
    </div >
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
