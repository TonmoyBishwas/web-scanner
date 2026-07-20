'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useSettingsStore(s => s.hydrate);

  // Hydrate settings from localStorage on client mount (avoids SSR mismatch)
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Dark terminal theme only (RTL redesign). Clear any stale 'light' class a
  // returning user might still carry, then assert 'dark'.
  useEffect(() => {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
  }, []);

  return <>{children}</>;
}
