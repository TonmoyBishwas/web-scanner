'use client';

import { useState, useRef, useCallback } from 'react';
import { Check, ChevronRight } from 'lucide-react';

interface SwipeConfirmProps {
  onConfirm: () => void;
  label?: string;
  disabled?: boolean;
}

export function SwipeConfirm({ onConfirm, label = 'Slide to Confirm', disabled = false }: SwipeConfirmProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const startXRef = useRef(0);
  const trackWidthRef = useRef(0);

  const THUMB_SIZE = 52;
  const THRESHOLD = 0.8;

  const getMaxDrag = () => {
    return trackWidthRef.current - THUMB_SIZE;
  };

  const handleStart = useCallback((clientX: number) => {
    if (disabled || confirmed) return;
    startXRef.current = clientX;
    trackWidthRef.current = trackRef.current?.offsetWidth || 300;
    setIsDragging(true);
  }, [disabled, confirmed]);

  const handleMove = useCallback((clientX: number) => {
    if (!isDragging) return;
    const delta = clientX - startXRef.current;
    const max = getMaxDrag();
    setDragX(Math.max(0, Math.min(delta, max)));
  }, [isDragging]);

  const handleEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    const max = getMaxDrag();
    const progress = dragX / max;

    if (progress >= THRESHOLD) {
      setDragX(max);
      setConfirmed(true);
      if ('vibrate' in navigator) navigator.vibrate(200);
      setTimeout(onConfirm, 300);
    } else {
      setDragX(0);
    }
  }, [isDragging, dragX, onConfirm]);

  const progress = getMaxDrag() > 0 ? dragX / getMaxDrag() : 0;

  return (
    <div
      ref={trackRef}
      className={`relative w-full h-14 rounded-xl overflow-hidden select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
      } ${confirmed ? 'bg-green-600' : 'bg-gray-700 dark:bg-gray-700'}`}
      onTouchStart={e => handleStart(e.touches[0].clientX)}
      onTouchMove={e => handleMove(e.touches[0].clientX)}
      onTouchEnd={handleEnd}
      onMouseDown={e => handleStart(e.clientX)}
      onMouseMove={e => handleMove(e.clientX)}
      onMouseUp={handleEnd}
      onMouseLeave={() => { if (isDragging) handleEnd(); }}
    >
      {/* Track fill */}
      <div
        className="absolute inset-y-0 left-0 bg-green-600/30 transition-none"
        style={{ width: dragX + THUMB_SIZE }}
      />

      {/* Label */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span
          className="text-sm font-semibold text-white transition-opacity"
          style={{ opacity: confirmed ? 0 : Math.max(0, 1 - progress * 2) }}
        >
          {label}
        </span>
        {confirmed && (
          <Check className="w-6 h-6 text-white animate-scaleIn" />
        )}
      </div>

      {/* Chevron hints */}
      {!confirmed && (
        <div className="absolute inset-0 flex items-center justify-end pr-4 pointer-events-none"
          style={{ opacity: Math.max(0, 1 - progress * 3) }}
        >
          <ChevronRight className="w-5 h-5 text-white/30" />
          <ChevronRight className="w-5 h-5 text-white/20 -ml-3" />
          <ChevronRight className="w-5 h-5 text-white/10 -ml-3" />
        </div>
      )}

      {/* Draggable thumb */}
      {!confirmed && (
        <div
          className={`absolute top-1 bottom-1 rounded-lg flex items-center justify-center bg-white shadow-lg transition-shadow ${
            isDragging ? 'shadow-xl' : ''
          }`}
          style={{
            width: THUMB_SIZE - 8,
            left: dragX + 4,
            transition: isDragging ? 'none' : 'left 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          <ChevronRight className="w-5 h-5 text-gray-700" />
        </div>
      )}
    </div>
  );
}
