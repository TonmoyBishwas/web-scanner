'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useSettingsStore(s => s.hydrate);

  // Hydrate settings from localStorage on client mount (avoids SSR mismatch)
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Light theme only (redesign). Clear any stale 'dark' class a returning
  // user might still carry, then assert 'light'.
  useEffect(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  }, []);

  return <>{children}</>;
}
