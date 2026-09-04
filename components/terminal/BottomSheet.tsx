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

/**
 * Camera height the sheet must never eat into at peek/mid — enough for the
 * corner scan frame (196px) plus its label and padding, i.e. SmartScanner's
 * CORNER_BAND_PX. The sheet floats over the live camera, so growing it to fit
 * the footer costs the worker the thing they are actually aiming with. Camera
 * wins; the footer moves to the tall snap when there isn't room for both.
 */
const MIN_CAMERA_PX = 240;

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
  // The camera region the sheet floats over (its offsetParent), cached so the
  // unmount cleanup can still reach it.
  const hostRef = useRef<HTMLElement | null>(null);
  const grabRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // At peek the sheet is deliberately too short for the footer. Hiding it is
  // honest; letting it overflow `overflow-hidden` left the confirm button
  // present-but-invisible and unreachable, which is the bug this replaces.
  const [footerHidden, setFooterHidden] = useState(false);
  // Mirrors snapIndexRef for rendering (aria-valuenow). The ref is what the
  // gesture handlers read, since they must see the current value synchronously.
  const [snapIndex, setSnapIndex] = useState(initialSnap);

  const snapIndexRef = useRef(initialSnap);
  const containerHRef = useRef(0);
  // Non-scrolling chrome EXCLUDING the footer (handle + tool dock + the scroll
  // area's padding + the root border). Flooring every snap at chrome INCLUDING
  // the footer is what broke the scanner in production: the real footer is a
  // status line plus a count-input block or swipe-confirm (~200px, not the
  // ~65px a single button suggests), so the floor swallowed the camera region
  // and the scan frame with it.
  const baseChromeRef = useRef(0);
  // Last known laid-out footer height. Cached because a hidden footer measures
  // 0, and we still need its height to decide when it fits again.
  const footerHRef = useRef(0);
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
      // Peek is floored at the base chrome only, so it stays compact and the
      // camera + scan frame keep their room. Mid and tall are floored high
      // enough to fit the footer, so the confirm action is always reachable
      // there. `flex-none` children never shrink, so anything below these
      // floors would be clipped past the sheet's `overflow-hidden` edge
      // rather than shrunk — which is why the footer is hidden outright at
      // peek instead of being allowed to overflow invisibly.
      const base = Math.min(baseChromeRef.current, container);
      // Never let the footer floor push the sheet over the camera the worker
      // is aiming with. On a roomy screen mid still grows to show the footer;
      // on a cramped one mid stays camera-first and the footer lives at tall.
      const roomCap = Math.max(base, container - MIN_CAMERA_PX);
      const withFooter = Math.min(baseChromeRef.current + footerHRef.current, roomCap, container);
      const floor = idx === 0 ? base : withFooter;
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

    // A hidden footer measures 0 — keep the last real value so we still know
    // how much room it needs to come back.
    const fh = footerRef.current?.offsetHeight || 0;
    if (fh > 0) footerHRef.current = fh;

    baseChromeRef.current =
      (grabRef.current?.offsetHeight || 0) +
      (toolbarRef.current?.offsetHeight || 0) +
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

  /**
   * Publish the live sheet height onto the camera region as `--sheet-h`, so the
   * scan frame can centre itself in the strip of camera that is still visible.
   *
   * A CSS variable rather than a callback prop on purpose: the height changes
   * on every pointermove of a drag, and re-rendering the live-camera component
   * at that rate is not affordable. `--sheet-h-dur` mirrors the sheet's own
   * height transition so the frame settles WITH the sheet, and is 0s mid-drag
   * so it tracks the finger instead of lagging behind it.
   */
  useIsoLayoutEffect(() => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return;
    hostRef.current = parent;
    parent.style.setProperty('--sheet-h', `${height ?? 0}px`);
    parent.style.setProperty('--sheet-h-dur', dragging ? '0s' : '.26s');
  }, [height, dragging]);

  // Leave the camera region clean on unmount — `offsetParent` is already null
  // by then, hence the cached host.
  useEffect(() => () => {
    const host = hostRef.current;
    host?.style.removeProperty('--sheet-h');
    host?.style.removeProperty('--sheet-h-dur');
  }, []);

  // Show the footer exactly when there is room for it (mid/tall), hide it when
  // there isn't (peek, and mid-drag on the way down).
  useEffect(() => {
    if (height === null) return;
    const fits = height >= baseChromeRef.current + footerHRef.current - 1;
    setFooterHidden(!fits);
  }, [height]);

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
        <div
          ref={footerRef}
          className="flex-none px-4 pt-2 pb-3 safe-bottom border-t border-line bg-raised"
          style={footerHidden ? { display: 'none' } : undefined}
        >
          {footer}
        </div>
      )}
    </div>
  );
});
