'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface BottomSheetHandle {
  /** Animate to a snap index (0 = peek, 1 = mid, 2 = tall) */
  snapTo: (index: number) => void;
}

interface BottomSheetProps {
  /** Fractions of the container height. Design: [86, 340, 706] / 812. */
  snapFractions?: [number, number, number];
  /** Initial snap index */
  initialSnap?: number;
  /** Fixed region under the drag handle (the tool dock) */
  toolbar?: ReactNode;
  /** Fixed region below the scroll area (confirm actions) — always visible
   *  at mid/tall snaps regardless of list scroll. */
  footer?: ReactNode;
  children: ReactNode;
}

const DEFAULT_SNAPS: [number, number, number] = [0.106, 0.419, 0.87];

// Design bottom sheet: floats absolute over the camera area, #101c22,
// 20px top radius, 44×5 drag handle. Height snaps to 3 points; the handle
// drags (pointer capture) and a clean tap cycles mid → tall → peek.
// Mount inside a `relative` container that fills the camera region.
export const BottomSheet = forwardRef<BottomSheetHandle, BottomSheetProps>(function BottomSheet(
  { snapFractions = DEFAULT_SNAPS, initialSnap = 1, toolbar, footer, children },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const snapIndexRef = useRef(initialSnap);
  const containerHRef = useRef(0);
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const movedRef = useRef(false);

  const snapPx = useCallback(
    (i: number) => Math.round(containerHRef.current * snapFractions[Math.max(0, Math.min(2, i))]),
    [snapFractions],
  );

  const measure = useCallback(() => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    containerHRef.current = parent?.offsetHeight || window.innerHeight;
  }, []);

  useEffect(() => {
    measure();
    setHeight(snapPx(snapIndexRef.current));
    const onResize = () => {
      measure();
      setHeight(snapPx(snapIndexRef.current));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure, snapPx]);

  const settle = useCallback(
    (i: number) => {
      snapIndexRef.current = Math.max(0, Math.min(2, i));
      setHeight(snapPx(snapIndexRef.current));
    },
    [snapPx],
  );

  useImperativeHandle(ref, () => ({ snapTo: settle }), [settle]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    measure();
    startYRef.current = e.clientY;
    startHRef.current = rootRef.current?.offsetHeight || 0;
    movedRef.current = false;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [measure]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const delta = startYRef.current - e.clientY; // dragging up increases height
    if (Math.abs(delta) > 6) movedRef.current = true;
    const min = snapPx(0);
    const max = snapPx(2);
    setHeight(Math.max(min, Math.min(max, startHRef.current + delta)));
  }, [dragging, snapPx]);

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    const h = rootRef.current?.offsetHeight || 0;
    if (!movedRef.current) {
      // Tap: cycle mid → tall → peek (design cycleSheet)
      const next = snapIndexRef.current === 1 ? 2 : snapIndexRef.current === 2 ? 0 : 1;
      settle(next);
      return;
    }
    // Snap to nearest point
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(snapPx(i) - h);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    settle(best);
  }, [dragging, settle, snapPx]);

  return (
    <div
      ref={rootRef}
      className="absolute left-0 right-0 bottom-0 bg-raised border-t-2 border-line rounded-t-[20px] flex flex-col shadow-[0_-18px_44px_rgba(0,0,0,.72)] z-30 overflow-hidden"
      style={{
        height: height ?? undefined,
        transition: dragging ? 'none' : 'height .26s cubic-bezier(.4,0,.2,1)',
      }}
    >
      {/* Drag handle */}
      <div
        className="flex-none pt-[9px] px-4 pb-[6px] cursor-grab select-none"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="w-11 h-[5px] rounded-full bg-[#e8edf2] mx-auto" />
      </div>

      {toolbar && <div className="flex-none">{toolbar}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-[10px] px-4 pb-3" style={{ touchAction: 'pan-y' }}>
        {children}
      </div>

      {footer && (
        <div className="flex-none px-4 pt-2 pb-3 safe-bottom border-t border-line bg-raised">
          {footer}
        </div>
      )}
    </div>
  );
});
