'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { ItemProgress } from '@/components/progress/ItemProgress';
import { ScannedList } from '@/components/progress/ScannedList';
import { useScanStore } from '@/stores/scan-store';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';
import { scannerAPI } from '@/lib/api';
import type { ScanSession, ParsedBarcode } from '@/types';

export default function ScannerPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [session, setSession] = useState<ScanSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { scannedBarcodes, addScan, isDuplicate, setScanning, setError: setStoreError } = useScanStore();

  // Load session
  useEffect(() => {
    async function loadSession() {
      try {
        const data = await scannerAPI.getSession(token);
        if (data.status !== 'ACTIVE') {
          throw new Error('Session is not active');
        }
        setSession(data);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to load session';
        setError(errorMsg);
        setStoreError(errorMsg);
      } finally {
        setLoading(false);
      }
    }
    loadSession();
  }, [token, setStoreError]);

  // Handle barcode detection
  const handleBarcodeDetected = useCallback(async (barcode: string, data: ParsedBarcode) => {
    if (isDuplicate(barcode)) {
      setShowDuplicateWarning(true);
      setTimeout(() => setShowDuplicateWarning(false), 2000);
      // Vibrate to indicate duplicate
      if (navigator.vibrate) {
        navigator.vibrate([100, 50, 100]);
      }
      return;
    }

    setIsSubmitting(true);

    try {
      // Submit to API for parsing and validation
      const result = await scannerAPI.submitScan({
        token,
        barcode,
        parsed_data: data,
        detected_at: new Date().toISOString()
      });

      if (result.success && !result.is_duplicate && result.matched_item) {
        addScan(barcode, data, result.matched_item);
        setScanning(false);

        // Refresh session data to get updated scanned_items
        const updatedSession = await scannerAPI.getSession(token);
        if (updatedSession) {
          setSession(updatedSession);
        }

        // Success vibration
        if (navigator.vibrate) {
          navigator.vibrate(100);
        }
      } else if (result.is_duplicate) {
        setShowDuplicateWarning(true);
        setTimeout(() => setShowDuplicateWarning(false), 2000);
      } else if (result.error) {
        setError(result.error);
        setTimeout(() => setError(null), 3000);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to submit scan';
      setError(errorMsg);
      setTimeout(() => setError(null), 3000);
    } finally {
      setIsSubmitting(false);
    }
  }, [token, isDuplicate, addScan, setScanning]);

  // Handle completion
  const handleComplete = async () => {
    if (!session) return;

    const totalWeightScanned = Object.values(session.scanned_items || {}).reduce(
      (sum: number, item: any) => sum + (item.scanned_weight || 0),
      0
    );
    const totalWeightExpected = session.invoice_items.reduce(
      (sum: number, item: any) => sum + item.quantity_kg,
      0
    );

    if (totalWeightScanned < totalWeightExpected * 0.9) {
      const confirmed = confirm(
        `You've only scanned ${totalWeightScanned.toFixed(2)} kg of ${totalWeightExpected.toFixed(2)} kg expected. Are you sure you want to complete?`
      );
      if (!confirmed) return;
    }

    try {
      await scannerAPI.completeSession({ token });
      router.push(`/complete/${token}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to complete session';
      setError(errorMsg);
      setTimeout(() => setError(null), 3000);
    }
  };

  // Get scanned items for display
  const scannedList = Array.from(scannedBarcodes.entries()).map(([barcode, data]) => ({
    barcode,
    data,
    time: new Date().toISOString()
  }));

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>Loading scanner...</p>
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => window.close()}
            className="px-4 py-2 bg-gray-700 rounded hover:bg-gray-600"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <header className="p-4 flex justify-between items-center bg-gray-800">
        <h1 className="text-xl font-bold">📦 Barcode Scanner</h1>
        <button
          onClick={() => window.close()}
          className="text-gray-400 hover:text-white text-2xl"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      {/* Scanner View */}
      <div className="relative h-96 bg-black">
        <SmartScanner
          onBarcodeDetected={handleBarcodeDetected}
          scannedBarcodes={scannedBarcodes}
          onError={(err) => setError(err)}
        />
      </div>

      {/* Duplicate Warning */}
      {showDuplicateWarning && (
        <div className="absolute top-20 left-4 right-4 bg-yellow-600 text-white p-3 rounded-lg shadow-lg z-10">
          <p className="text-sm font-medium">⚠️ Barcode already scanned!</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mx-4 mt-4 bg-red-600 text-white p-3 rounded-lg">
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Progress Section */}
      <div className="flex-1 overflow-y-auto p-4">
        {session && (
          <ItemProgress
            items={session.invoice_items}
            scanned={Object.values(session.scanned_items || {})}
          />
        )}
        <div className="mt-4">
          <ScannedList scanned={scannedList} />
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 bg-gray-800 flex gap-2">
        <button
          onClick={handleComplete}
          disabled={isSubmitting || !session || scannedBarcodes.size === 0}
          className="flex-1 bg-green-600 py-3 rounded-lg font-medium hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting ? 'Processing...' : '✓ Complete Scanning'}
        </button>
      </div>
    </div>
  );
}
