'use client';

import { X, FileText } from 'lucide-react';
import { ItemProgress } from '@/components/progress/ItemProgress';
import { useT } from '@/lib/i18n';
import type { InvoiceItem, ScannedItem, BoxStickerOCR } from '@/types';

interface InvoiceDrawerProps {
  open: boolean;
  onClose: () => void;
  items: InvoiceItem[];
  scannedItems: ScannedItem[];
  ocrResults: Map<string, BoxStickerOCR>;
  ocrPending: Set<string>;
}

export function InvoiceDrawer({ open, onClose, items, scannedItems, ocrResults, ocrPending }: InvoiceDrawerProps) {
  const tr = useT();
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[55] bg-black/50 backdrop-blur-sm animate-fadeIn"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed bottom-0 left-0 right-0 z-[56] bg-raised border-t-2 border-brand rounded-t-2xl shadow-2xl animate-slideInUp"
        style={{ maxHeight: '70vh' }}
      >
        <div className="flex justify-between items-center px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-brand" />
            <span className="text-ink font-bold text-sm">{tr('components.invoiceDrawer.overviewTitle')}</span>
          </div>
          <button
            onClick={onClose}
            className="text-ink-muted hover:text-ink p-1 rounded-lg hover:bg-hover transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto p-4" style={{ maxHeight: 'calc(70vh - 50px)' }}>
          <ItemProgress
            items={items}
            scanned={scannedItems}
            ocrResults={ocrResults}
            ocrPending={ocrPending}
          />
        </div>
      </div>
    </>
  );
}
