'use client';

/**
 * Receive form v3: Android back closes the topmost layer (spec 6.1).
 *
 * The form tells the hook how many layers are open (`depth`: a sheet, the
 * note viewer, the loose sub-screen, the inline pallet list, an open card,
 * the confirmation …). Each layer gets one history entry (`pushState`); a
 * `popstate` (the phone's back) calls `onBack`, which closes the top layer.
 * A layer closed by its own × (or Escape, or the form moving on) takes its
 * entry back with `history.go(-n)`; the popstate that causes is ignored.
 * When `onBack` closes nothing that counts (it only hid the keyboard), the
 * entry is pushed again, so the next back still has something to pop.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function useBackStack(depth: number, onBack: () => void, enabled = true): void {
  const pushed = useRef(0);
  const ignore = useRef(0);
  const onBackRef = useRef(onBack);
  // Bumped after each back, so an entry is re-pushed when nothing closed.
  const [nonce, setNonce] = useState(0);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    try {
      if (depth > pushed.current) {
        for (let i = pushed.current; i < depth; i += 1) window.history.pushState({ v3: i + 1 }, '');
        pushed.current = depth;
      } else if (depth < pushed.current) {
        const n = pushed.current - depth;
        pushed.current = depth;
        ignore.current += 1;
        window.history.go(-n);
      }
    } catch {
      /* history blocked (sandboxed frame): back simply leaves the page */
    }
  }, [depth, enabled, nonce]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const onPop = () => {
      if (ignore.current > 0) {
        ignore.current -= 1;
        return;
      }
      if (pushed.current === 0) return;
      // The phone already popped this layer's entry.
      pushed.current -= 1;
      onBackRef.current();
      setNonce((n) => n + 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [enabled]);
}
