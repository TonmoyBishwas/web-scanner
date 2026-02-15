'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { ScannedList } from '@/components/progress/ScannedList';
import { IssueResolution } from '@/components/progress/IssueResolution';
import { ImageModal } from '@/components/shared/ImageModal';
import { SettingsPopover } from '@/components/shared/SettingsPopover';
import { SessionTimer } from '@/components/shared/SessionTimer';
import { UndoToast } from '@/components/shared/UndoToast';
import { InvoiceDrawer } from '@/components/shared/InvoiceDrawer';
import { ProgressRing } from '@/components/shared/ProgressRing';
import { OfflineBanner } from '@/components/shared/OfflineBanner';
import { SwipeConfirm } from '@/components/shared/SwipeConfirm';
import { PhotoGallery } from '@/components/shared/PhotoGallery';
import { useSettingsStore } from '@/stores/settings-store';
import { queueScan, getQueue, replayQueue } from '@/lib/offline-queue';
import {
  Package,
  XCircle,
  CheckCircle,
  Cpu,
  Search,
  Clock,
  Bug,
  ClipboardList,
  Check,
  X,
  Zap,
  AlertTriangle,
  FileText,
  Image as ImageIcon,
} from 'lucide-react';
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

  // Settings
  const { soundEnabled, vibrationEnabled } = useSettingsStore();

  // Session state
  const [session, setSession] = useState<ScanSession | null>(null);
  const [phase, setPhase] = useState<ScanPhase>('loading');
  const [error, setError] = useState<string | null>(null);

  // Scan tracking
  const [scannedBarcodes, setScannedBarcodes] = useState<Map<string, ParsedBarcode>>(new Map());
  const [ocrResults, setOcrResults] = useState<Map<string, BoxStickerOCR>>(new Map());

  const [showOCRDrawer, setShowOCRDrawer] = useState(false);
  const [ocrImageUrls, setOcrImageUrls] = useState<Map<string, string>>(new Map());
  const [boxesExpected, setBoxesExpected] = useState(0);

  // OCR tracking
  const [pendingOCR, setPendingOCR] = useState<Set<string>>(new Set());
  const [ocrIssues, setOcrIssues] = useState<OCRIssue[]>([]);
  const [allIssuesResolved, setAllIssuesResolved] = useState(true);

  // Force confirm
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [manualEntries, setManualEntries] = useState<ManualEntryData[]>([]);

  // UI drawers & panels
  const [showInvoiceDrawer, setShowInvoiceDrawer] = useState(false);
  const [showPhotoGallery, setShowPhotoGallery] = useState(false);

  // Undo toast
  const [undoBarcode, setUndoBarcode] = useState<string | null>(null);

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


  // ──  Audio feedback using Web Audio API ──────────────────────
  const playSuccessSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
    } catch (e) {
      // Audio not supported
    }
  }, [soundEnabled]);

  const playErrorSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 200;
      oscillator.type = 'sawtooth';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (e) {
      // Audio not supported
    }
  }, [soundEnabled]);

  // ── Visual feedback ──────────────────────────────────────────
  const triggerSuccessFeedback = useCallback(() => {
    setFlashColor('green');
    setTimeout(() => setFlashColor(null), 150);

    playSuccessSound();

    if (vibrationEnabled && 'vibrate' in navigator) {
      navigator.vibrate(100);
    }

    setCounterBounce(true);
    setTimeout(() => setCounterBounce(false), 300);
  }, [playSuccessSound, vibrationEnabled]);

  const triggerDuplicateFeedback = useCallback(() => {
    if (redFlashTriggerRef.current) {
      redFlashTriggerRef.current();
    }

    playErrorSound();

    if (vibrationEnabled && 'vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }
  }, [playErrorSound, vibrationEnabled]);

  // Polling ref
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const processedBarcodesRef = useRef<Set<string>>(new Set());
  const redFlashTriggerRef = useRef<(() => void) | null>(null);
  const resolvedBarcodesRef = useRef<Set<string>>(new Set());

  // ── Load Session ──────────────────────────────────────────────
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`/api/session?token=${token}`);
        if (!res.ok) throw new Error('Session not found or expired');
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
        setError(err instanceof Error ? err.message : 'Failed to load session');
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

    if (processedBarcodesRef.current.has(barcode)) {
      triggerDuplicateFeedback();
      addErrorLog(`Barcode ${barcode}: Duplicate (ignored)`);
      return;
    }

    processedBarcodesRef.current.add(barcode);
    setScannedBarcodes(prev => new Map(prev).set(barcode, data));
    triggerSuccessFeedback();

    // Show undo toast
    setUndoBarcode(barcode);

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
        setError(result.error || 'Failed to complete scan');
      }
    } catch (err) {
      const msg = `Confirmation error: ${err instanceof Error ? err.message : String(err)}`;
      addErrorLog(msg);
      setError('Network error during confirmation');
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
      <div className="min-h-screen bg-gray-900 dark:bg-gray-900 flex items-center justify-center">
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
      <div className="min-h-screen bg-gray-900 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-red-900/30 border border-red-600 rounded-lg p-6 max-w-md text-center">
          <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-red-400 font-medium">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white text-sm"
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
      <div className="min-h-screen bg-gray-900 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-green-900/30 border border-green-600 rounded-lg p-6 max-w-md text-center animate-scaleIn">
          <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
          <h2 className="text-xl font-bold text-green-400 mb-2">Scan Complete!</h2>
          <p className="text-gray-300 text-sm mb-1">
            {scannedBarcodes.size} boxes scanned and submitted
          </p>
          <p className="text-gray-400 text-xs">
            Data has been sent to warehouse system. You can close this page.
          </p>
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
      <div className="min-h-screen bg-gray-900 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800/90 dark:bg-gray-800/90 backdrop-blur-md border border-gray-700 rounded-xl p-6 max-w-md text-center">
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
      <div className="min-h-screen bg-gray-900 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-300">Submitting scan data...</p>
        </div>
      </div>
    );
  }

  // ── Main Scanner UI ───────────────────────────────────────────
  const isReadyToConfirm = phase === 'ready_confirm' ||
    (scannedBarcodes.size >= boxesExpected && pendingOCR.size === 0 && allIssuesResolved);

  const canForceConfirm = scannedBarcodes.size < boxesExpected && scannedBarcodes.size > 0;

  return (
    <div className="min-h-screen bg-gray-900 dark:bg-gray-900 text-white dark:text-white flex flex-col">
      {/* ── Offline Banner ──────────────────────────────────── */}
      <OfflineBanner queueCount={offlineQueueCount} isSyncing={isSyncing} />

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="sticky top-0 z-50 bg-gray-800/90 dark:bg-gray-800/90 backdrop-blur-md border-b border-gray-700/50 dark:border-gray-700/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ProgressRing current={scannedBarcodes.size} total={boxesExpected} />
            <div>
              <h1 className="text-sm font-bold">
                <span
                  className={`${scannedBarcodes.size >= boxesExpected ? 'text-green-400' : 'text-white'} transition-transform duration-300`}
                  style={counterBounce ? { transform: 'scale(1.3)', display: 'inline-block' } : {}}
                >
                  {scannedBarcodes.size}
                </span>
                <span className="text-gray-500 mx-1">/</span>
                <span className="text-gray-400">{boxesExpected}</span>
                <span className="text-xs text-gray-500 ml-1.5">boxes</span>
              </h1>
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-500">
                  {session?.document_number ? `Doc: ${session.document_number}` : 'Scanning...'}
                </p>
                {session?.created_at && (
                  <SessionTimer createdAt={session.created_at} />
                )}
              </div>
            </div>
          </div>

          {/* Right side: status + settings */}
          <div className="flex items-center gap-2">
            {pendingOCR.size > 0 && (
              <span className="flex items-center gap-1 text-xs text-yellow-400">
                <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></div>
                OCR: {pendingOCR.size}
              </span>
            )}
            <SettingsPopover />
          </div>
        </div>

        {/* Progress bar (secondary) */}
        <div className="mt-2 bg-gray-700/50 rounded-full h-1">
          <div
            className={`h-1 rounded-full transition-all duration-500 ${scannedBarcodes.size >= boxesExpected ? 'bg-green-500' : 'bg-blue-500'}`}
            aria-label="Progress"
            style={{ width: `${boxesExpected > 0 ? Math.min(100, (scannedBarcodes.size / boxesExpected) * 100) : 0}%` }}
          ></div>
        </div>
      </div>

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

      {/* ── Scanning / Ready Confirm Phases ────────────────────── */}
      {(phase === 'scanning' || phase === 'ready_confirm') && (
        <>
          {/* Scanner camera (TOP) - fixed height ~50vh */}
          <div className="shrink-0">
            <SmartScanner
              onBarcodeDetected={handleBarcodeDetected}
              onManualCapture={handleManualCapture}
              scannedBarcodes={scannedBarcodes}
              ocrResults={ocrResults}
              onScannerTypeDetected={setScannerType}
              onDuplicateFlash={(triggerFn) => {
                redFlashTriggerRef.current = triggerFn;
              }}
              className="h-[50vh]"
            />
          </div>

          {/* Scanned list (BOTTOM) - scrollable */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <ScannedList
              scannedBarcodes={scannedBarcodes}
              ocrResults={ocrResults}
              ocrImageUrls={ocrImageUrls}
              pendingOCR={pendingOCR}
              onImageClick={setSelectedImage}
            />
          </div>
        </>
      )}

      {/* ── Footer: Action Buttons ────────────────────────────── */}
      <div className="sticky bottom-0 bg-gray-800/90 dark:bg-gray-800/90 backdrop-blur-md border-t border-gray-700/50 dark:border-gray-700/50 p-4 space-y-2">
        {/* Force Confirm button */}
        {canForceConfirm && phase === 'scanning' && (
          <button
            onClick={() => setShowForceConfirm(true)}
            className="w-full py-3 bg-yellow-600 hover:bg-yellow-700 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Zap className="w-4 h-4" />
            Force Confirm ({boxesExpected - scannedBarcodes.size} boxes remaining)
          </button>
        )}

        {/* Swipe to confirm (when ready) */}
        {isReadyToConfirm && (
          <SwipeConfirm
            onConfirm={handleConfirm}
            label="Slide to Confirm All Scans"
          />
        )}

        {/* Scanned barcodes summary */}
        {scannedBarcodes.size > 0 && phase === 'scanning' && (
          <p className="text-center text-xs text-gray-500">
            {scannedBarcodes.size} box{scannedBarcodes.size !== 1 ? 'es' : ''} scanned
            {pendingOCR.size > 0 ? ` \u00B7 ${pendingOCR.size} OCR pending` : ''}
          </p>
        )}
      </div>

      {/* ── Undo Toast ────────────────────────────────────────── */}
      {undoBarcode && (
        <UndoToast
          barcode={undoBarcode}
          onUndo={() => handleUndoScan(undoBarcode)}
          onDismiss={() => setUndoBarcode(null)}
        />
      )}

      {/* ── Invoice FAB (Bottom-Left) ─────────────────────────── */}
      {session && (phase === 'scanning' || phase === 'ready_confirm') && (
        <button
          onClick={() => setShowInvoiceDrawer(true)}
          className="fixed bottom-24 left-4 z-50 w-12 h-12 rounded-full shadow-2xl flex items-center justify-center bg-blue-600 hover:bg-blue-700 transition-all active:scale-95"
        >
          <FileText className="w-5 h-5 text-white" />
        </button>
      )}

      {/* ── OCR Circular FAB ──────────────────────────────────── */}
      {ocrImageUrls.size > 0 && (
        <button
          onClick={() => setShowOCRDrawer(!showOCRDrawer)}
          className="fixed bottom-24 left-20 z-50 w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all active:scale-95"
          style={{
            background: pendingOCR.size > 0
              ? 'linear-gradient(135deg, #7c3aed, #3b82f6)'
              : 'linear-gradient(135deg, #059669, #10b981)',
          }}
        >
          <svg className="absolute inset-0 w-14 h-14 -rotate-90" viewBox="0 0 56 56">
            <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
            <circle
              cx="28" cy="28" r="24" fill="none"
              stroke={pendingOCR.size > 0 ? '#a78bfa' : '#34d399'}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 24}`}
              strokeDashoffset={`${2 * Math.PI * 24 * (1 - (ocrResults.size / Math.max(ocrImageUrls.size, 1)))}`}
              className="transition-all duration-700"
            />
          </svg>
          <div className="relative z-10 text-center">
            {pendingOCR.size > 0 ? (
              <Cpu className="w-5 h-5 text-white mx-auto animate-pulse" />
            ) : (
              <Check className="w-5 h-5 text-white mx-auto" />
            )}
            <div className="text-white text-[9px] font-bold leading-none">
              {ocrResults.size}/{ocrImageUrls.size}
            </div>
          </div>
        </button>
      )}

      {/* ── Photo Gallery FAB ────────────────────────────────── */}
      {ocrImageUrls.size > 0 && (
        <button
          onClick={() => setShowPhotoGallery(true)}
          className="fixed bottom-24 right-16 z-50 w-10 h-10 rounded-full shadow-lg flex items-center justify-center bg-purple-600 hover:bg-purple-700 transition-all active:scale-95"
        >
          <ImageIcon className="w-4 h-4 text-white" />
        </button>
      )}

      {/* ── Debug Toggle Button (Bottom-Right) ──────────────── */}
      {errorLog.length > 0 && (
        <button
          onClick={() => { setShowDebugPanel(!showDebugPanel); setShowOCRDrawer(false); }}
          className="fixed bottom-24 right-4 z-50 bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-full shadow-lg text-xs font-bold flex items-center gap-2"
        >
          <Bug className="w-3.5 h-3.5" />
          {showDebugPanel ? 'Hide' : 'Debug'} ({errorLog.length})
          {scannerType && (
            <span className="text-[10px] opacity-80">
              {scannerType === 'native' ? 'Native' : 'Software'}
            </span>
          )}
        </button>
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

      {/* ── OCR Details Bottom Drawer ──────────────────────────── */}
      {showOCRDrawer && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900/95 dark:bg-gray-900/95 backdrop-blur-lg border-t-2 border-purple-500 shadow-2xl animate-slideInUp" style={{ maxHeight: '55vh' }}>
          <div className="flex justify-between items-center p-3 border-b border-gray-700 bg-gradient-to-r from-purple-900 to-blue-900">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-purple-300" />
              <span className="text-white font-bold text-sm">AI OCR Results</span>
              <span className="text-purple-300 text-xs ml-1">
                {ocrResults.size}/{ocrImageUrls.size} complete
              </span>
            </div>
            <button
              onClick={() => setShowOCRDrawer(false)}
              className="text-gray-400 hover:text-white p-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="overflow-y-auto p-3 space-y-3" style={{ maxHeight: 'calc(55vh - 50px)' }}>
            {Array.from(ocrImageUrls.entries()).map(([barcode, imageUrl]) => {
              const result = ocrResults.get(barcode);
              const isPending = pendingOCR.has(barcode);
              return (
                <div key={barcode} className="bg-black/40 rounded-xl border border-gray-700 overflow-hidden">
                  <div className="flex gap-3 p-3">
                    <div
                      className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-gray-800 cursor-pointer hover:ring-2 hover:ring-purple-500 transition-all relative group"
                      onClick={() => setSelectedImage(imageUrl)}
                    >
                      <img
                        src={imageUrl}
                        alt={`Box ${barcode.slice(-6)}`}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <Search className="w-4 h-4 text-white" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-purple-300 text-xs font-mono">Box #{barcode.slice(-6)}</span>
                        {result ? (
                          <span className="flex items-center gap-1 text-green-400 text-xs px-1.5 py-0.5 bg-green-900/50 rounded-full">
                            <Check className="w-3 h-3" /> Done
                          </span>
                        ) : isPending ? (
                          <span className="flex items-center gap-1 text-yellow-400 text-xs px-1.5 py-0.5 bg-yellow-900/50 rounded-full animate-pulse">
                            <Clock className="w-3 h-3" /> Analyzing
                          </span>
                        ) : null}
                      </div>
                      {result ? (
                        <div className="space-y-0.5">
                          <div className="text-green-300 text-sm font-semibold truncate">
                            {result.product_name || 'Product unclear'}
                          </div>
                          <div className="text-blue-200 text-xs">
                            {result.weight_kg ? `${result.weight_kg} kg` : 'No weight'}
                            {result.expiry_date ? ` \u00B7 Exp: ${result.expiry_date}` : ''}
                          </div>
                        </div>
                      ) : (
                        <div className="text-yellow-200 text-xs">Gemini analyzing image...</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Debug Panel (Bottom Drawer) ──────────────────────── */}
      {showDebugPanel && errorLog.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900/95 dark:bg-gray-900/95 backdrop-blur-lg border-t-2 border-red-500 shadow-2xl animate-slideInUp" style={{ maxHeight: '40vh' }}>
          <div className="flex justify-between items-center p-3 border-b border-gray-700 bg-gray-800/90 backdrop-blur-md">
            <div className="flex items-center gap-2">
              <Bug className="w-4 h-4 text-red-400" />
              <span className="text-white font-bold text-sm">Debug Log</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const text = errorLog.map(e => `${e.time}: ${e.msg}`).join('\n');
                  navigator.clipboard.writeText(text);
                  alert('Debug log copied!');
                }}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg flex items-center gap-1"
              >
                <ClipboardList className="w-3 h-3" /> Copy All
              </button>
              <button
                onClick={() => setShowDebugPanel(false)}
                className="text-gray-400 hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          <div className="overflow-y-auto p-3 space-y-1" style={{ maxHeight: 'calc(40vh - 60px)' }}>
            {errorLog.map((entry, i) => (
              <div key={i} className="text-xs bg-black/50 p-2 rounded border border-gray-800">
                <span className="text-gray-500">[{entry.time}]</span>
                <div className={`mt-1 ${entry.msg.includes('DUPLICATE') || entry.msg.includes('warning') ? 'text-red-400' : entry.msg.includes('Uploaded') || entry.msg.includes('Saved') ? 'text-green-400' : 'text-yellow-300'}`}>
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
    <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-end xl:items-center justify-center animate-fadeIn">
      <div className="bg-gray-800/95 dark:bg-gray-800/95 backdrop-blur-md w-full max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl xl:rounded-2xl p-4 space-y-4 animate-slideInUp">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            <h3 className="text-lg font-bold text-yellow-400">
              Manual Entry ({remaining} boxes)
            </h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-gray-400">
          Enter details for the remaining {remaining} unscanned boxes.
        </p>

        {entries.map((entry, idx) => (
          <div key={idx} className="bg-gray-900/80 rounded-xl p-3 space-y-2">
            <p className="text-sm font-medium text-gray-300">Box #{boxesScanned + idx + 1}</p>

            <select
              value={entry.item_name}
              onChange={e => {
                const updated = [...entries];
                updated[idx].item_name = e.target.value;
                setEntries(updated);
              }}
              className="w-full p-2 bg-gray-800 border border-gray-700 rounded-lg text-sm"
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
              className="w-full p-2 bg-gray-800 border border-gray-700 rounded-lg text-sm"
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
              className="w-full p-2 bg-gray-800 border border-gray-700 rounded-lg text-sm"
            />
          </div>
        ))}

        <button
          onClick={handleSubmitAll}
          disabled={!allFilled || submitting}
          className="w-full py-3 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-xl text-sm font-bold transition-colors"
        >
          {submitting ? 'Submitting...' : `Submit ${remaining} Manual Entries`}
        </button>
      </div>
    </div>
  );
}
