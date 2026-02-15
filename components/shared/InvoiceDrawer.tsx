'use client';

import { X, FileText } from 'lucide-react';
import { ItemProgress } from '@/components/progress/ItemProgress';
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
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[55] bg-black/50 backdrop-blur-sm animate-fadeIn"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed bottom-0 left-0 right-0 z-[56] bg-gray-900 dark:bg-gray-900 border-t-2 border-blue-500 rounded-t-2xl shadow-2xl animate-slideInUp"
        style={{ maxHeight: '70vh' }}
      >
        <div className="flex justify-between items-center px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-blue-400" />
            <span className="text-white font-bold text-sm">Invoice Overview</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors"
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
