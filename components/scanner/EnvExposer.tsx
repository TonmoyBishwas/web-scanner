'use client';

import { useEffect } from 'react';

/**
 * Expose environment variables to window for SDK access
 */
export function EnvExposer() {
  useEffect(() => {
    // Expose license key to window for Scandit SDK
    if (typeof window !== 'undefined') {
      (window as any).NEXT_PUBLIC_SCANDIT_LICENSE_KEY = process.env.NEXT_PUBLIC_SCANDIT_LICENSE_KEY || '';
    }
  }, []);

  return null;
}
