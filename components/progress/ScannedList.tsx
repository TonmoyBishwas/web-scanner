'use client';

import { Loader2, AlertTriangle, Check } from 'lucide-react';
import { useT } from '@/lib/i18n';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';

interface ScannedListProps {
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  ocrImageUrls: Map<string, string>;
  pendingOCR: Set<string>;
  onImageClick?: (url: string) => void;
}

export function ScannedList({
  scannedBarcodes,
  ocrResults,
  ocrImageUrls,
  pendingOCR,
  onImageClick,
}: ScannedListProps) {
  const tr = useT();
  const entries = Array.from(scannedBarcodes.keys()).reverse();

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-ink-muted">
        <p className="text-sm">{tr('components.scannedList.empty2')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3">
      {entries.map((barcode, i) => {
        const imageUrl = ocrImageUrls.get(barcode);
        const ocrResult = ocrResults.get(barcode);
        const isPending = pendingOCR.has(barcode);
        const ocrFailed = !isPending && !ocrResult && ocrImageUrls.has(barcode);

        return (
          <div
            key={barcode}
            className={`flex items-center gap-3 bg-raised border border-line rounded-xl px-3 py-2.5 transition-all ${
              i === 0 ? 'animate-slideInUp' : ''
            }`}
          >
            {/* Thumbnail */}
            {imageUrl ? (
              <div
                className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-sunken cursor-pointer hover:ring-2 hover:ring-brand transition-all"
                onClick={() => onImageClick?.(imageUrl)}
              >
                <img
                  src={imageUrl}
                  alt={`Box ${barcode.slice(-6)}`}
                  className="w-full h-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            ) : (
              <div className="w-12 h-12 rounded-lg bg-sunken flex items-center justify-center flex-shrink-0">
                <span className="text-ink-muted text-xs">{tr('components.scannedList.noImg')}</span>
              </div>
            )}

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-ink-muted">
                  #{barcode.slice(-6)}
                </span>
                {/* Status badge */}
                {ocrResult ? (
                  <Check className="w-3.5 h-3.5 text-ok" />
                ) : isPending ? (
                  <Loader2 className="w-3.5 h-3.5 text-info animate-spin" />
                ) : ocrFailed ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-warn" />
                ) : null}
              </div>

              {ocrResult ? (
                <p className="text-sm text-ink-body truncate">
                  {ocrResult.product_name || ocrResult.product_name_hebrew || tr('common.unknown')}
                  {ocrResult.weight_kg ? (
                    <span className="text-brand ms-1.5">{ocrResult.weight_kg} kg</span>
                  ) : null}
                </p>
              ) : isPending ? (
                <p className="text-xs text-warn">{tr('components.scannedList.analyzing')}</p>
              ) : ocrFailed ? (
                <p className="text-xs text-warn">{tr('components.scannedList.ocrFailedManual')}</p>
              ) : (
                <p className="text-xs text-ink-muted">{tr('components.scannedList.awaitingImage')}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
