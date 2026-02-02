'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { scannerAPI } from '@/lib/api';
import type { ScanSession } from '@/types';

export default function CompletePage() {
  const params = useParams();
  const token = params.token as string;

  const [session, setSession] = useState<ScanSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSession() {
      try {
        const data = await scannerAPI.getSession(token);
        setSession(data);
      } catch (err) {
        console.error('Failed to load session:', err);
      } finally {
        setLoading(false);
      }
    }
    loadSession();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="mb-4">Session not found</p>
        </div>
      </div>
    );
  }

  const scannedItems = Object.values(session.scanned_items || {});
  const totalScans = session.scanned_barcodes?.length || 0;
  const totalWeight = scannedItems.reduce((sum, item) => sum + item.scanned_weight, 0);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-md mx-auto">
        {/* Success Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-4">✅</div>
          <h1 className="text-2xl font-bold mb-2">Scanning Complete!</h1>
          <p className="text-gray-400">
            Return to Telegram to confirm and save your items.
          </p>
        </div>

        {/* Summary */}
        <div className="bg-gray-800 rounded-lg p-4 mb-6">
          <h2 className="text-lg font-medium mb-4">Summary</h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Total Boxes Scanned:</span>
              <span className="font-medium">{totalScans}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Total Weight:</span>
              <span className="font-medium">{totalWeight.toFixed(2)} kg</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Items:</span>
              <span className="font-medium">{scannedItems.length}</span>
            </div>
          </div>
        </div>

        {/* Items List */}
        <div className="bg-gray-800 rounded-lg p-4 mb-6">
          <h2 className="text-lg font-medium mb-4">Scanned Items</h2>
          <div className="space-y-3">
            {scannedItems.map((item) => {
              const percentage = (item.scanned_weight / item.expected_weight) * 100;
              const isComplete = item.scanned_weight >= item.expected_weight;

              return (
                <div key={item.item_index} className="border-b border-gray-700 pb-3 last:border-0">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-medium">{item.item_name}</span>
                    {isComplete && <span className="text-green-500">✓</span>}
                  </div>
                  <div className="text-sm text-gray-400 space-y-1">
                    <p>{item.scanned_count} boxes</p>
                    <p>
                      {item.scanned_weight.toFixed(2)} / {item.expected_weight.toFixed(2)} kg
                      {' '}({percentage.toFixed(0)}%)
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Instructions */}
        <div className="bg-blue-900 bg-opacity-30 border border-blue-700 rounded-lg p-4">
          <p className="text-sm">
            <strong>Next steps:</strong><br />
            1. Return to the Telegram app<br />
            2. Review the scanned items<br />
            3. Tap confirm to save to inventory
          </p>
        </div>

        {/* Close Button */}
        <button
          onClick={() => window.close()}
          className="w-full mt-6 bg-gray-700 py-3 rounded-lg font-medium hover:bg-gray-600 transition-colors"
        >
          Close Scanner
        </button>
      </div>
    </div>
  );
}
