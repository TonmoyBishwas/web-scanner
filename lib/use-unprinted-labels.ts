'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toUnprintedLabels, type UnprintedLabel } from './label-batches';

/**
 * The labels this scanner session SAVED but has not printed yet — the amber
 * badge on the Labels chip and the "label not printed" marker on scan rows.
 *
 * The server is the source of truth (GET /api/carton-labels?scope=session&
 * status=created), never a local counter: the print sheet runs in ANOTHER tab
 * and flips the labels it printed, and a scanner tab discarded while that tab
 * was in front (trace 2026-09-24 15:01–15:04) must come back with the right
 * state. So it refetches on mount, whenever the tab becomes visible or gets
 * focus again (the worker returning from the print tab), and on `refresh()`
 * after a save / print / delete. A failed read keeps the last good list.
 *
 * Create it ONCE at the top of the page, above any early return.
 */
export function useUnprintedLabels(token: string): {
  labels: UnprintedLabel[];
  refresh: () => void;
} {
  const [labels, setLabels] = useState<UnprintedLabel[]>([]);
  // Only the newest request may write: a slow answer from before a save must
  // not overwrite the answer from after it.
  const seqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!token) return;
    const seq = ++seqRef.current;
    fetch(`/api/carton-labels?token=${encodeURIComponent(token)}&scope=session&status=created`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (seq !== seqRef.current || !data?.success) return;
        setLabels(toUnprintedLabels(data.labels));
      })
      .catch(() => { /* keep the last good list */ });
  }, [token]);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  return { labels, refresh };
}
