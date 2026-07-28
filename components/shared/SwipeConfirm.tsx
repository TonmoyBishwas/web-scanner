'use client';

import { useState, useRef, useCallback } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';

interface SwipeConfirmProps {
  onConfirm: () => void;
  label?: string;
  disabled?: boolean;
  /** 'brand' (default) for normal confirms, 'warn' for discrepancy/shortfall confirms. */
  variant?: 'brand' | 'warn';
}

// Terminal-design swipe slider: 54px track, 48px thumb, fill opacity tracks
// drag progress. Direction-aware — in RTL (Hebrew sessions set html.dir) the
// thumb starts at the inline-start (right) and drags left, matching the
// prototype's swDown/swMove/swUp interaction.
export function SwipeConfirm({ onConfirm, label = 'Slide to Confirm', disabled = false, variant = 'brand' }: SwipeConfirmProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Lazy init is safe: this component only mounts after the session loads,
  // by which point useLangDir has already set html.dir. Refreshed on drag
  // start as a belt-and-braces.
  const [rtl, setRtl] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dir === 'rtl'
  );
  // Track width mirrored into state so render-time progress math never
  // touches a ref (react-hooks/refs); handlers use the ref for freshness.
  const [trackWidth, setTrackWidth] = useState(0);
  const startXRef = useRef(0);
  const trackWidthRef = useRef(0);
  const rtlRef = useRef(false);

  const THUMB_SIZE = 48;
  const EDGE = 3;
  const THRESHOLD = 0.72;

  const getMaxDrag = () => {
    return trackWidthRef.current - THUMB_SIZE - EDGE * 2;
  };

  const handleStart = useCallback((clientX: number) => {
    if (disabled || confirmed) return;
    startXRef.current = clientX;
    trackWidthRef.current = trackRef.current?.offsetWidth || 300;
    setTrackWidth(trackWidthRef.current);
    rtlRef.current = document.documentElement.dir === 'rtl';
    setRtl(rtlRef.current);
    setIsDragging(true);
  }, [disabled, confirmed]);

  const handleMove = useCallback((clientX: number) => {
    if (!isDragging) return;
    const delta = rtlRef.current ? startXRef.current - clientX : clientX - startXRef.current;
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

  const renderMaxDrag = trackWidth - THUMB_SIZE - EDGE * 2;
  const progress = renderMaxDrag > 0 ? dragX / renderMaxDrag : 0;

  const fillColor = variant === 'warn' ? 'rgba(245,158,11,.2)' : 'rgba(19,164,236,.18)';
  const trackClass = variant === 'warn'
    ? 'bg-[#120d04] border-[rgba(245,158,11,.4)]'
    : 'bg-sunken border-line';
  const confirmedClass = variant === 'warn' ? 'bg-warn border-warn' : 'bg-brand border-brand';
  const thumbClass = variant === 'warn' ? 'bg-warn text-[#1a1408]' : 'bg-brand text-[#04222f]';
  const labelClass = variant === 'warn' ? 'text-[#d8c9a0]' : 'text-ink-muted';

  // Chevron points in the drag direction (toward inline-end).
  const DirChevron = rtl ? ChevronLeft : ChevronRight;

  return (
    <div
      ref={trackRef}
      className={`relative w-full h-[54px] rounded-[13px] overflow-hidden select-none touch-none border ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
      } ${confirmed ? confirmedClass : trackClass}`}
      onTouchStart={e => handleStart(e.touches[0].clientX)}
      onTouchMove={e => handleMove(e.touches[0].clientX)}
      onTouchEnd={handleEnd}
      onMouseDown={e => handleStart(e.clientX)}
      onMouseMove={e => handleMove(e.clientX)}
      onMouseUp={handleEnd}
      onMouseLeave={() => { if (isDragging) handleEnd(); }}
    >
      {/* Track fill — opacity tracks drag progress (per the terminal design) */}
      {!confirmed && (
        <div
          className="absolute inset-0"
          style={{ background: fillColor, opacity: progress, transition: isDragging ? 'none' : 'opacity 0.15s' }}
        />
      )}

      {/* Label */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span
          className={`text-[12.5px] font-extrabold ${labelClass} transition-opacity`}
          style={{ opacity: confirmed ? 0 : Math.max(0, 1 - progress * 2) }}
        >
          {label}
        </span>
        {confirmed && (
          <Check className="w-6 h-6 text-canvas animate-scaleIn" />
        )}
      </div>

      {/* Draggable thumb */}
      {!confirmed && (
        <div
          className={`absolute top-[3px] w-12 h-12 rounded-[11px] flex items-center justify-center shadow-lg transition-shadow ${thumbClass} ${
            isDragging ? 'shadow-xl' : ''
          }`}
          style={{
            insetInlineStart: dragX + EDGE,
            transition: isDragging ? 'none' : 'inset-inline-start 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          <DirChevron className="w-5 h-5" />
        </div>
      )}
    </div>
  );
}
