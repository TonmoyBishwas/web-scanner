'use client';

import { useState } from 'react';
import { X, Image as ImageIcon } from 'lucide-react';
import { ImageModal } from '@/components/shared/ImageModal';
import type { BoxStickerOCR } from '@/types';

interface PhotoGalleryProps {
  images: Map<string, string>;
  ocrResults: Map<string, BoxStickerOCR>;
  onClose: () => void;
}

export function PhotoGallery({ images, ocrResults, onClose }: PhotoGalleryProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const entries = Array.from(images.entries()).reverse();

  return (
    <>
      {/* Full-screen overlay */}
      <div className="fixed inset-0 z-[80] bg-gray-900/95 backdrop-blur-lg flex flex-col animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-purple-400" />
            <span className="text-white font-bold">
              Photo Gallery ({entries.length})
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
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
                  className="relative rounded-xl overflow-hidden bg-gray-800 border border-gray-700 cursor-pointer hover:ring-2 hover:ring-purple-500 transition-all group"
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
                    <p className="text-[10px] font-mono text-gray-400">
                      #{barcode.slice(-6)}
                    </p>
                    {ocr ? (
                      <>
                        <p className="text-xs text-white font-medium truncate">
                          {ocr.product_name || ocr.product_name_hebrew || 'Unknown'}
                        </p>
                        {ocr.weight_kg && (
                          <p className="text-[10px] text-blue-300">
                            {ocr.weight_kg} kg
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-[10px] text-yellow-400">Processing...</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {entries.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <ImageIcon className="w-12 h-12 mb-3" />
              <p>No photos captured yet</p>
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
