'use client';

import type { InvoiceItem, ScannedItem, BoxStickerOCR } from '@/types';

interface ItemProgressProps {
  items: InvoiceItem[];
  scanned: ScannedItem[];
  ocrResults?: Map<string, BoxStickerOCR>;
  ocrPending?: Set<string>;
}

export function ItemProgress({ items, scanned, ocrResults = new Map(), ocrPending = new Set() }: ItemProgressProps) {
  // Create a map for quick lookup
  const scannedMap = new Map<number, ScannedItem>();
  for (const item of scanned) {
    scannedMap.set(item.item_index, item);
  }

  const totalWeightExpected = items.reduce((sum, item) => sum + item.quantity_kg, 0);
  const totalWeightScanned = scanned.reduce((sum, item) => sum + item.scanned_weight, 0);
  const completionRate = totalWeightExpected > 0 ? (totalWeightScanned / totalWeightExpected) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Overall Progress */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium">Overall Progress</span>
          <span className="text-sm text-gray-400">
            {totalWeightScanned.toFixed(2)} kg / {totalWeightExpected.toFixed(2)} kg
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-3">
          <div
            className="bg-green-500 h-3 rounded-full transition-all duration-300"
            style={{ width: `${Math.min(completionRate, 100)}%` }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-1 text-center">
          {completionRate.toFixed(1)}% complete
        </p>
      </div>

      {/* Per-Item Progress */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Items</h3>
        {items.map((item) => {
          const scannedData = scannedMap.get(item.item_index);
          const scannedWeight = scannedData?.scanned_weight || 0;
          const scannedCount = scannedData?.scanned_count || 0;
          const itemProgress = (scannedWeight / item.quantity_kg) * 100;

          const isComplete = scannedWeight >= item.quantity_kg;

          return (
            <div key={item.item_index} className="bg-gray-800 rounded-lg p-3">
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                  <p className="text-sm font-medium">{item.item_name_english}</p>
                  <p className="text-xs text-gray-400">{item.item_code}</p>
                </div>
                {isComplete && (
                  <span className="text-green-500 text-lg">✓</span>
                )}
              </div>

              <div className="flex justify-between items-center mb-1">
                <span className="text-xs text-gray-400">
                  {scannedCount} boxes • {scannedWeight.toFixed(2)} kg / {item.quantity_kg} kg
                </span>
                <span className="text-xs text-gray-400">
                  {itemProgress.toFixed(0)}%
                </span>
              </div>

              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${
                    isComplete ? 'bg-green-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${Math.min(itemProgress, 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Component to display OCR status at the top level
export function OCRStatusIndicator({
  ocrPending,
  ocrResults
}: {
  ocrPending: Set<string>;
  ocrResults: Map<string, BoxStickerOCR>;
}) {
  if (ocrPending.size === 0 && ocrResults.size === 0) {
    return null;
  }

  return (
    <div className="bg-gray-800 rounded-lg p-3 mb-4">
      <div className="flex justify-between items-center">
        <span className="text-sm font-medium">Product Data (OCR)</span>
        <div className="flex gap-4 text-xs">
          {ocrPending.size > 0 && (
            <span className="text-yellow-400">
              ⏳ Processing {ocrPending.size}
            </span>
          )}
          {ocrResults.size > 0 && (
            <span className="text-green-400">
              ✓ {ocrResults.size} enriched
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
