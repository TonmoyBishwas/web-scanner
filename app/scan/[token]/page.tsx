'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { ScannedList } from '@/components/progress/ScannedList';
import { IssueResolution } from '@/components/progress/IssueResolution';
import { ImageModal } from '@/components/shared/ImageModal';
import { SessionTimer } from '@/components/shared/SessionTimer';
import { UndoToast } from '@/components/shared/UndoToast';
import { InvoiceDrawer } from '@/components/shared/InvoiceDrawer';
import { OfflineBanner } from '@/components/shared/OfflineBanner';
import { SwipeConfirm } from '@/components/shared/SwipeConfirm';
import { PhotoGallery } from '@/components/shared/PhotoGallery';
import { DesignHeader } from '@/components/terminal/DesignHeader';
import { ProgressHeader } from '@/components/terminal/ProgressHeader';
import { BottomSheet } from '@/components/terminal/BottomSheet';
import { ToolDock, type ToolChip } from '@/components/terminal/ToolDock';
import { PalletIcon } from '@/components/terminal/MI';
import { Toast, useLockToast } from '@/components/terminal/Toast';
import { useDrawerHost } from '@/components/terminal/DrawerHost';
import { PalletsBrowser } from '@/components/terminal/PalletsBrowser';
import { CartonCreator } from '@/components/terminal/CartonCreator';
import { LabelsBrowser } from '@/components/terminal/LabelsBrowser';
import { useSettingsStore } from '@/stores/settings-store';
import { scanSuccessFeedback, scanDuplicateFeedback } from '@/lib/scan-feedback';
import { queueScan, getQueue, replayQueue } from '@/lib/offline-queue';
import {
  XCircle,
  CheckCircle,
  Bug,
  ClipboardList,
  Check,
  X,
  Zap,
} from 'lucide-react';
import type {
  Language,
  ParsedBarcode,
  BoxStickerOCR,
  ScanSession,
  ScanEntry,
  InvoiceItem,
  OCRIssue,
  ManualEntryData,
} from '@/types';
import { useLangDir, LanguageContext, t } from '@/lib/i18n';

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

  // Settings
  const hydrate = useSettingsStore((s) => s.hydrate);

  // Session state
  const [session, setSession] = useState<ScanSession | null>(null);
  const language = (session?.language as Language) || 'English';
  useLangDir(language);
  // Local translator bound to current language. Falls back to English until session loads.
  const tr = useCallback(
    (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(language, key, vars),
    [language],
  );
  const [phase, setPhase] = useState<ScanPhase>('loading');
  const [error, setError] = useState<string | null>(null);

  // Scan tracking
  const [scannedBarcodes, setScannedBarcodes] = useState<Map<string, ParsedBarcode>>(new Map());
  const [ocrResults, setOcrResults] = useState<Map<string, BoxStickerOCR>>(new Map());

  const [ocrImageUrls, setOcrImageUrls] = useState<Map<string, string>>(new Map());
  const [boxesExpected, setBoxesExpected] = useState(0);

  // OCR tracking
  const [pendingOCR, setPendingOCR] = useState<Set<string>>(new Set());
  const [ocrIssues, setOcrIssues] = useState<OCRIssue[]>([]);
  const [allIssuesResolved, setAllIssuesResolved] = useState(true);

  // Force confirm
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  // Terminal chrome: side drawer host (session timer lives in its footer —
  // the design header has no room for it) + lock/info toast.
  const drawer = useDrawerHost(
    token,
    session?.created_at ? <SessionTimer createdAt={session.created_at} /> : undefined,
  );
  const { toast: infoToast, showToast: showInfoToast, showLockToast } = useLockToast(tr('terminal.lockedToast'));
  const [showPallets, setShowPallets] = useState(false);
  // צור קרטון / מדבקות — mint a sticker for a carton whose own label is
  // missing or unreadable, then print it. Neither writes stock: the printed
  // sticker is scanned in through this same page.
  const [showCartonCreator, setShowCartonCreator] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [manualEntries, setManualEntries] = useState<ManualEntryData[]>([]);

  // UI drawers & panels
  const [showInvoiceDrawer, setShowInvoiceDrawer] = useState(false);
  const [showPhotoGallery, setShowPhotoGallery] = useState(false);

  // Undo toast
  const [undoBarcode, setUndoBarcode] = useState<string | null>(null);
  // Which scanned row is expanded to reveal its Delete control (two-step).
  const [selectedScanBarcode, setSelectedScanBarcode] = useState<string | null>(null);

  // Offline
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  // Error logging for mobile debugging
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [errorLog, setErrorLog] = useState<Array<{ time: string, msg: string }>>([]);
  const [scannerType, setScannerType] = useState<'native' | 'fallback' | null>(null);

  // Feedback states
  const [flashColor, setFlashColor] = useState<'green' | 'red' | null>(null);
  const [showToast, setShowToast] = useState<string | null>(null);
  const [counterBounce, setCounterBounce] = useState(false);

  const addErrorLog = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setErrorLog(prev => [...prev, { time, msg }]);
    console.error(`[ERROR ${time}]`, msg);
  }, []);


  // ── Visual + audio/haptic feedback ───────────────────────────
  // Sound + vibration are delegated to the shared scan-feedback module so all
  // scanner pages cue identically and honour the same Sound / Vibration toggles.
  const triggerSuccessFeedback = useCallback(() => {
    setFlashColor('green');
    setTimeout(() => setFlashColor(null), 150);

    scanSuccessFeedback();

    setCounterBounce(true);
    setTimeout(() => setCounterBounce(false), 300);
  }, []);

  const triggerDuplicateFeedback = useCallback(() => {
    if (redFlashTriggerRef.current) {
      redFlashTriggerRef.current();
    }
    scanDuplicateFeedback();
  }, []);

  // Polling ref
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const processedBarcodesRef = useRef<Set<string>>(new Set());
  const redFlashTriggerRef = useRef<(() => void) | null>(null);
  const resolvedBarcodesRef = useRef<Set<string>>(new Set());

  // ── Hydrate Settings ──────────────────────────────────────────
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // ── Load Session ──────────────────────────────────────────────
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`/api/session?token=${token}`);
        if (!res.ok) throw new Error(t(undefined, 'session.notFound'));
        const sessionData: ScanSession = await res.json();
        setSession(sessionData);

        const totalExpected = sessionData.invoice_items.reduce(
          (sum: number, item: InvoiceItem) => sum + (item.expected_boxes || 0),
          0
        );
        setBoxesExpected(totalExpected);

        if (sessionData.scanned_barcodes) {
          const barcodeMap = new Map<string, ParsedBarcode>();
          const urlMap = new Map<string, string>();
          const initialIssues: OCRIssue[] = [];
          const initialResults = new Map<string, BoxStickerOCR>();
          const initialPending = new Set<string>();

          sessionData.scanned_barcodes.forEach((entry: ScanEntry) => {
            barcodeMap.set(entry.barcode, {
              type: 'id-only',
              sku: entry.barcode,
              weight: 0,
              expiry: '',
              raw_barcode: entry.barcode,
              expiry_source: 'ocr_required',
            });

            if (entry.image_url) {
              urlMap.set(entry.barcode, entry.image_url);
            }

            if (entry.ocr_status === 'failed') {
              initialIssues.push({
                barcode: entry.barcode,
                image_url: entry.image_url || '',
                type: 'missing_both',
                inferred_weight: entry.inferred_weight
              });
            } else if (entry.ocr_status === 'pending') {
              initialPending.add(entry.barcode);
            } else if (entry.ocr_status === 'complete' && entry.ocr_data) {
              initialResults.set(entry.barcode, entry.ocr_data);

              if (!entry.ocr_data.product_name && !entry.ocr_data.weight_kg) {
                initialIssues.push({
                  barcode: entry.barcode,
                  image_url: entry.image_url || '',
                  type: 'missing_both',
                  ocr_data: entry.ocr_data
                });
              } else if (!entry.ocr_data.product_name) {
                initialIssues.push({
                  barcode: entry.barcode,
                  image_url: entry.image_url || '',
                  type: 'missing_name',
                  ocr_data: entry.ocr_data
                });
              } else if (!entry.ocr_data.weight_kg) {
                const inferredWeight = inferWeight(entry, sessionData);
                initialIssues.push({
                  barcode: entry.barcode,
                  image_url: entry.image_url || '',
                  type: 'missing_weight',
                  inferred_weight: inferredWeight,
                  ocr_data: entry.ocr_data
                });
              }

            } else if (entry.ocr_status === 'manual') {
              initialResults.set(entry.barcode, {
                product_name: entry.resolved_item_name || null,
                weight_kg: entry.resolved_weight || null,
                expiry_date: entry.resolved_expiry || null,
                production_date: null,
                barcode_digits: null
              });
            }
          });

          setScannedBarcodes(barcodeMap);
          setOcrImageUrls(urlMap);
          setOcrIssues(initialIssues);
          setOcrResults(initialResults);
          setPendingOCR(initialPending);

          barcodeMap.forEach((_, key) => processedBarcodesRef.current.add(key));

          if (initialIssues.length > 0) {
            setPhase('issues');
          } else if (initialPending.size > 0) {
            setPhase('processing');
          } else {
            setPhase('scanning');
          }
        }

      } catch (err) {
        setError(err instanceof Error ? err.message : t(undefined, 'session.failedLoad'));
        setPhase('error');
      }
    }
    fetchSession();
  }, [token]);

  // ── Offline: sync queue on reconnect ──────────────────────────
  useEffect(() => {
    const syncQueue = async () => {
      const queue = getQueue();
      const count = queue.filter(q => q.token === token).length;
      setOfflineQueueCount(count);

      if (count > 0 && navigator.onLine) {
        setIsSyncing(true);
        const result = await replayQueue(token);
        setIsSyncing(false);
        setOfflineQueueCount(0);
        if (result.synced > 0) {
          addErrorLog(`Synced ${result.synced} offline scans`);
        }
      }
    };

    syncQueue();
    window.addEventListener('online', syncQueue);
    return () => window.removeEventListener('online', syncQueue);
  }, [token, addErrorLog]);

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
    setOcrImageUrls(prev => new Map(prev).set(barcode, imageUrl));

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
      const res = await fetch(`/api/session?token=${token}&t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (!res.ok) return;
      const updatedSession: ScanSession = await res.json();
      setSession(updatedSession);

      const stillPending = new Set<string>();
      const newOcrResults = new Map(ocrResults);
      const issues: OCRIssue[] = [];

      updatedSession.scanned_barcodes.forEach((entry: ScanEntry) => {
        if (resolvedBarcodesRef.current.has(entry.barcode)) {
          return;
        }

        if (entry.ocr_status === 'pending') {
          stillPending.add(entry.barcode);
        } else if (entry.ocr_status === 'complete' && entry.ocr_data) {
          newOcrResults.set(entry.barcode, entry.ocr_data);

          if (!entry.ocr_data.product_name && !entry.ocr_data.weight_kg) {
            issues.push({
              barcode: entry.barcode,
              image_url: entry.image_url || ocrImageUrls.get(entry.barcode) || '',
              type: 'missing_both',
              ocr_data: entry.ocr_data
            });
          } else if (!entry.ocr_data.product_name) {
            issues.push({
              barcode: entry.barcode,
              image_url: entry.image_url || ocrImageUrls.get(entry.barcode) || '',
              type: 'missing_name',
              ocr_data: entry.ocr_data
            });
          } else if (!entry.ocr_data.weight_kg) {
            const inferredWeight = inferWeight(entry, updatedSession);
            issues.push({
              barcode: entry.barcode,
              image_url: entry.image_url || ocrImageUrls.get(entry.barcode) || '',
              type: 'missing_weight',
              inferred_weight: inferredWeight,
              ocr_data: entry.ocr_data
            });
          }
        } else if (entry.ocr_status === 'manual') {
          newOcrResults.set(entry.barcode, {
            product_name: entry.resolved_item_name || null,
            weight_kg: entry.resolved_weight || null,
            expiry_date: entry.resolved_expiry || null,
            production_date: null,
            barcode_digits: null
          });
        } else if (entry.ocr_status === 'failed') {
          issues.push({
            barcode: entry.barcode,
            image_url: entry.image_url || ocrImageUrls.get(entry.barcode) || '',
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

      if (stillPending.size === 0 && issues.length > 0) {
        setPhase('issues');
      } else if (stillPending.size === 0 && issues.length === 0) {
        setPhase('ready_confirm');
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, [token, pendingOCR, ocrResults, ocrImageUrls]);

  // Smart weight inference
  function inferWeight(entry: ScanEntry, session: ScanSession): number | undefined {
    if (!entry.ocr_data?.product_name) return undefined;

    const matchedItem = session.invoice_items.find(
      i => i.item_name_hebrew === entry.ocr_data?.product_name
    );
    if (!matchedItem) return undefined;

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

  // ── Client-side OCR timeout fallback (mark as failed after 40s) ──
  useEffect(() => {
    const checkStuckOCR = async () => {
      try {
        const response = await fetch(`/api/session?token=${token}&t=${Date.now()}`, {
          cache: 'no-store'
        });
        if (!response.ok) return;

        const freshSession = await response.json();
        if (!freshSession || !freshSession.scanned_barcodes) return;

        const now = Date.now();
        const TIMEOUT_MS = 40000;

        const updates: any[] = [];

        freshSession.scanned_barcodes.forEach((entry: ScanEntry) => {
          if (entry.ocr_status === 'pending') {
            const createdAt = entry.scanned_at ? new Date(entry.scanned_at).getTime() : now;
            const elapsed = now - createdAt;

            if (elapsed > TIMEOUT_MS) {
              const msg = `OCR timeout for ${entry.barcode} after ${Math.floor(elapsed / 1000)}s - marking as failed`;
              addErrorLog(msg);

              updates.push({
                barcode: entry.barcode,
                ocr_status: 'failed',
                ocr_error: 'Client timeout (40s)'
              });
            }
          }
        });

        if (updates.length > 0) {
          try {
            const putRes = await fetch(`/api/session?token=${token}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates })
            });

            if (!putRes.ok) {
              addErrorLog(`CheckStuckOCR PUT failed: ${putRes.status} ${putRes.statusText}`);
            }
          } catch (putErr) {
            addErrorLog(`CheckStuckOCR PUT error: ${putErr}`);
          }

          const updatedResponse = await fetch(`/api/session?token=${token}&t=${Date.now()}`, {
            cache: 'no-store'
          });
          if (updatedResponse.ok) {
            const updatedData = await updatedResponse.json();
            setSession(updatedData);

            updatedData.scanned_barcodes.forEach((entry: ScanEntry) => {
              if (entry.ocr_status === 'failed') {
                const barcode = entry.barcode;

                setPendingOCR(prev => {
                  const next = new Set(prev);
                  next.delete(barcode);
                  return next;
                });

                setOcrIssues(prev => {
                  if (prev.some(i => i.barcode === barcode)) return prev;
                  return [...prev, {
                    barcode,
                    scanned_at: entry.scanned_at || new Date().toISOString(),
                    type: 'missing_both' as const,
                    error_type: 'blur',
                    image_url: ocrImageUrls.get(barcode) || entry.image_url || ''
                  }];
                });
              }
            });

            if (updatedData.scanned_barcodes.some((e: ScanEntry) => e.ocr_status === 'failed')) {
              setAllIssuesResolved(false);
              setPhase('issues');
            }
          }
        }
      } catch (error) {
        console.error('[Client] Timeout checker error:', error);
        addErrorLog(`[Client] Timeout checker error: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const interval = setInterval(checkStuckOCR, 5000);
    return () => clearInterval(interval);
  }, [token, addErrorLog, ocrImageUrls]);

  // ── Undo Last Scan ─────────────────────────────────────────────
  const handleUndoScan = useCallback(async (barcode: string) => {
    try {
      const res = await fetch('/api/scan', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, barcode }),
      });
      const result = await res.json();
      if (result.success) {
        // Remove from local state
        processedBarcodesRef.current.delete(barcode);
        setScannedBarcodes(prev => {
          const next = new Map(prev);
          next.delete(barcode);
          return next;
        });
        setOcrResults(prev => {
          const next = new Map(prev);
          next.delete(barcode);
          return next;
        });
        setOcrImageUrls(prev => {
          const next = new Map(prev);
          next.delete(barcode);
          return next;
        });
        setPendingOCR(prev => {
          const next = new Set(prev);
          next.delete(barcode);
          return next;
        });
        addErrorLog(`Undo: removed barcode ${barcode}`);
      }
    } catch (err) {
      addErrorLog(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setUndoBarcode(null);
  }, [token, addErrorLog]);

  // ── Barcode Detected Handler ─────────────────────────────────
  const handleBarcodeDetected = useCallback(async (
    barcode: string,
    data: ParsedBarcode,
    imageData?: string
  ) => {
    const isValidBarcode = /^[A-Za-z0-9]+$/.test(barcode);
    if (!isValidBarcode) {
      addErrorLog(`Ignored invalid barcode: ${barcode}`);
      return;
    }

    // Check for exact duplicate (same barcode already scanned)
    if (processedBarcodesRef.current.has(barcode)) {
      triggerDuplicateFeedback();
      addErrorLog(`Barcode ${barcode}: Duplicate (already scanned)`);
      return;
    }

    processedBarcodesRef.current.add(barcode);
    setScannedBarcodes(prev => new Map(prev).set(barcode, data));
    triggerSuccessFeedback();

    if (!imageData) {
      addErrorLog(`Barcode ${barcode}: No image captured by scanner`);
    } else {
      addErrorLog(`Barcode ${barcode}: Image captured (${Math.round(imageData.length / 1024)}KB)`);
    }

    // Check offline
    if (!navigator.onLine) {
      queueScan({
        token,
        barcode,
        parsed_data: data,
        image_url: '',
        image_public_id: '',
        detected_at: new Date().toISOString(),
        scan_method: 'barcode',
      });
      setOfflineQueueCount(prev => prev + 1);
      addErrorLog(`Barcode ${barcode}: Queued offline`);
      return;
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

    // Submit scan to API
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

      if (imageUrl) {
        triggerOCR(barcode, imageUrl);
        addErrorLog(`Barcode ${barcode}: OCR started`);
      } else {
        addErrorLog(`Barcode ${barcode}: No OCR (no image)`);
      }
    } catch (err) {
      addErrorLog(`/api/scan error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addErrorLog, token, triggerDuplicateFeedback, triggerOCR, triggerSuccessFeedback, uploadToCloudinary]);

  // ── Manual Capture Handler ────────────────────────────────────
  const handleManualCapture = useCallback(async (imageData: string) => {
    const tempBarcode = `manual_${Date.now()}`;

    addErrorLog(`Manual capture: Image captured (${Math.round(imageData.length / 1024)}KB)`);

    const upload = await uploadToCloudinary(imageData);
    if (!upload) {
      addErrorLog('Manual capture upload failed');
      return;
    }
    addErrorLog(`Manual capture: Uploaded to Cloudinary`);

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
      addErrorLog(`Manual capture: Saved to session`);

      triggerOCR(tempBarcode, upload.url);
      addErrorLog(`Manual capture: OCR started`);
    } catch (err) {
      addErrorLog(`Manual capture error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addErrorLog, token, triggerOCR, uploadToCloudinary]);

  // ── Force Confirm ─────────────────────────────────────────────
  const handleForceConfirmEntry = useCallback(async (entry: ManualEntryData) => {
    const tempBarcode = `force_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    let imageUrl = '';
    let publicId = '';
    if (entry.image_url) {
      addErrorLog(`Force confirm ${tempBarcode}: Image captured (${Math.round(entry.image_url.length / 1024)}KB)`);
      const upload = await uploadToCloudinary(entry.image_url);
      if (upload) {
        imageUrl = upload.url;
        publicId = upload.publicId;
        addErrorLog(`Force confirm ${tempBarcode}: Uploaded to Cloudinary`);
      } else {
        addErrorLog(`Force confirm ${tempBarcode}: Cloudinary upload failed`);
      }
    }

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

      setManualEntries(prev => [...prev, { ...entry, image_url: imageUrl }]);
    } catch (err) {
      console.error('Force confirm entry error:', err);
    }
  }, [token, uploadToCloudinary, addErrorLog]);

  // ── Issue Resolution Handler ──────────────────────────────────
  const handleIssueResolve = useCallback(async (
    barcode: string,
    resolved: { item_name?: string; weight?: number; expiry?: string }
  ) => {
    resolvedBarcodesRef.current.add(barcode);

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

      setOcrResults(prev => {
        const existing = prev.get(barcode);
        return new Map(prev).set(barcode, {
          product_name: resolved.item_name || existing?.product_name || null,
          weight_kg: resolved.weight ?? existing?.weight_kg ?? null,
          expiry_date: resolved.expiry || existing?.expiry_date || null,
          production_date: existing?.production_date || null,
          barcode_digits: existing?.barcode_digits || null
        });
      });

      setOcrIssues(prev => {
        const next = prev.filter(i => i.barcode !== barcode);
        if (next.length === 0) {
          setAllIssuesResolved(true);
          if (pendingOCR.size === 0) setPhase('ready_confirm');
        }
        return next;
      });

      setPendingOCR(prev => {
        const next = new Set(prev);
        next.delete(barcode);
        return next;
      });

    } catch (err) {
      console.error('Issue resolve error:', err);
    }
  }, [token, pendingOCR]);

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
        setError(result.error || tr('scan.failedComplete'));
      }
    } catch (err) {
      const msg = `Confirmation error: ${err instanceof Error ? err.message : String(err)}`;
      addErrorLog(msg);
      setError(tr('errors.networkErrorConfirm'));
      setPhase('error');
    }
  }, [token, addErrorLog]);

  // Check transition to processing
  const handleCheckProgress = useCallback(() => {
    const scCount = scannedBarcodes.size;
    if (scCount >= boxesExpected && boxesExpected > 0) {
      if (pendingOCR.size > 0) {
        setPhase('processing');
      } else if (ocrIssues.length > 0 && !allIssuesResolved) {
        setPhase('issues');
      } else {
        setPhase('ready_confirm');
      }
    }
  }, [scannedBarcodes.size, boxesExpected, pendingOCR.size, ocrIssues.length, allIssuesResolved]);

  useEffect(() => {
    if (phase === 'scanning') handleCheckProgress();
  }, [scannedBarcodes.size, phase, handleCheckProgress]);

  // Build scannedItems array for InvoiceDrawer (from session data)
  const scannedItems = session ? Object.values(session.scanned_items || {}) : [];

  // ── RENDER ────────────────────────────────────────────────────

  // Loading
  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-line border-t-brand rounded-full mx-auto mb-4"></div>
          <p className="text-ink-body">{tr('scan.loadingSession')}</p>
        </div>
      </div>
    );
  }

  // Error
  if (phase === 'error') {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
        <div className="bg-danger-weak border border-danger/40 rounded-[14px] p-6 max-w-md text-center" role="alert">
          <XCircle className="w-10 h-10 text-danger mx-auto mb-3" />
          <p className="text-danger-weak-ink font-bold">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 min-h-11 bg-tile border border-line-strong hover:bg-hover rounded-xl text-ink text-sm font-bold transition-colors"
          >
            {tr('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  // Complete
  if (phase === 'complete') {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
        <div className="bg-raised border border-ok/30 rounded-[20px] p-6 max-w-md w-full text-center animate-scaleIn">
          <div className="w-16 h-16 rounded-full bg-ok-weak flex items-center justify-center mx-auto mb-4 animate-donePop">
            <CheckCircle className="w-9 h-9 text-ok" />
          </div>
          <h2 className="text-xl font-extrabold text-ink mb-2">{tr('scan.scanComplete')}</h2>
          <p className="text-ink-body text-sm mb-1">
            {tr('scan.boxesScannedAndSubmitted', { count: scannedBarcodes.size })}
          </p>
          <p className="text-ink-muted text-xs">{tr('scan.dataSent')}</p>
        </div>
      </div>
    );
  }

  // Processing (OCR in progress)
  if (phase === 'processing') {
    const totalPending = pendingOCR.size;
    const totalScanned = scannedBarcodes.size;
    const completed = totalScanned - totalPending;

    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
        <div className="bg-raised border border-line rounded-[20px] p-6 max-w-md w-full text-center">
          <div className="animate-spin w-12 h-12 border-4 border-line border-t-brand rounded-full mx-auto mb-4"></div>
          <h2 className="text-lg font-extrabold text-ink mb-2">{tr('ocr.processing')}</h2>
          <p className="text-ink-muted text-sm mb-3">{tr('ocr.extractingData')}</p>
          <div className="bg-sunken rounded-full h-1.5 mb-2 overflow-hidden">
            <div
              className="bg-brand h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${totalScanned > 0 ? (completed / totalScanned) * 100 : 0}%` }}
            ></div>
          </div>
          <p className="text-xs text-ink-muted">
            {tr('scan.processingProgress', { completed, total: totalScanned, pending: totalPending })}
          </p>
        </div>
      </div>
    );
  }

  // Confirming
  if (phase === 'confirming') {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-line border-t-ok rounded-full mx-auto mb-4"></div>
          <p className="text-ink-body">{tr('scan.submittingData')}</p>
        </div>
      </div>
    );
  }

  // ── Main Scanner UI (terminal design) ─────────────────────────
  const isReadyToConfirm = phase === 'ready_confirm' ||
    (scannedBarcodes.size >= boxesExpected && pendingOCR.size === 0 && allIssuesResolved);

  const canForceConfirm = scannedBarcodes.size < boxesExpected && scannedBarcodes.size > 0;

  // Share the scan list as text (WhatsApp sheet / clipboard fallback).
  async function handleShareScan() {
    const lines: string[] = [tr('scan.docPrefix', { doc: session?.document_number || '—' })];
    let i = 1;
    for (const [barcode] of scannedBarcodes) {
      const ocr = ocrResults.get(barcode);
      const nm = ocr?.product_name_hebrew || ocr?.product_name || '';
      lines.push(`${i++}. ${nm ? `${nm} · ` : ''}${barcode}${ocr?.weight_kg ? ` · ${ocr.weight_kg} kg` : ''}`);
    }
    const text = lines.join('\n');
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showInfoToast(tr('terminal.shareCopied'));
    } catch { /* nothing else to fall back to */ }
  }

  // Terminal tool dock: real actions (document, photos, share, gap, debug)
  // + locked chips for features with no backend.
  const scanDockChips: ToolChip[] = [
    {
      id: 'invoice', icon: 'description', label: tr('terminal.toolInvoice'), tint: 'blue', iconColor: '#33b1f0',
      onPress: () => setShowInvoiceDrawer(true),
    },
    ...(ocrImageUrls.size > 0
      ? [{
          id: 'photos', icon: 'photo_library', label: tr('scan.photosButton', { count: ocrImageUrls.size }),
          tint: 'neutral' as const, onPress: () => setShowPhotoGallery(true),
        }]
      : []),
    {
      id: 'create', icon: 'add', label: tr('terminal.toolCreateCarton'), tint: 'blue', iconColor: '#33b1f0',
      onPress: () => setShowCartonCreator(true),
    },
    { id: 'labels', icon: 'label', label: tr('terminal.toolLabels'), tint: 'neutral', onPress: () => setShowLabels(true) },
    { id: 'warehouses', icon: 'warehouse', label: tr('terminal.toolWarehouses'), tint: 'neutral', locked: true },
    { id: 'pallets', icon: <PalletIcon />, label: tr('terminal.toolPallets'), tint: 'neutral', onPress: () => setShowPallets(true) },
    {
      id: 'delete', icon: 'delete_sweep', label: tr('terminal.toolDelete'), tint: 'red',
      onPress: () => showInfoToast(tr('terminal.deleteHint'), 'delete_sweep', '#ef8a8a'),
    },
    { id: 'share', icon: 'ios_share', label: tr('terminal.toolShare'), tint: 'blue', onPress: handleShareScan },
    { id: 'assign', icon: 'send', flip: true, label: tr('terminal.toolAssign'), tint: 'green', locked: true },
    {
      id: 'gap', icon: 'report_problem', label: tr('terminal.toolGap'), tint: 'amber', iconColor: '#fbbf5c',
      onPress: () =>
        canForceConfirm && phase === 'scanning'
          ? setShowForceConfirm(true)
          : showInfoToast(tr('terminal.gapNotApplicable'), 'report_problem', '#fbbf5c'),
    },
    ...(errorLog.length > 0
      ? [{
          id: 'debug', icon: 'bug_report', label: tr('scan.debugButton', { count: errorLog.length }),
          tint: 'red' as const, onPress: () => setShowDebugPanel(!showDebugPanel),
        }]
      : []),
  ];

  const scanFooter = (
    <>
      {canForceConfirm && phase === 'scanning' && (
        <button
          onClick={() => setShowForceConfirm(true)}
          className="w-full h-12 bg-warn rounded-[13px] text-sm font-black text-canvas flex items-center justify-center gap-2 mb-2"
        >
          <Zap className="w-4 h-4" />
          {tr('scan.forceConfirmButton', { count: boxesExpected - scannedBarcodes.size })}
        </button>
      )}
      {isReadyToConfirm && (
        <SwipeConfirm
          onConfirm={handleConfirm}
          label={tr('scan.slideToConfirm')}
        />
      )}
      {scannedBarcodes.size > 0 && phase === 'scanning' && (
        <p className="text-center text-xs text-ink-muted mt-2">
          {pendingOCR.size > 0
            ? tr('scan.boxesSummaryWithOcr', { count: scannedBarcodes.size, pending: pendingOCR.size })
            : tr('scan.boxesSummary', { count: scannedBarcodes.size })}
        </p>
      )}
    </>
  );

  return (
   <LanguageContext.Provider value={language}>
    <div className="h-dvh bg-canvas text-ink flex flex-col overflow-hidden">
      {/* ── Offline Banner ──────────────────────────────────── */}
      <OfflineBanner queueCount={offlineQueueCount} isSyncing={isSyncing} />

      {/* ── Header (terminal design) ─────────────────────────── */}
      <DesignHeader
        title={tr('scan.docPrefix', { doc: session?.document_number || '—' })}
        subtitle={session?.user_info ? tr('scan.scanningAs', { nickname: session.user_info.nickname }) : undefined}
        onMenu={drawer.open}
        right={pendingOCR.size > 0 ? (
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-warn-weak-ink bg-warn-weak border border-warn/30 rounded-full px-2.5 py-1 me-1">
            <span className="w-2 h-2 bg-warn rounded-full animate-pulse" />
            {tr('scan.ocrPending', { count: pendingOCR.size })}
          </span>
        ) : undefined}
      />
      <ProgressHeader
        label={tr('terminal.progressLabelCartons')}
        count={scannedBarcodes.size}
        total={boxesExpected}
        unitLabel={tr('terminal.statCartons')}
        tone={scannedBarcodes.size >= boxesExpected && boxesExpected > 0 ? 'done' : 'brand'}
      />

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

      {/* ── Scanning / Ready Confirm: camera + floating sheet ──── */}
      {(phase === 'scanning' || phase === 'ready_confirm') && (
        <div className="flex-1 min-h-0 relative bg-black">
          <div className="absolute inset-0">
            <SmartScanner
              frame="corner"
              className="h-full"
              onBarcodeDetected={handleBarcodeDetected}
              onManualCapture={handleManualCapture}
              scannedBarcodes={scannedBarcodes}
              ocrResults={ocrResults}
              onScannerTypeDetected={setScannerType}
              onDuplicateFlash={(triggerFn) => {
                redFlashTriggerRef.current = triggerFn;
              }}
            />
          </div>

          <BottomSheet
            toolbar={<ToolDock chips={scanDockChips} onLockedPress={showLockToast} />}
            footer={scanFooter}
          >
            <ScannedList
              scannedBarcodes={scannedBarcodes}
              ocrResults={ocrResults}
              ocrImageUrls={ocrImageUrls}
              pendingOCR={pendingOCR}
              onImageClick={setSelectedImage}
              onDelete={handleUndoScan}
              selectedBarcode={selectedScanBarcode}
              onSelect={setSelectedScanBarcode}
            />
          </BottomSheet>
        </div>
      )}

      <Toast toast={infoToast} />
      {drawer.node}
      {showPallets && <PalletsBrowser token={token} onBack={() => setShowPallets(false)} />}
      {showCartonCreator && session && (
        <CartonCreator
          token={token}
          items={session.invoice_items}
          onBack={() => setShowCartonCreator(false)}
          onCreated={(count) => {
            setShowCartonCreator(false);
            setShowLabels(true);
            showInfoToast(tr('carton.created', { count }), 'label');
          }}
        />
      )}
      {showLabels && (
        <LabelsBrowser token={token} onBack={() => setShowLabels(false)} />
      )}

      {/* ── Invoice Drawer ────────────────────────────────────── */}
      {session && (
        <InvoiceDrawer
          open={showInvoiceDrawer}
          onClose={() => setShowInvoiceDrawer(false)}
          items={session.invoice_items}
          scannedItems={scannedItems}
          ocrResults={ocrResults}
          ocrPending={pendingOCR}
        />
      )}

      {/* ── Debug Panel (Bottom Drawer) ──────────────────────── */}
      {showDebugPanel && errorLog.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-raised rounded-t-[20px] border-t border-line-strong shadow-2xl animate-slideInUp" style={{ maxHeight: '40vh' }}>
          <div className="pt-2 flex justify-center">
            <div className="w-9 h-1 rounded-full bg-line-strong"></div>
          </div>
          <div className="flex justify-between items-center p-3 border-b border-line">
            <div className="flex items-center gap-2">
              <Bug className="w-4 h-4 text-danger" />
              <span className="text-ink font-extrabold text-sm">{tr('scan.debugLog')}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const text = errorLog.map(e => `${e.time}: ${e.msg}`).join('\n');
                  navigator.clipboard.writeText(text);
                  alert(tr('scan.debugCopied'));
                }}
                className="px-3 py-1 bg-brand hover:bg-brand-hover text-ink-inverse font-bold text-xs rounded-lg flex items-center gap-1"
              >
                <ClipboardList className="w-3 h-3" /> {tr('scan.copyAll')}
              </button>
              <button
                onClick={() => setShowDebugPanel(false)}
                className="text-ink-muted hover:text-ink p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          <div className="overflow-y-auto p-3 space-y-1" style={{ maxHeight: 'calc(40vh - 72px)' }}>
            {errorLog.map((entry, i) => (
              <div key={i} className="text-xs bg-sunken p-2 rounded-lg border border-line">
                <span className="text-ink-muted font-mono" dir="ltr">[{entry.time}]</span>
                <div className={`mt-1 font-mono ${entry.msg.includes('DUPLICATE') || entry.msg.includes('warning') ? 'text-danger-weak-ink' : entry.msg.includes('Uploaded') || entry.msg.includes('Saved') ? 'text-ok-weak-ink' : 'text-warn-weak-ink'}`} dir="ltr">
                  {entry.msg}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Force Confirm Modal ────────────────────────────────── */}
      {showForceConfirm && session && (
        <ForceConfirmModal
          session={session}
          boxesScanned={scannedBarcodes.size}
          boxesExpected={boxesExpected}
          tr={tr}
          onAddEntry={handleForceConfirmEntry}
          onClose={() => {
            setShowForceConfirm(false);
            if (pendingOCR.size > 0) {
              setPhase('processing');
            } else {
              setPhase('ready_confirm');
            }
          }}
        />
      )}

      {/* ── Photo Gallery ─────────────────────────────────────── */}
      {showPhotoGallery && (
        <PhotoGallery
          images={ocrImageUrls}
          ocrResults={ocrResults}
          onClose={() => setShowPhotoGallery(false)}
        />
      )}

      {/* ── Image Modal (Global) ───────────────────────────────── */}
      {selectedImage && (
        <ImageModal
          imageUrl={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}
    </div>
   </LanguageContext.Provider>
  );
}

// ── Force Confirm Modal ─────────────────────────────────────────
function ForceConfirmModal({
  session,
  boxesScanned,
  boxesExpected,
  tr,
  onAddEntry,
  onClose,
}: {
  session: ScanSession;
  boxesScanned: number;
  boxesExpected: number;
  tr: (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => string;
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
    <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-sm flex items-end xl:items-center justify-center animate-fadeIn">
      <div className="bg-raised w-full max-w-md max-h-[85vh] overflow-y-auto rounded-t-[20px] xl:rounded-[20px] border-t border-line-strong xl:border border-line p-4 pt-2 space-y-4 animate-slideInUp">
        <div className="flex justify-center xl:hidden">
          <div className="w-9 h-1 rounded-full bg-line-strong"></div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-warn" />
            <h3 className="text-lg font-extrabold text-warn-weak-ink">
              {tr('scan.manualEntryTitle', { count: remaining })}
            </h3>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-ink-muted">
          {tr('scan.manualEntryDesc', { count: remaining })}
        </p>

        {entries.map((entry, idx) => (
          <div key={idx} className="bg-sunken border border-line rounded-xl p-3 space-y-2">
            <p className="text-sm font-bold text-ink-body">{tr('scan.boxNumber', { n: boxesScanned + idx + 1 })}</p>

            <select
              value={entry.item_name}
              onChange={e => {
                const updated = [...entries];
                updated[idx].item_name = e.target.value;
                setEntries(updated);
              }}
              className="w-full p-2 min-h-11 bg-tile border border-line-strong rounded-lg text-sm text-ink focus:border-brand focus:outline-none"
            >
              <option value="">{tr('scan.selectItem')}</option>
              {session.invoice_items.map(item => (
                <option key={item.item_index} value={item.item_name_english}>
                  {tr('scan.itemOption', { name: item.item_name_english, weight: item.quantity_kg })}
                </option>
              ))}
            </select>

            <input
              type="number"
              step="0.001"
              placeholder={tr('scan.weightPlaceholder')}
              value={entry.weight}
              onChange={e => {
                const updated = [...entries];
                updated[idx].weight = e.target.value;
                setEntries(updated);
              }}
              dir="ltr"
              className="w-full p-2 min-h-11 bg-tile border border-line-strong rounded-lg text-sm text-ink font-mono focus:border-brand focus:outline-none"
            />

            <input
              type="date"
              placeholder={tr('scan.expiryPlaceholder')}
              value={entry.expiry}
              onChange={e => {
                const updated = [...entries];
                updated[idx].expiry = e.target.value;
                setEntries(updated);
              }}
              dir="ltr"
              className="w-full p-2 min-h-11 bg-tile border border-line-strong rounded-lg text-sm text-ink font-mono focus:border-brand focus:outline-none [color-scheme:dark]"
            />
          </div>
        ))}

        <button
          onClick={handleSubmitAll}
          disabled={!allFilled || submitting}
          className="w-full h-12 bg-warn hover:bg-warn/90 text-canvas disabled:bg-line-strong disabled:text-ink-muted disabled:cursor-not-allowed rounded-xl text-sm font-extrabold transition-colors"
        >
          {submitting ? tr('scan.submitting') : tr('scan.submitManualEntries', { count: remaining })}
        </button>
      </div>
    </div>
  );
}
