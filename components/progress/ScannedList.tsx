'use client';

import { Loader2, AlertTriangle, Check } from 'lucide-react';
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
  const entries = Array.from(scannedBarcodes.keys()).reverse();

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-500">
        <p className="text-sm">Scan a box to begin</p>
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
            className={`flex items-center gap-3 bg-gray-800/80 dark:bg-gray-800/80 backdrop-blur-sm border border-gray-700/50 dark:border-gray-700/50 rounded-xl px-3 py-2.5 transition-all ${
              i === 0 ? 'animate-slideInUp' : ''
            }`}
          >
            {/* Thumbnail */}
            {imageUrl ? (
              <div
                className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-gray-700 cursor-pointer hover:ring-2 hover:ring-purple-500 transition-all"
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
              <div className="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
                <span className="text-gray-500 text-xs">No img</span>
              </div>
            )}

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-gray-400">
                  #{barcode.slice(-6)}
                </span>
                {/* Status badge */}
                {ocrResult ? (
                  <Check className="w-3.5 h-3.5 text-green-400" />
                ) : isPending ? (
                  <Loader2 className="w-3.5 h-3.5 text-yellow-400 animate-spin" />
                ) : ocrFailed ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                ) : null}
              </div>

              {ocrResult ? (
                <p className="text-sm text-gray-200 dark:text-gray-200 truncate">
                  {ocrResult.product_name || ocrResult.product_name_hebrew || 'Unknown'}
                  {ocrResult.weight_kg ? (
                    <span className="text-blue-300 ml-1.5">{ocrResult.weight_kg} kg</span>
                  ) : null}
                </p>
              ) : isPending ? (
                <p className="text-xs text-yellow-300/80">Analyzing...</p>
              ) : ocrFailed ? (
                <p className="text-xs text-amber-400">OCR failed — needs manual entry</p>
              ) : (
                <p className="text-xs text-gray-500">Awaiting image...</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
