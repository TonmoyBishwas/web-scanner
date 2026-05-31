'use client';

import { useState } from 'react';
import { X, Image as ImageIcon } from 'lucide-react';
import { ImageModal } from '@/components/shared/ImageModal';
import { useT } from '@/lib/i18n';
import type { BoxStickerOCR } from '@/types';

interface PhotoGalleryProps {
  images: Map<string, string>;
  ocrResults: Map<string, BoxStickerOCR>;
  onClose: () => void;
}

export function PhotoGallery({ images, ocrResults, onClose }: PhotoGalleryProps) {
  const tr = useT();
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const entries = Array.from(images.entries()).reverse();

  return (
    <>
      {/* Full-screen overlay */}
      <div className="fixed inset-0 z-[80] bg-canvas flex flex-col animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-brand" />
            <span className="text-ink font-bold">
              {tr('components.photoGallery.galleryTitle', { count: entries.length })}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-ink-muted" />
          </button>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3">
            {entries.map(([barcode, imageUrl]) => {
              const ocr = ocrResults.get(barcode);
              return (
                <div
                  key={barcode}
                  className="relative rounded-xl overflow-hidden bg-sunken border border-line cursor-pointer hover:ring-2 hover:ring-brand transition-all group"
                  onClick={() => setSelectedImage(imageUrl)}
                >
                  <div className="aspect-square">
                    <img
                      src={imageUrl}
                      alt={`Box ${barcode.slice(-6)}`}
                      className="w-full h-full object-cover"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                  {/* OCR data overlay */}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                    <p className="text-[10px] font-mono text-white/60">
                      #{barcode.slice(-6)}
                    </p>
                    {ocr ? (
                      <>
                        <p className="text-xs text-white font-medium truncate">
                          {ocr.product_name || ocr.product_name_hebrew || tr('common.unknown')}
                        </p>
                        {ocr.weight_kg && (
                          <p className="text-[10px] text-white/80">
                            {ocr.weight_kg} kg
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-[10px] text-white/70">{tr('components.photoGallery.processing')}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {entries.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-ink-muted">
              <ImageIcon className="w-12 h-12 mb-3" />
              <p>{tr('components.photoGallery.empty2')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Image zoom modal */}
      {selectedImage && (
        <ImageModal
          imageUrl={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}
    </>
  );
}
