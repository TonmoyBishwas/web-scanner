'use client';

import { useT } from '@/lib/i18n';
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
  const tr = useT();
  const na = tr('components.boxDetail.notAvailable');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
      <div className="w-full max-w-md bg-raised rounded-t-2xl p-6">
        <h2 className="text-xl font-bold text-ink mb-4">{tr('components.boxDetail.issueThisBoxQ')}</h2>

        <div className="space-y-3 mb-6">
          <DetailRow label={tr('components.boxDetail.itemName')} value={box.item_name} />
          <DetailRow label={tr('components.boxDetail.sku')} value={box.sku} />
          <DetailRow label={tr('components.boxDetail.weight')} value={`${box.weight} kg`} highlight />
          <DetailRow label={tr('components.boxDetail.expiry')} value={box.expiry || na} />
          <DetailRow label={tr('components.boxDetail.supplier')} value={box.supplier} />
          <DetailRow label={tr('components.boxDetail.invoice')} value={box.invoice_number || na} />
          <DetailRow label={tr('components.boxDetail.received')} value={box.received_date || na} />
          {box.production_date && (
            <DetailRow label={tr('components.boxDetail.production')} value={box.production_date} />
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 py-3 rounded-lg bg-sunken text-ink font-medium hover:bg-hover disabled:opacity-50 transition-colors"
          >
            {tr('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 py-3 rounded-lg bg-ok text-ink-inverse font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                {tr('components.boxDetail.issuing')}
              </span>
            ) : (
              tr('components.boxDetail.confirmIssue')
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
      <span className="text-ink-muted text-sm">{label}</span>
      <span
        className={`font-medium ${highlight ? 'text-ok text-lg' : 'text-ink'}`}
      >
        {value}
      </span>
    </div>
  );
}
