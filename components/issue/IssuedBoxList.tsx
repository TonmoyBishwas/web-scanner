'use client';

import { useT } from '@/lib/i18n';
import type { IssuedBox } from '@/types';

interface IssuedBoxListProps {
  issuedBoxes: IssuedBox[];
}

export function IssuedBoxList({ issuedBoxes }: IssuedBoxListProps) {
  const tr = useT();
  const totalWeight = issuedBoxes.reduce((sum, b) => sum + b.weight, 0);

  if (issuedBoxes.length === 0) {
    return (
      <div className="bg-raised border border-line rounded-lg p-4 text-center text-ink-muted">
        {tr('components.issuedBoxList.emptyHint')}
      </div>
    );
  }

  return (
    <div className="bg-raised border border-line rounded-lg p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-ink font-medium">
          {tr('components.issuedBoxList.issuedHeader', { count: issuedBoxes.length })}
        </h3>
        <span className="text-ok font-bold">{totalWeight.toFixed(2)} kg</span>
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {issuedBoxes.map((box, idx) => (
          <div
            key={box.barcode + idx}
            className="flex justify-between items-center bg-sunken rounded px-3 py-2 text-sm"
          >
            <span className="text-ink truncate me-2">{box.item_name}</span>
            <span className="text-ok font-medium whitespace-nowrap">
              {box.weight} kg
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
