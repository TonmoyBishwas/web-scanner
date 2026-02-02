'use client';

import { useEffect, useRef, useState } from 'react';
import type { ParsedBarcode } from '@/types';
import {
  loadScanditSDK,
  getScanditLicenseKey,
  initDataCaptureContext,
  createBarcodeCaptureSettings,
  checkCameraSupport,
  requestCameraPermission
} from '@/lib/scandit';

interface ScanditViewProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  onError?: (error: string) => void;
}

export function ScanditView({ onBarcodeDetected, scannedBarcodes, onError }: ScanditViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  useEffect(() => {
    let barcodeCapture: any = null;
    let context: any = null;
    let camera: any = null;
    let sdk: any = null;

    async function initScanner() {
      try {
        // Check camera support
        const support = checkCameraSupport();
        if (!support.supported) {
          const errorMsg = support.error || 'Camera not supported';
          setError(errorMsg);
          onError?.(errorMsg);
          return;
        }

        // Request permission
        const hasPermission = await requestCameraPermission();
        if (!hasPermission) {
          const errorMsg = 'Camera permission denied. Please allow camera access to scan barcodes.';
          setError(errorMsg);
          onError?.(errorMsg);
          return;
        }

        setHasPermission(true);

        // Load SDK
        sdk = await loadScanditSDK();
        const licenseKey = getScanditLicenseKey();

        // Initialize context
        context = await initDataCaptureContext(licenseKey);

        // Create settings
        const settings = await createBarcodeCaptureSettings();

        // Create barcode capture
        barcodeCapture = new sdk.BarcodeCapture(context, settings);
        barcodeCapture.isEnabled = true;

        // Get camera
        camera = sdk.Camera.default;
        await context.setFrameSource(camera);

        // Create view
        const view = new sdk.DataCaptureView();
        view.connectToElement(containerRef.current!);

        // Add overlay
        const overlay = sdk.BarcodeCaptureOverlay.withBarcodeCaptureForView(barcodeCapture, view);
        overlay.viewfinder = new sdk.RectangularViewfinder();
        overlay.viewfinder.color = '#00FF00';
        overlay.viewfinder.strokeStyle = sdk.RectangularViewfinderStyle.Square;

        // Listen for scans
        const listener = {
          didScan: (_capture: any, _session: any) => {
            const session = _session;
            if (!session || !session.newlyRecognizedBarcodes || session.newlyRecognizedBarcodes.length === 0) {
              return;
            }

            const barcode = session.newlyRecognizedBarcodes[0];
            const data = barcode.data;

            if (!data) {
              return;
            }

            // Check duplicate
            if (scannedBarcodes.has(data)) {
              // Vibrate to indicate duplicate
              if (navigator.vibrate) {
                navigator.vibrate(200);
              }
              return;
            }

            // Parse barcode (will be done in API, but we can emit raw)
            // The barcode data will be sent to API for parsing
            onBarcodeDetected(data, {
              type: 'Standard',
              sku: '',
              weight: 0,
              expiry: '',
              raw_barcode: data
            });
          }
        };

        barcodeCapture.addListener(listener);

        // Start camera
        await camera.switchToDesiredState(sdk.FrameSourceState.On);

        setIsInitialized(true);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize scanner';
        setError(errorMsg);
        onError?.(errorMsg);
        console.error('Scanner initialization error:', err);
      }
    }

    initScanner();

    return () => {
      // Cleanup
      if (barcodeCapture) {
        barcodeCapture.removeAllListeners();
      }
      if (camera) {
        camera.switchToDesiredState(sdk?.FrameSourceState?.Off || 'Off').catch(console.error);
      }
    };
  }, [onBarcodeDetected, scannedBarcodes, onError]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-900 text-white p-4">
        <div className="text-center">
          <div className="text-4xl mb-4">📷</div>
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!hasPermission) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-900 text-white p-4">
        <div className="text-center">
          <div className="text-4xl mb-4">📷</div>
          <p className="mb-4">Camera access is required for barcode scanning.</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
          >
            Allow Camera
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black">
      <div ref={containerRef} className="w-full h-full" />
      {!isInitialized && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90">
          <div className="text-white text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <p>Initializing camera...</p>
          </div>
        </div>
      )}
      {isInitialized && (
        <div className="absolute top-4 left-4 right-4 bg-black bg-opacity-70 text-white p-2 rounded">
          <p className="text-sm">Point camera at barcode to scan</p>
        </div>
      )}
    </div>
  );
}
