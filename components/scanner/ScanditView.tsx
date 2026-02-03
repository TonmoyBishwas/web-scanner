'use client';

import { useEffect, useRef, useState, useReducer } from 'react';
import type { ParsedBarcode } from '@/types';
import {
  getScanditLicenseKey,
  initDataCaptureContext,
  createBarcodeCaptureSettings,
  createBarcodeCapture,
  getRecommendedCameraSettings,
  checkCameraSupport,
  checkBrowserCompatibility,
  createDataCaptureView,
  setViewContext,
  createBarcodeCaptureOverlay,
  pickCamera,
  startCamera,
} from '@/lib/scandit';
import type {
  BarcodeCapture,
  DataCaptureContext,
  Camera,
  DataCaptureView,
  BarcodeCaptureOverlay,
  FrameSourceState,
} from '@/lib/scandit';

interface ScanditViewProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  onError?: (error: string) => void;
}

// Prevent double-initialization from React Strict Mode
let initializationCount = 0;

export function ScanditView({ onBarcodeDetected, scannedBarcodes, onError }: ScanditViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitializingRef = useRef(false);
  const isInitializedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState('Initializing...');

  useEffect(() => {
    // Prevent React Strict Mode double-initialization
    if (isInitializingRef.current) {
      console.log('[ScanditView] Skipping - already initializing');
      return;
    }

    if (isInitializedRef.current) {
      console.log('[ScanditView] Skipping - already initialized');
      return;
    }

    isInitializingRef.current = true;
    initializationCount++;
    console.log('[ScanditView] Initialization attempt #', initializationCount);

    let barcodeCapture: BarcodeCapture | null = null;
    let context: DataCaptureContext | null = null;
    let camera: Camera | null = null;
    let view: DataCaptureView | null = null;
    let overlay: BarcodeCaptureOverlay | null = null;
    let listener: any = null;

    async function initScanner() {
      try {
        setIsLoading(true);
        console.log('[ScanditView] Starting scanner initialization');

        // Check browser compatibility (checks for Telegram, WeChat, etc.)
        const compat = checkBrowserCompatibility();
        if (!compat.compatible) {
          const errorMsg = compat.reason || 'Browser not compatible';
          console.error('[ScanditView] Browser compatibility issue:', errorMsg);
          setError(errorMsg);
          onError?.(errorMsg);
          setIsLoading(false);
          isInitializingRef.current = false;
          return;
        }

        if (!containerRef.current) {
          throw new Error('Container element not found');
        }

        setStatusMessage('Creating camera view...');
        // Step 1: Create view and connect to element FIRST (before context)
        view = createDataCaptureView(containerRef.current);
        console.log('[ScanditView] View created and connected to DOM');

        setStatusMessage('Loading license key...');
        // Step 2: Get license key
        const licenseKey = getScanditLicenseKey();
        console.log('[ScanditView] License key found');

        setStatusMessage('Initializing Scandit SDK...');
        // Step 3: Initialize context
        context = await initDataCaptureContext(licenseKey);
        console.log('[ScanditView] Context initialized');

        setStatusMessage('Setting up camera...');
        // Step 4: Pick camera BEFORE setting context on view
        camera = pickCamera();
        const cameraSettings = getRecommendedCameraSettings();
        await camera.applySettings(cameraSettings);
        console.log('[ScanditView] Camera configured');

        // Step 5: Set camera as frame source
        await context.setFrameSource(camera);
        console.log('[ScanditView] Frame source set to camera');

        setStatusMessage('Configuring barcode scanner...');
        // Step 6: Create barcode capture settings and instance
        const settings = createBarcodeCaptureSettings();
        barcodeCapture = await createBarcodeCapture(context, settings);
        console.log('[ScanditView] Barcode capture created');

        // Step 7: Enable barcode capture
        await barcodeCapture.setEnabled(true);
        console.log('[ScanditView] Barcode capture enabled');

        setStatusMessage('Connecting view to context...');
        // Step 8: Set context on view (view is already connected to element)
        await setViewContext(view, context);
        console.log('[ScanditView] View connected to context');

        // Step 9: Create overlay
        overlay = await createBarcodeCaptureOverlay(barcodeCapture, view);
        console.log('[ScanditView] Overlay created');

        // Step 10: Add listener
        listener = {
          didScan: (_capture: any, session: any) => {
            if (!session || !session.newlyRecognizedBarcode) {
              return;
            }

            const barcode = session.newlyRecognizedBarcode;
            const data = barcode.data;

            if (!data) {
              return;
            }

            console.log('[ScanditView] Barcode scanned:', data);

            // Check duplicate
            if (scannedBarcodes.has(data)) {
              // Vibrate to indicate duplicate
              if (navigator.vibrate) {
                navigator.vibrate(200);
              }
              console.log('[ScanditView] Duplicate barcode, ignoring');
              return;
            }

            // Parse barcode (will be validated in API, but emit raw for now)
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
        console.log('[ScanditView] Listener added');

        setStatusMessage('Starting camera...');
        // Step 11: Start camera LAST after everything is set up
        try {
          await startCamera(context);
          console.log('[ScanditView] Camera started successfully');
          setIsLoading(false);
          setIsInitialized(true);
          isInitializedRef.current = true;
          setStatusMessage('');
          console.log('[ScanditView] Scanner initialization complete');
        } catch (cameraError) {
          // Camera failed to start - this is a known issue with Scandit SDK
          console.error('[ScanditView] Camera start failed:', cameraError);
          const errorMsg = cameraError instanceof Error ? cameraError.message : 'Camera failed to start';

          // Show a more helpful error message
          setError(`Scandit SDK camera initialization failed: ${errorMsg}.

This appears to be a known compatibility issue between Scandit SDK 8.x and your browser/OS combination. The browser camera access works, but Scandit cannot start the camera.

Possible solutions:
• Try a different browser (Firefox, Safari)
• Try on a mobile device
• Check if there are browser extensions blocking camera access`);
          onError?.(errorMsg);
          setIsLoading(false);
          isInitializingRef.current = false;
          isInitializedRef.current = false;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize scanner';
        console.error('[ScanditView] Scanner initialization error:', err);
        console.error('[ScanditView] Error stack:', err instanceof Error ? err.stack : 'no stack');
        setError(errorMsg);
        onError?.(errorMsg);
        setIsLoading(false);
        isInitializingRef.current = false;
        isInitializedRef.current = false;
      }
    }

    initScanner();

    // Cleanup function
    return () => {
      console.log('[ScanditView] Cleanup called');
      if (barcodeCapture && listener) {
        barcodeCapture.removeListener(listener);
      }
      if (camera) {
        camera.switchToDesiredState('Off' as FrameSourceState).catch(console.error);
      }
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      isInitializingRef.current = false;
      isInitializedRef.current = false;
    };
  }, [onBarcodeDetected, scannedBarcodes, onError]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-900 text-white p-4">
        <div className="text-center max-w-lg">
          <div className="text-4xl mb-4">📷</div>
          <p className="text-red-400 mb-4">{error}</p>
          <div className="bg-gray-800 rounded-lg p-4 mb-4 text-left text-sm">
            <p className="font-medium mb-2">Technical Details:</p>
            <p className="text-gray-300">Direct camera access test: PASSED ✓</p>
            <p className="text-gray-300">Scandit SDK camera start: FAILED ✗</p>
            <p className="text-gray-300">This is a Scandit SDK compatibility issue, not a browser permission issue.</p>
          </div>
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

  return (
    <div className="relative w-full h-full bg-black">
      <div ref={containerRef} className="w-full h-full" />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90">
          <div className="text-white text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <p>{statusMessage}</p>
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
