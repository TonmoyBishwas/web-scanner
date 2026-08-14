'use client';

import { useEffect, useRef } from 'react';

/**
 * Make the device/browser Back button close an overlay instead of navigating
 * away from the page.
 *
 * Every full-screen surface in the scanner (side drawer, documents archive,
 * pallets browser, detail views, image viewer) is React state layered over a
 * single route. Without a history entry to absorb it, Android's Back button —
 * the one a warehouse worker reaches for first — unloaded the whole scanning
 * session instead of stepping back one screen. There was no way back.
 *
 * @param active   whether the overlay is currently open
 * @param onClose  called when Back is pressed; must close the overlay
 */
export function useBackClose(active: boolean, onClose: () => void): void {
  // Kept in a ref so a caller passing an inline arrow doesn't re-run the
  // registration effect on every render — re-running would churn the history
  // guard. Seeded by useRef and refreshed in an effect (never during render).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    return registerOverlay(() => onCloseRef.current());
  }, [active]);
}

// ── One guard entry for the whole overlay stack ─────────────────────────────
//
// Earlier this pushed one history entry per overlay, which broke two ways:
// popping our own entry on a UI close fired a popstate the overlays beneath
// also heard (closing them too), and React StrictMode's mount→cleanup→mount
// raced its synchronous re-mount against the asynchronous history.back() from
// the cleanup, so an overlay closed itself the instant it opened.
//
// Instead there is a single "guard" entry, armed while anything is open:
//   Back        → consumes the guard → close the top overlay → re-arm if more
//                 remain. With nothing open the guard is gone, so Back leaves
//                 the page normally.
//   UI close    → the guard is dropped, but only on a deferred tick that a
//                 re-registration cancels, which is what makes the StrictMode
//                 remount a no-op instead of a race.

interface OverlayEntry {
  close: () => void;
}

const stack: OverlayEntry[] = [];
let listening = false;
let guardArmed = false;
let disarmTimer: ReturnType<typeof setTimeout> | null = null;
/** Pops we asked for ourselves, whose popstate must not close an overlay. */
let selfPops = 0;
let selfPopTimer: ReturnType<typeof setTimeout> | null = null;

function arm(): void {
  if (disarmTimer) {
    clearTimeout(disarmTimer);
    disarmTimer = null;
  }
  if (guardArmed) return;
  window.history.pushState({ __overlayGuard: true }, '');
  guardArmed = true;
}

function scheduleDisarm(): void {
  if (disarmTimer) clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => {
    disarmTimer = null;
    // Something re-opened in the meantime (StrictMode remount, or the worker
    // moved straight from one screen to another) — keep the guard.
    if (stack.length > 0 || !guardArmed) return;
    guardArmed = false;
    selfPops++;
    if (selfPopTimer) clearTimeout(selfPopTimer);
    // If that back() yields no popstate (already the first entry, or the page
    // is unloading) the counter would swallow the next real Back. Release it.
    selfPopTimer = setTimeout(() => {
      selfPops = 0;
      selfPopTimer = null;
    }, 500);
    window.history.back();
  }, 0);
}

function onPopState(): void {
  if (selfPops > 0) {
    selfPops--; // echo of our own disarm
    return;
  }
  // A real Back press consumed the guard entry.
  guardArmed = false;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.close();
  // Nested overlays remain open behind this one — re-arm so the next Back
  // closes the next one instead of leaving the page.
  if (stack.length > 1) arm();
}

/** Register an open overlay; returns its cleanup. */
function registerOverlay(close: () => void): () => void {
  const entry: OverlayEntry = { close };
  stack.push(entry);

  if (!listening) {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  arm();

  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
    if (stack.length === 0) scheduleDisarm();
  };
}
