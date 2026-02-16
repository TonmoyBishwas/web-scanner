'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useSettingsStore(s => s.hydrate);

  // Hydrate settings from localStorage on client mount (avoids SSR mismatch)
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Always use dark mode
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  return <>{children}</>;
}
