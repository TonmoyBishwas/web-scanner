'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '@/lib/i18n';

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

/** px/ms past which a release counts as a flick and advances one snap point. */
const FLICK_VELOCITY = 0.35;
/** px of travel before a gesture stops counting as a tap. */
const TAP_SLOP = 8;

// SSR-safe layout effect: measuring before paint avoids the one-frame
// full-height flash the sheet used to show on mount.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Design bottom sheet: floats absolute over the camera area, #101c22,
// 20px top radius, 44×5 drag handle. Height snaps to 3 points; the handle
// drags (pointer capture) and a clean tap cycles mid → tall → peek.
// Mount inside a `relative` container that fills the camera region.
export const BottomSheet = forwardRef<BottomSheetHandle, BottomSheetProps>(function BottomSheet(
  { snapFractions = DEFAULT_SNAPS, initialSnap = 1, toolbar, footer, children },
  ref,
) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // Mirrors snapIndexRef for rendering (aria-valuenow). The ref is what the
  // gesture handlers read, since they must see the current value synchronously.
  const [snapIndex, setSnapIndex] = useState(initialSnap);

  const snapIndexRef = useRef(initialSnap);
  const containerHRef = useRef(0);
  // Combined height of the non-scrolling chrome (handle + tool dock + footer
  // actions). The peek snap is floored to this so the confirm button can
  // never be clipped — see snapPx.
  const chromeMinRef = useRef(0);
  // Live gesture state. Deliberately a ref, not state: the handler used to
  // gate on a `dragging` state flag that React had not committed yet, so the
  // first pointermove events of every gesture were dropped and the sheet
  // visibly failed to follow the finger.
  const dragRef = useRef<{
    startY: number;
    startH: number;
    moved: boolean;
    lastY: number;
    lastT: number;
    velocity: number;
  } | null>(null);

  const hasToolbar = Boolean(toolbar);
  const hasFooter = Boolean(footer);

  const snapPx = useCallback(
    (i: number) => {
      const container = containerHRef.current || 0;
      const idx = Math.max(0, Math.min(2, i));
      // Floor every snap at the fixed chrome height. `flex-none` children do
      // not shrink, so a snap shorter than the chrome pushed the footer past
      // the sheet's `overflow-hidden` edge: at peek the confirm button was
      // invisible AND unscrollable, leaving the tiny handle as the only way
      // back. Capped at the container so the floor can't overflow it.
      const floor = Math.min(chromeMinRef.current, container);
      const raw = Math.round(container * snapFractions[idx]);
      return Math.max(floor, Math.min(container, raw));
    },
    [snapFractions],
  );

  const measure = useCallback(() => {
    const root = rootRef.current;
    const parent = root?.offsetParent as HTMLElement | null;
    containerHRef.current = parent?.offsetHeight || window.innerHeight;

    // The floor is what the sheet physically cannot render smaller than. It is
    // NOT just the three chrome blocks: the root's own top border and the
    // scroll area's padding are height the flex layout can't reclaim either
    // (`min-h-0` zeroes the content box, never the padding). Summing only the
    // obvious parts left the confirm button a few px past the clipped edge.
    let scrollPad = 0;
    const scroll = scrollRef.current;
    if (scroll) {
      const cs = getComputedStyle(scroll);
      scrollPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    }
    const rootBorders = root ? root.offsetHeight - root.clientHeight : 0;

    chromeMinRef.current =
      (grabRef.current?.offsetHeight || 0) +
      (toolbarRef.current?.offsetHeight || 0) +
      (footerRef.current?.offsetHeight || 0) +
      scrollPad +
      rootBorders;
  }, []);

  const settle = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(2, i));
      snapIndexRef.current = clamped;
      setSnapIndex(clamped);
      setHeight(snapPx(clamped));
    },
    [snapPx],
  );

  const nearestSnap = useCallback(
    (h: number) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < 3; i++) {
        const d = Math.abs(snapPx(i) - h);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    [snapPx],
  );

  // Re-measure on mount and whenever the camera region or the sheet's own
  // chrome changes size. A window `resize` listener alone missed the common
  // case: the header/progress rows above growing a line (or the tool dock
  // wrapping) resizes the camera region without any window resize, and the
  // sheet kept a stale height.
  useIsoLayoutEffect(() => {
    const applyMeasured = () => {
      measure();
      // Never fight an in-flight drag.
      if (!dragRef.current) setHeight(snapPx(snapIndexRef.current));
    };
    applyMeasured();

    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applyMeasured) : null;
    if (ro) {
      if (parent) ro.observe(parent);
      if (grabRef.current) ro.observe(grabRef.current);
      if (toolbarRef.current) ro.observe(toolbarRef.current);
      if (footerRef.current) ro.observe(footerRef.current);
    }
    window.addEventListener('resize', applyMeasured);
    window.addEventListener('orientationchange', applyMeasured);
    window.visualViewport?.addEventListener('resize', applyMeasured);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', applyMeasured);
      window.removeEventListener('orientationchange', applyMeasured);
      window.visualViewport?.removeEventListener('resize', applyMeasured);
    };
  }, [measure, snapPx, hasToolbar, hasFooter]);

  useImperativeHandle(ref, () => ({ snapTo: settle }), [settle]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      measure();
      dragRef.current = {
        startY: e.clientY,
        startH: rootRef.current?.offsetHeight || 0,
        moved: false,
        lastY: e.clientY,
        lastT: e.timeStamp,
        velocity: 0,
      };
      setDragging(true);
      // Capture on the handler's own element, not e.target — the visual pill
      // inside it is a valid target and capturing there relied on bubbling.
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [measure],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = d.startY - e.clientY; // dragging up increases height
      if (Math.abs(delta) > TAP_SLOP) d.moved = true;
      const dt = e.timeStamp - d.lastT;
      if (dt > 0) {
        // px/ms, positive = growing. Smoothed so a single jittery sample
        // can't decide the flick.
        const instant = (d.lastY - e.clientY) / dt;
        d.velocity = d.velocity * 0.7 + instant * 0.3;
        d.lastY = e.clientY;
        d.lastT = e.timeStamp;
      }
      setHeight(Math.max(snapPx(0), Math.min(snapPx(2), d.startH + delta)));
    },
    [snapPx],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }

      if (!d.moved) {
        // Tap: cycle mid → tall → peek (design cycleSheet)
        const next = snapIndexRef.current === 1 ? 2 : snapIndexRef.current === 2 ? 0 : 1;
        settle(next);
        return;
      }

      // A flick moves one snap point in the direction of travel. Nearest-point
      // snapping alone sent a fast, short flick straight back where it came
      // from, which read as the sheet ignoring the gesture.
      if (Math.abs(d.velocity) > FLICK_VELOCITY) {
        const from = nearestSnap(d.startH);
        settle(d.velocity > 0 ? from + 1 : from - 1);
        return;
      }
      settle(nearestSnap(rootRef.current?.offsetHeight || 0));
    },
    [settle, nearestSnap],
  );

  // Keyboard equivalent of the drag, for accessibility and BT keypads.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        settle(snapIndexRef.current + 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        settle(snapIndexRef.current - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        settle(snapIndexRef.current === 1 ? 2 : snapIndexRef.current === 2 ? 0 : 1);
      }
    },
    [settle],
  );

  return (
    <div
      ref={rootRef}
      className="absolute left-0 right-0 bottom-0 bg-raised border-t-2 border-line rounded-t-[20px] flex flex-col shadow-[0_-18px_44px_rgba(0,0,0,.72)] z-30 overflow-hidden"
      style={{
        height: height ?? undefined,
        transition: dragging ? 'none' : 'height .26s cubic-bezier(.4,0,.2,1)',
      }}
    >
      {/* Drag handle. The grab area is a full-width 44px band — the visual pill
          is only 5px tall, and a ~20px strip was genuinely hard to hit with
          gloves, which is what made the sheet feel stuck. */}
      <div
        ref={grabRef}
        role="slider"
        tabIndex={0}
        aria-label={tr('terminal.sheetHandle')}
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={snapIndex}
        className="flex-none h-11 flex items-center justify-center px-4 cursor-grab active:cursor-grabbing select-none"
        style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="w-12 h-[5px] rounded-full bg-[#e8edf2]" />
      </div>

      {toolbar && <div ref={toolbarRef} className="flex-none">{toolbar}</div>}

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar flex flex-col gap-[10px] px-4 pb-3"
        style={{ touchAction: 'pan-y' }}
      >
        {children}
      </div>

      {footer && (
        <div ref={footerRef} className="flex-none px-4 pt-2 pb-3 safe-bottom border-t border-line bg-raised">
          {footer}
        </div>
      )}
    </div>
  );
});
