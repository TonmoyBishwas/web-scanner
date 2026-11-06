'use client';

/**
 * Receive form v3, the note-photo viewer (state 6): full screen on #141414,
 * the page counter `{i} / {n}` and a white ×; the page fitted to the width,
 * double-tap = 200 % (pan with the finger, pinch works too); a horizontal
 * swipe of ≥ 40 px turns the page when not zoomed. × / back close it and
 * leave the list exactly as it was.
 */
import { useRef, useState } from 'react';
import { V3 } from '@/lib/receive-v3';
import { CloseButton } from './icons';
import { EO, I, P, Z, font } from './tokens';
import type { Tr } from './texts';

export function NotePhotoViewer({
  photos,
  tr,
  onClose,
  onPage,
}: {
  photos: string[];
  tr: Tr;
  onClose: () => void;
  onPage?: (page: number) => void;
}) {
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(false);
  const downX = useRef<number | null>(null);
  const n = photos.length;
  const src = photos[Math.min(page, Math.max(0, n - 1))];

  const turn = (dir: 1 | -1) => {
    const next = Math.max(0, Math.min(n - 1, page + dir));
    if (next !== page) {
      setPage(next);
      onPage?.(next + 1);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr('receive.v3.notePhoto')}
      data-overlay="note-photo"
      style={{ position: 'absolute', inset: 0, zIndex: Z.viewer, background: P.viewerBg, display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: '14px 6px' }}
      >
        <span style={{ font: font(400, 15), color: P.viewerLabel }}>{tr('receive.v3.pageOf', { i: I(page + 1), n: I(Math.max(1, n)) })}</span>
        <CloseButton label={tr('receive.v3.close')} onClick={onClose} size={26} color={P.viewerX} />
      </div>
      <div
        onPointerDown={(e) => {
          downX.current = e.clientX;
        }}
        onPointerUp={(e) => {
          const x0 = downX.current;
          downX.current = null;
          if (zoom || x0 === null) return;
          const dx = e.clientX - x0;
          if (Math.abs(dx) < V3.SWIPE_MIN_PX) return;
          // As coded in the prototype: a swipe to the right (dx > 0) is the next page in RTL.
          turn(dx > 0 ? 1 : -1);
        }}
        onDoubleClick={() => setZoom((z) => !z)}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          touchAction: 'pan-x pan-y pinch-zoom',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: zoom ? 'flex-start' : 'center',
        }}
      >
        {src && (
          // eslint-disable-next-line @next/next/no-img-element -- a stored photo URL, shown as is
          <img
            src={src}
            alt={tr('receive.v3.notePhoto')}
            draggable={false}
            style={{ width: zoom ? '200%' : '100%', maxWidth: 'none', flex: 'none', height: 'auto', objectFit: 'contain', transition: `width 200ms ${EO}`, display: 'block' }}
          />
        )}
      </div>
    </div>
  );
}
