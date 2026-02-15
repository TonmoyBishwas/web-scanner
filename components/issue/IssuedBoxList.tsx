'use client';

import type { IssuedBox } from '@/types';

interface IssuedBoxListProps {
  issuedBoxes: IssuedBox[];
}

export function IssuedBoxList({ issuedBoxes }: IssuedBoxListProps) {
  const totalWeight = issuedBoxes.reduce((sum, b) => sum + b.weight, 0);

  if (issuedBoxes.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 text-center text-gray-500">
        No boxes issued yet. Scan a barcode to begin.
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-white font-medium">
          Issued: {issuedBoxes.length} box{issuedBoxes.length !== 1 ? 'es' : ''}
        </h3>
        <span className="text-green-400 font-bold">{totalWeight.toFixed(2)} kg</span>
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {issuedBoxes.map((box, idx) => (
          <div
            key={box.barcode + idx}
            className="flex justify-between items-center bg-gray-700 rounded px-3 py-2 text-sm"
          >
            <span className="text-white truncate mr-2">{box.item_name}</span>
            <span className="text-green-400 font-medium whitespace-nowrap">
              {box.weight} kg
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
