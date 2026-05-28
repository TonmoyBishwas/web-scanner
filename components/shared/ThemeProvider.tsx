'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useSettingsStore(s => s.hydrate);

  // Hydrate settings from localStorage on client mount (avoids SSR mismatch)
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Force light mode — the ui-redesign is light-themed. (Old code forced
  // .dark here; we clear it so a re-mount on the same client doesn't leave
  // a stale class behind.)
  useEffect(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  }, []);

  return <>{children}</>;
}
