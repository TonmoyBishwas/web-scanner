'use client';

import { useEffect } from 'react';

/**
 * Component to load Scandit SDK from CDN
 * This must be rendered before any other Scandit components
 */
export function ScanditSDKLoader() {
  useEffect(() => {
    // Check if SDK is already loaded
    if ((window as any).Scandit) {
      return;
    }

    // Create script tags to load Scandit SDK from CDN
    const loadScript = (src: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    };

    // Load Scandit SDK modules from unpkg CDN
    // These are the ESM versions that work with browser
    const scripts = [
      'https://unpkg.com/@scandit/web-datacapture-core@8.1.0/dist/scandit-web-datacapture-core.js',
      'https://unpkg.com/@scandit/web-datacapture-barcode@8.1.0/dist/scandit-web-datacapture-barcode.js'
    ];

    scripts.reduce((promise, src) => {
      return promise.then(() => loadScript(src));
    }, Promise.resolve()).catch((error) => {
      console.error('Failed to load Scandit SDK:', error);
    });
  }, []);

  return null;
}
