'use client';

import type { BoxLookupResult } from '@/types';

interface BoxDetailModalProps {
  box: NonNullable<BoxLookupResult['box']>;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function BoxDetailModal({
  box,
  onConfirm,
  onCancel,
  isLoading,
}: BoxDetailModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
      <div className="w-full max-w-md bg-gray-800 rounded-t-2xl p-6">
        <h2 className="text-xl font-bold text-white mb-4">Issue This Box?</h2>

        <div className="space-y-3 mb-6">
          <DetailRow label="Item Name" value={box.item_name} />
          <DetailRow label="SKU" value={box.sku} />
          <DetailRow label="Weight" value={`${box.weight} kg`} highlight />
          <DetailRow label="Expiry" value={box.expiry || 'N/A'} />
          <DetailRow label="Supplier" value={box.supplier} />
          <DetailRow label="Invoice" value={box.invoice_number || 'N/A'} />
          <DetailRow label="Received" value={box.received_date || 'N/A'} />
          {box.production_date && (
            <DetailRow label="Production" value={box.production_date} />
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 py-3 rounded-lg bg-gray-700 text-white font-medium hover:bg-gray-600 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 py-3 rounded-lg bg-green-600 text-white font-medium hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                Issuing...
              </span>
            ) : (
              'Confirm Issue'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-400 text-sm">{label}</span>
      <span
        className={`font-medium ${highlight ? 'text-green-400 text-lg' : 'text-white'}`}
      >
        {value}
      </span>
    </div>
  );
}
