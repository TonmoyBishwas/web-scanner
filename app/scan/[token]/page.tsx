'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { ItemProgress, OCRStatusIndicator } from '@/components/progress/ItemProgress';
import { ScannedList } from '@/components/progress/ScannedList';
import { useScanStore } from '@/stores/scan-store';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';
import { scannerAPI } from '@/lib/api';
import { uploadBoxImage } from '@/lib/cloudinary';
import type { ScanSession, ParsedBarcode, BoxStickerOCR } from '@/types';

export default function ScannerPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [session, setSession] = useState<ScanSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ocrResults, setOcrResults] = useState<Map<string, BoxStickerOCR>>(new Map());
  const [ocrPending, setOcrPending] = useState<Set<string>>(new Set());
  const [showManualEntry, setShowManualEntry] = useState(false);

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

  // Handle barcode detection - NEW: Image capture happens immediately
  const handleBarcodeDetected = useCallback(async (barcode: string, data: ParsedBarcode, imageData?: string) => {
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
      // Image is now REQUIRED - must be captured before this point
      if (!imageData) {
        throw new Error('Image capture failed. Please try again or use manual entry.');
      }

      // 1. Upload image to Cloudinary with document_number
      const documentNumber = session?.document_number || '';
      let imageUrl = '';
      let publicId = '';

      try {
        const uploadResult = await uploadBoxImage(imageData, barcode, {
          document_number: documentNumber,
          image_type: 'box'
        });
        imageUrl = uploadResult.secure_url;
        publicId = uploadResult.public_id;
        console.log('[Cloudinary] Image uploaded:', imageUrl, 'public_id:', publicId);
      } catch (uploadError) {
        console.error('[Cloudinary] Upload failed:', uploadError);
        throw new Error('Failed to upload image. Please try again.');
      }

      // 2. Submit scan with image URL
      const result = await scannerAPI.submitScan({
        token,
        barcode,
        parsed_data: data,
        image_url: imageUrl,
        image_public_id: publicId,
        document_number: documentNumber,
        detected_at: new Date().toISOString(),
        scan_method: 'barcode'
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

        // Trigger OCR in background (all data comes from OCR now)
        triggerOCR(barcode, imageUrl);
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
  }, [token, session, isDuplicate, addScan, setScanning]);

  // Trigger OCR after barcode scan (background process)
  const triggerOCR = useCallback(async (barcode: string, imageUrl: string) => {
    // Don't process OCR if already done or pending
    if (ocrResults.has(barcode) || ocrPending.has(barcode)) {
      return;
    }

    // Mark as pending
    setOcrPending(prev => new Set(prev).add(barcode));

    // Fire and forget - don't await
    (async () => {
      try {
        // Submit OCR with Cloudinary URL
        const result = await scannerAPI.submitOCR({
          token,
          image_url: imageUrl,
          barcode
        });

        if (result.success && result.ocr_data) {
          console.log('[OCR] Result received for', barcode, result.ocr_data);
          setOcrResults(prev => new Map(prev).set(barcode, result.ocr_data!));

          // Refresh session to get updated weights
          const updatedSession = await scannerAPI.getSession(token);
          if (updatedSession) {
            setSession(updatedSession);
          }
        }
      } catch (err) {
        console.error('[OCR] Failed:', err);
      } finally {
        setOcrPending(prev => {
          const newSet = new Set(prev);
          newSet.delete(barcode);
          return newSet;
        });
      }
    })();
  }, [token, ocrResults, ocrPending]);

  // Handle manual capture button (scan without barcode)
  const handleManualCapture = useCallback(async (imageData: string) => {
    setIsSubmitting(true);

    try {
      // Generate a temporary barcode ID for manual capture
      const tempBarcode = `manual-${Date.now()}`;

      // Upload to Cloudinary
      const documentNumber = session?.document_number || '';
      const uploadResult = await uploadBoxImage(imageData, tempBarcode, {
        document_number: documentNumber,
        image_type: 'box'
      });

      // Submit as manual capture
      const result = await scannerAPI.submitScan({
        token,
        barcode: tempBarcode,
        image_url: uploadResult.secure_url,
        image_public_id: uploadResult.public_id,
        document_number: documentNumber,
        detected_at: new Date().toISOString(),
        scan_method: 'manual_capture'
      });

      if (result.success) {
        // Trigger OCR to try to identify the item
        triggerOCR(tempBarcode, uploadResult.secure_url);

        // Refresh session
        const updatedSession = await scannerAPI.getSession(token);
        if (updatedSession) {
          setSession(updatedSession);
        }

        if (navigator.vibrate) {
          navigator.vibrate(100);
        }
      } else if (result.error) {
        setError(result.error);
        setTimeout(() => setError(null), 3000);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to capture';
      setError(errorMsg);
      setTimeout(() => setError(null), 3000);
    } finally {
      setIsSubmitting(false);
    }
  }, [token, session, triggerOCR]);

  // Poll for OCR results from session (in case OCR completed while page was inactive)
  useEffect(() => {
    if (!session) return;

    const interval = setInterval(async () => {
      try {
        const updatedSession = await scannerAPI.getSession(token);
        if (updatedSession) {
          // Check for any completed OCR results
          const newOcrResults = new Map(ocrResults);
          let hasUpdates = false;

          for (const entry of updatedSession.scanned_barcodes) {
            if (entry.ocr_status === 'complete' && entry.ocr_data && !ocrResults.has(entry.barcode)) {
              newOcrResults.set(entry.barcode, entry.ocr_data);
              hasUpdates = true;
            }
          }

          if (hasUpdates) {
            setOcrResults(newOcrResults);
            setSession(updatedSession); // Update session with OCR data
          }
        }
      } catch (err) {
        // Ignore polling errors
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [session, token, ocrResults]);

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
        <div>
          <h1 className="text-xl font-bold">📦 Barcode Scanner</h1>
          {session?.document_number && (
            <p className="text-xs text-gray-400">Invoice: {session.document_number}</p>
          )}
        </div>
        <button
          onClick={() => setShowManualEntry(!showManualEntry)}
          className="px-3 py-1 bg-blue-600 rounded text-sm hover:bg-blue-700"
        >
          {showManualEntry ? '📷 Scan' : '✏️ Manual Entry'}
        </button>
      </header>

      {showManualEntry ? (
        // Manual Entry Form
        <div className="flex-1 p-4">
          <ManualEntryForm
            invoiceItems={session?.invoice_items || []}
            onSubmit={async (data) => {
              setIsSubmitting(true);
              try {
                const documentNumber = session?.document_number || '';
                const result = await scannerAPI.submitManualEntry({
                  ...data,
                  token,
                  document_number: documentNumber
                });

                if (result.success) {
                  // Refresh session
                  const updatedSession = await scannerAPI.getSession(token);
                  if (updatedSession) {
                    setSession(updatedSession);
                  }
                  setShowManualEntry(false);
                } else if (result.error) {
                  setError(result.error);
                  setTimeout(() => setError(null), 3000);
                }
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : 'Failed to submit';
                setError(errorMsg);
                setTimeout(() => setError(null), 3000);
              } finally {
                setIsSubmitting(false);
              }
            }}
            onCancel={() => setShowManualEntry(false)}
            scannedItems={session?.scanned_items || {}}
          />
        </div>
      ) : (
        <>
          {/* Scanner View */}
          <div className="relative h-96 bg-black">
            <SmartScanner
              onBarcodeDetected={handleBarcodeDetected}
              onManualCapture={handleManualCapture}
              scannedBarcodes={scannedBarcodes}
              ocrResults={ocrResults}
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
            {/* OCR Status Indicator */}
            <OCRStatusIndicator
              ocrPending={ocrPending}
              ocrResults={ocrResults}
            />

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
        </>
      )}
    </div>
  );
}

// Manual Entry Form Component
interface ManualEntryFormProps {
  invoiceItems: Array<{
    item_index: number;
    item_name_english: string;
    expected_boxes: number;
  }>;
  onSubmit: (data: {
    item_index: number;
    weight: number;
    expiry: string;
    notes?: string;
  }) => void;
  onCancel: () => void;
  scannedItems: Record<string, {
    scanned_count: number;
    expected_boxes: number;
  }>;
}

function ManualEntryForm({ invoiceItems, onSubmit, onCancel, scannedItems }: ManualEntryFormProps) {
  const [selectedItem, setSelectedItem] = useState<number | null>(null);
  const [weight, setWeight] = useState('');
  const [expiry, setExpiry] = useState('');
  const [notes, setNotes] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedItem === null) return;

    onSubmit({
      item_index: selectedItem,
      weight: parseFloat(weight),
      expiry,
      notes: notes || undefined
    });

    // Reset form
    setSelectedItem(null);
    setWeight('');
    setExpiry('');
    setNotes('');
  };

  // Get remaining boxes for each item
  const getRemainingBoxes = (itemIndex: number) => {
    const item = invoiceItems.find(i => i.item_index === itemIndex);
    const scanned = scannedItems[itemIndex]?.scanned_count || 0;
    return item ? item.expected_boxes - scanned : 0;
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-xl font-bold mb-4">✏️ Manual Entry</h2>

      {/* Select Item */}
      <div>
        <label className="block text-sm font-medium mb-2">Select Item *</label>
        <select
          value={selectedItem || ''}
          onChange={(e) => setSelectedItem(Number(e.target.value))}
          className="w-full p-3 bg-gray-800 rounded-lg border border-gray-700"
          required
        >
          <option value="">-- Select an item --</option>
          {invoiceItems.map((item) => {
            const remaining = getRemainingBoxes(item.item_index);
            return (
              <option
                key={item.item_index}
                value={item.item_index}
                disabled={remaining <= 0}
              >
                {item.item_name_english} (Remaining: {remaining})
              </option>
            );
          })}
        </select>
      </div>

      {/* Weight */}
      <div>
        <label className="block text-sm font-medium mb-2">Weight (kg) *</label>
        <input
          type="number"
          step="0.01"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          className="w-full p-3 bg-gray-800 rounded-lg border border-gray-700"
          placeholder="e.g., 5.25"
          required
        />
      </div>

      {/* Expiry Date */}
      <div>
        <label className="block text-sm font-medium mb-2">Expiry Date (DD/MM/YYYY) *</label>
        <input
          type="text"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="w-full p-3 bg-gray-800 rounded-lg border border-gray-700"
          placeholder="e.g., 29/07/2026"
          pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}"
          required
        />
      </div>

      {/* Notes */}
      <div>
        <label className="block text-sm font-medium mb-2">Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full p-3 bg-gray-800 rounded-lg border border-gray-700"
          rows={2}
          placeholder="Any additional notes..."
        />
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 bg-gray-700 py-3 rounded-lg font-medium hover:bg-gray-600"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="flex-1 bg-blue-600 py-3 rounded-lg font-medium hover:bg-blue-700"
        >
          Add Box
        </button>
      </div>
    </form>
  );
}
