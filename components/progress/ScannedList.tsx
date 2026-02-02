'use client';

import type { ParsedBarcode } from '@/types';

interface ScannedListProps {
  scanned: Array<{ barcode: string; data: ParsedBarcode; time: string }>;
}

export function ScannedList({ scanned }: ScannedListProps) {
  if (scanned.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No items scanned yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-400">Recently Scanned</h3>
      <div className="max-h-64 overflow-y-auto space-y-2">
        {scanned.slice().reverse().map((scan, index) => (
          <div
            key={scan.barcode}
            className="bg-gray-800 rounded-lg p-3 flex justify-between items-center"
          >
            <div>
              <p className="text-sm font-medium">{scan.data.sku}</p>
              <p className="text-xs text-gray-400">
                {scan.data.weight.toFixed(2)} kg • {scan.data.type}
              </p>
            </div>
            <span className="text-green-500 text-lg">✓</span>
          </div>
        ))}
      </div>
    </div>
  );
}
