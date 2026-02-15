'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { BoxDetailModal } from '@/components/issue/BoxDetailModal';
import { IssuedBoxList } from '@/components/issue/IssuedBoxList';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import type {
  ParsedBarcode,
  BoxStickerOCR,
  ScanSession,
  BoxLookupResult,
  IssuedBox,
} from '@/types';

type IssuePhase =
  | 'loading'
  | 'scanning'
  | 'box_detail'
  | 'completing'
  | 'complete'
  | 'error';

export default function IssuePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [session, setSession] = useState<ScanSession | null>(null);
  const [phase, setPhase] = useState<IssuePhase>('loading');
  const [error, setError] = useState<string | null>(null);

  // Scan tracking (needed for SmartScanner dedup)
  const [scannedBarcodes, setScannedBarcodes] = useState<Map<string, ParsedBarcode>>(new Map());
  const [ocrResults] = useState<Map<string, BoxStickerOCR>>(new Map());

  // Box detail state
  const [currentBox, setCurrentBox] = useState<BoxLookupResult['box'] | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  // Issued boxes
  const [issuedBoxes, setIssuedBoxes] = useState<IssuedBox[]>([]);

  // Feedback
  const [flashColor, setFlashColor] = useState<'green' | 'red' | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Refs
  const lookupInProgress = useRef(false);

  // Audio feedback
  const playSuccessSound = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }, []);

  const playErrorSound = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 300;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch {}
  }, []);

  const showToast = useCallback((msg: string, type: 'success' | 'error') => {
    setToastMessage(msg);
    setFlashColor(type === 'success' ? 'green' : 'red');
    setTimeout(() => {
      setToastMessage(null);
      setFlashColor(null);
    }, 2500);
  }, []);

  // Load session
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch(`/api/session?token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          setError('Session not found or expired');
          setPhase('error');
          return;
        }
        const data: ScanSession = await res.json();

        if (data.operation_type !== 'ISSUE') {
          setError('This is not an issue session');
          setPhase('error');
          return;
        }

        if (data.status === 'COMPLETED') {
          setSession(data);
          setIssuedBoxes(data.issued_boxes || []);
          setPhase('complete');
          return;
        }

        setSession(data);
        setIssuedBoxes(data.issued_boxes || []);

        // Rebuild scannedBarcodes from previously issued boxes (for dedup in SmartScanner)
        const existingBarcodes = new Map<string, ParsedBarcode>();
        for (const box of data.issued_boxes || []) {
          existingBarcodes.set(box.barcode, {
            type: 'id-only',
            sku: box.sku,
            weight: 0,
            expiry: '',
            raw_barcode: box.barcode,
            expiry_source: 'ocr_required',
          });
        }
        setScannedBarcodes(existingBarcodes);
        setPhase('scanning');
      } catch (err) {
        console.error('Failed to load session:', err);
        setError('Failed to load session');
        setPhase('error');
      }
    }
    loadSession();
  }, [token]);

  // Handle barcode detected from scanner
  const handleBarcodeDetected = useCallback(
    async (barcode: string, _data: ParsedBarcode) => {
      if (phase !== 'scanning' || lookupInProgress.current) return;

      // Check local dedup
      if (scannedBarcodes.has(barcode)) {
        playErrorSound();
        showToast('Already issued in this session', 'error');
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        return;
      }

      lookupInProgress.current = true;

      try {
        const res = await fetch('/api/issue-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, barcode }),
        });

        const result: BoxLookupResult = await res.json();

        if (!result.found || !result.box) {
          playErrorSound();
          if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

          if (result.error === 'not_found') {
            showToast('Box not found in inventory', 'error');
          } else if (result.error === 'already_issued') {
            showToast(result.message || 'Box already issued', 'error');
          } else {
            showToast(result.message || 'Lookup failed', 'error');
          }
          return;
        }

        // Found and available - show detail modal
        playSuccessSound();
        if (navigator.vibrate) navigator.vibrate(100);
        setCurrentBox(result.box);
        setPhase('box_detail');
      } catch (err) {
        console.error('Lookup error:', err);
        playErrorSound();
        showToast('Failed to look up box', 'error');
      } finally {
        lookupInProgress.current = false;
      }
    },
    [phase, scannedBarcodes, token, playSuccessSound, playErrorSound, showToast]
  );

  // Confirm issue
  const handleConfirmIssue = useCallback(async () => {
    if (!currentBox || isConfirming) return;

    setIsConfirming(true);

    try {
      const res = await fetch('/api/issue-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          box_record_id: currentBox.record_id,
          batch_id: currentBox.batch_id,
          barcode: currentBox.barcode,
          weight: currentBox.weight,
          sku: currentBox.sku,
          item_name: currentBox.item_name,
          supplier: currentBox.supplier,
          invoice_number: currentBox.invoice_number,
          expiry: currentBox.expiry,
        }),
      });

      const result = await res.json();

      if (!result.success) {
        playErrorSound();
        showToast(result.error || 'Failed to issue box', 'error');
        setIsConfirming(false);
        return;
      }

      // Add to issued list
      const newIssuedBox: IssuedBox = {
        barcode: currentBox.barcode,
        sku: currentBox.sku,
        item_name: currentBox.item_name,
        weight: currentBox.weight,
        expiry: currentBox.expiry,
        supplier: currentBox.supplier,
        invoice_number: currentBox.invoice_number,
        box_record_id: currentBox.record_id,
        batch_id: currentBox.batch_id,
        transaction_id: result.transaction_id,
        issued_at: new Date().toISOString(),
      };

      setIssuedBoxes((prev) => [...prev, newIssuedBox]);

      // Add to scannedBarcodes for dedup
      setScannedBarcodes((prev) => {
        const next = new Map(prev);
        next.set(currentBox.barcode, {
          type: 'id-only',
          sku: currentBox.sku,
          weight: 0,
          expiry: '',
          raw_barcode: currentBox.barcode,
          expiry_source: 'ocr_required',
        });
        return next;
      });

      playSuccessSound();
      showToast(`Issued: ${currentBox.item_name} (${currentBox.weight} kg)`, 'success');

      // Back to scanning
      setCurrentBox(null);
      setIsConfirming(false);
      setPhase('scanning');
    } catch (err) {
      console.error('Confirm error:', err);
      playErrorSound();
      showToast('Failed to issue box', 'error');
      setIsConfirming(false);
    }
  }, [currentBox, isConfirming, token, playSuccessSound, playErrorSound, showToast]);

  // Cancel box detail
  const handleCancelDetail = useCallback(() => {
    setCurrentBox(null);
    setPhase('scanning');
  }, []);

  // Complete session
  const handleComplete = useCallback(async () => {
    if (issuedBoxes.length === 0) {
      showToast('No boxes issued yet', 'error');
      return;
    }

    setPhase('completing');

    try {
      const res = await fetch('/api/issue-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const result = await res.json();

      if (!result.success) {
        showToast(result.error || 'Failed to complete', 'error');
        setPhase('scanning');
        return;
      }

      setPhase('complete');
    } catch (err) {
      console.error('Complete error:', err);
      showToast('Failed to complete session', 'error');
      setPhase('scanning');
    }
  }, [issuedBoxes.length, token, showToast]);

  // --- RENDER ---

  // Loading
  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4" />
          <p>Loading session...</p>
        </div>
      </div>
    );
  }

  // Error
  if (phase === 'error') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
        <div className="text-center">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-4" />
          <p className="mb-2 text-lg font-medium">Session Error</p>
          <p className="text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  // Complete
  if (phase === 'complete') {
    const totalWeight = issuedBoxes.reduce((s, b) => s + b.weight, 0);
    return (
      <div className="min-h-screen bg-gray-900 text-white p-4">
        <div className="max-w-md mx-auto">
          <div className="text-center mb-8">
            <CheckCircle className="w-16 h-16 text-green-400 mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Issue Complete!</h1>
            <p className="text-gray-400">
              {issuedBoxes.length} box{issuedBoxes.length !== 1 ? 'es' : ''} issued,{' '}
              {totalWeight.toFixed(2)} kg total
            </p>
          </div>

          <div className="bg-gray-800 rounded-lg p-4 mb-6">
            <h2 className="text-lg font-medium mb-4">Summary</h2>
            <div className="space-y-2">
              {issuedBoxes.map((box, idx) => (
                <div
                  key={idx}
                  className="flex justify-between items-center border-b border-gray-700 pb-2 last:border-0"
                >
                  <span className="text-white truncate mr-2">{box.item_name}</span>
                  <span className="text-green-400 font-medium whitespace-nowrap">
                    {box.weight} kg
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4 mb-6">
            <p className="text-sm">
              <strong>Done!</strong> Return to Telegram to see the confirmation.
              You can undo this operation from the Telegram chat.
            </p>
          </div>

          <button
            onClick={() => window.close()}
            className="w-full bg-gray-700 py-3 rounded-lg font-medium hover:bg-gray-600 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // Completing (spinner)
  if (phase === 'completing') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-400 mx-auto mb-4" />
          <p>Completing issue session...</p>
        </div>
      </div>
    );
  }

  // Scanning / Box Detail
  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Flash overlay */}
      {flashColor && (
        <div
          className={`fixed inset-0 z-40 pointer-events-none transition-opacity duration-300 ${
            flashColor === 'green' ? 'bg-green-500/20' : 'bg-red-500/20'
          }`}
        />
      )}

      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg text-sm max-w-xs text-center">
          {toastMessage}
        </div>
      )}

      {/* Header */}
      <div className="bg-gray-800 p-4 flex justify-between items-center">
        <div>
          <h1 className="text-lg font-bold">Issue to Production</h1>
          <p className="text-gray-400 text-sm">Scan box barcodes to issue</p>
        </div>
        <button
          onClick={handleComplete}
          disabled={issuedBoxes.length === 0}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            issuedBoxes.length > 0
              ? 'bg-green-600 hover:bg-green-500 text-white'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          }`}
        >
          Done ({issuedBoxes.length})
        </button>
      </div>

      {/* Scanner */}
      <div className="flex-1 relative">
        <SmartScanner
          onBarcodeDetected={handleBarcodeDetected}
          scannedBarcodes={scannedBarcodes}
          ocrResults={ocrResults}
        />
      </div>

      {/* Issued boxes list */}
      <div className="p-4">
        <IssuedBoxList issuedBoxes={issuedBoxes} />
      </div>

      {/* Box detail modal */}
      {phase === 'box_detail' && currentBox && (
        <BoxDetailModal
          box={currentBox}
          onConfirm={handleConfirmIssue}
          onCancel={handleCancelDetail}
          isLoading={isConfirming}
        />
      )}
    </div>
  );
}
