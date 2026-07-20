"use client";

import { Loader2, AlertTriangle, Check, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';

interface ScannedListProps {
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  ocrImageUrls: Map<string, string>;
  pendingOCR: Set<string>;
  onImageClick?: (url: string) => void;
  // A row can be removed at any stage — before OCR finishes, after it fails, or
  // when the photo was never a box sticker at all. Two-step (tap row -> Delete).
  onDelete?: (barcode: string) => void;
  selectedBarcode?: string | null;
  onSelect?: (barcode: string | null) => void;
}

export function ScannedList({
  scannedBarcodes,
  ocrResults,
  ocrImageUrls,
  pendingOCR,
  onImageClick,
  onDelete,
  selectedBarcode,
  onSelect,
}: ScannedListProps) {
  const tr = useT();
  const entries = Array.from(scannedBarcodes.keys()).reverse();
  const interactive = !!onSelect && !!onDelete;

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
        const selected = selectedBarcode === barcode;

        return (
          <div
            key={barcode}
            className={`rounded-xl border transition-all ${
              i === 0 ? 'animate-slideInUp' : ''
            } ${selected ? 'bg-brand-weak border-brand' : 'bg-raised border-line'}`}
          >
            <div
              onClick={
                interactive ? () => onSelect?.(selected ? null : barcode) : undefined
              }
              className={`flex items-center gap-3 px-3 py-2.5 ${
                interactive ? 'cursor-pointer' : ''
              }`}
            >
              {/* Thumbnail */}
              {imageUrl ? (
                <div
                  className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-sunken cursor-pointer hover:ring-2 hover:ring-brand transition-all"
                  onClick={(e) => {
                    e.stopPropagation();
                    onImageClick?.(imageUrl);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
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
                  <span className="text-xs font-mono text-ink-muted" dir="ltr">
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
                      <span className="text-brand-weak-ink font-mono font-bold ms-1.5" dir="ltr">{ocrResult.weight_kg} kg</span>
                    ) : null}
                  </p>
                ) : isPending ? (
                  <p className="text-xs text-warn-weak-ink">{tr('components.scannedList.analyzing')}</p>
                ) : ocrFailed ? (
                  <p className="text-xs text-warn-weak-ink">{tr('components.scannedList.ocrFailedManual')}</p>
                ) : (
                  <p className="text-xs text-ink-muted">{tr('components.scannedList.awaitingImage')}</p>
                )}
              </div>
            </div>

            {/* Two-step delete: works regardless of OCR state — including a photo
                that was never recognised as a box sticker. */}
            {interactive && selected && (
              <div className="px-3 pb-3">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.(barcode);
                    onSelect?.(null);
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-danger-weak text-danger-weak-ink text-sm font-bold border border-danger/50 flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> {tr('palletVerify.deleteScan')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
