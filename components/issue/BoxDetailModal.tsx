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
      <div className="w-full max-w-md bg-raised border-t border-line-strong rounded-t-[20px] p-6 pt-3 safe-bottom animate-slideInUp">
        {/* Drag-handle pill */}
        <div className="flex justify-center mb-3">
          <div className="w-9 h-1 rounded-full bg-line-strong" />
        </div>
        <h2 className="text-xl font-extrabold text-ink mb-4">{tr('components.boxDetail.issueThisBoxQ')}</h2>

        <div className="mb-6">
          <DetailRow label={tr('components.boxDetail.itemName')} value={box.item_name} />
          <DetailRow label={tr('components.boxDetail.sku')} value={box.sku} mono />
          <DetailRow label={tr('components.boxDetail.weight')} value={`${box.weight} kg`} highlight mono />
          <DetailRow label={tr('components.boxDetail.expiry')} value={box.expiry || na} mono />
          <DetailRow label={tr('components.boxDetail.supplier')} value={box.supplier} />
          <DetailRow label={tr('components.boxDetail.invoice')} value={box.invoice_number || na} mono />
          <DetailRow label={tr('components.boxDetail.received')} value={box.received_date || na} mono />
          {box.production_date && (
            <DetailRow label={tr('components.boxDetail.production')} value={box.production_date} mono />
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 h-12 rounded-xl bg-tile border border-line-strong text-ink font-bold hover:bg-hover disabled:opacity-50 transition-colors"
          >
            {tr('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="flex-1 h-12 rounded-xl bg-ok text-ink-inverse font-extrabold hover:opacity-90 disabled:opacity-50 transition-opacity"
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
  mono,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-center gap-3 py-2 border-b border-line last:border-b-0">
      <span className="text-ink-muted text-sm font-semibold">{label}</span>
      <span
        dir={mono ? 'ltr' : undefined}
        className={`${mono ? 'font-mono' : ''} ${
          highlight ? 'text-ok-weak-ink text-lg font-extrabold' : 'text-ink font-bold'
        } text-end break-all`}
      >
        {value}
      </span>
    </div>
  );
}
