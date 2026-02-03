'use client';

import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import type { ParsedBarcode } from '@/types';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';

interface Html5QrcodeScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
}

interface CameraDevice {
  id: string;
  label: string;
}

export function Html5QrcodeScanner({ onBarcodeDetected, scannedBarcodes }: Html5QrcodeScannerProps) {
  const qrCodeRegionId = useRef(`html5qr-code-region-${Date.now()}`);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [debugInfo, setDebugInfo] = useState('');
  const [availableCameras, setAvailableCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | undefined>(undefined);
  const [lastDetectedBarcode, setLastDetectedBarcode] = useState<string | null>(null);
  const [lastParsedData, setLastParsedData] = useState<ParsedBarcode | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [showDebug, setShowDebug] = useState(true);
  const [scannerState, setScannerState] = useState('Initializing...');
  const isMountedRef = useRef(true);

  // Get cameras and select best one
  const getBestCamera = async (): Promise<string | undefined> => {
    try {
      setScannerState('Requesting camera permission...');
      // Html5Qrcode.getCameras() handles permission and enumeration together
      const cameras = await Html5Qrcode.getCameras();

      console.log('[Html5Qrcode] Available cameras:', cameras);
      setScannerState(`Found ${cameras.length} camera(s)`);

      const cameraDevices: CameraDevice[] = cameras.map((cam, i) => ({
        id: cam.id || `camera-${i}`,
        label: cam.label || `Camera ${i}`
      }));

      setAvailableCameras(cameraDevices);

      if (cameraDevices.length === 0) {
        return undefined;
      }

      // Check for saved selection first
      const savedCameraId = sessionStorage.getItem('selectedCameraId');
      if (savedCameraId && cameraDevices.find(c => c.id === savedCameraId)) {
        console.log('[Html5Qrcode] Using saved camera:', cameraDevices.find(c => c.id === savedCameraId)?.label);
        setSelectedCameraId(savedCameraId);
        return savedCameraId;
      }

      // Find back camera by looking at labels
      const backCamera = cameraDevices.find(cam => {
        const label = cam.label.toLowerCase();
        return label.includes('back') || label.includes('rear') || label.includes('environment');
      });

      if (backCamera) {
        console.log('[Html5Qrcode] Selected back camera:', backCamera.label);
        setSelectedCameraId(backCamera.id);
        return backCamera.id;
      }

      // Fallback to first camera
      const selectedCamera = cameraDevices[0];
      console.log('[Html5Qrcode] No back camera found, using first camera:', selectedCamera.label);
      setSelectedCameraId(selectedCamera.id);
      return selectedCamera.id;
    } catch (err) {
      console.error('[Html5Qrcode] Error getting cameras:', err);
      return undefined;
    }
  };

  // Handle image upload
  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    console.log('[Html5Qrcode] Processing uploaded image:', file.name);
    setIsProcessingImage(true);

    try {
      if (!html5QrCodeRef.current) {
        throw new Error('Scanner not initialized');
      }

      // Scan from file using html5-qrcode
      const result = await html5QrCodeRef.current.scanFile(file, true);

      if (result) {
        const barcode = result;
        setLastDetectedBarcode(barcode);
        setScanCount(c => c + 1);
        console.log('[Html5Qrcode] Barcode detected from image:', barcode);

        if (!scannedBarcodes.has(barcode)) {
          // Parse the barcode to extract weight, expiry, etc.
          const parsedData = parseIsraeliBarcode(barcode) || {
            type: 'Standard',
            sku: '',
            weight: 0,
            expiry: '',
            raw_barcode: barcode
          };

          setLastDetectedBarcode(barcode);
          setLastParsedData(parsedData);
          setScanCount(c => c + 1);

          console.log('[Html5Qrcode] Parsed data from image:', parsedData);

          if (navigator.vibrate) navigator.vibrate(100);
          onBarcodeDetected(barcode, parsedData);
        } else {
          if (navigator.vibrate) navigator.vibrate(200);
          setError(`Duplicate: ${barcode}`);
          setTimeout(() => setError(null), 2000);
        }
      }
    } catch (err) {
      console.error('[Html5Qrcode] Image decode error:', err);
      setError('No barcode found in image. Try a clearer photo.');
      setTimeout(() => setError(null), 3000);
    } finally {
      setIsProcessingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Handle camera switch
  const handleCameraSwitch = async (deviceId: string) => {
    console.log('[Html5Qrcode] Switching to camera:', deviceId);

    // Stop current scanning
    if (html5QrCodeRef.current && isInitialized) {
      try {
        await html5QrCodeRef.current.stop();
        console.log('[Html5Qrcode] Stopped current camera');
      } catch (err) {
        console.error('[Html5Qrcode] Error stopping camera:', err);
      }
    }

    // Save to session storage and restart
    sessionStorage.setItem('selectedCameraId', deviceId);
    setSelectedCameraId(deviceId);

    // Restart with new camera
    startScanning(deviceId);
  };

  const startScanning = async (cameraId?: string) => {
    if (!isMountedRef.current) return;

    try {
      setIsScanning(true);
      setError(null);
      setScannerState('Starting scanner...');

      const config = {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.QR_CODE,
        ],
        aspectRatio: 1.0,
      };

      // For Chrome/Android, use videoConstraints instead of cameraId
      const cameraConfig = cameraId
        ? { deviceId: { exact: cameraId } }
        : { facingMode: 'environment' };

      // If we have a previous instance, clean it up
      if (html5QrCodeRef.current) {
        try {
          await html5QrCodeRef.current.stop();
        } catch (err) {
          // Ignore stop errors
        }
      }

      // Create new instance
      const html5QrCode = new Html5Qrcode(qrCodeRegionId.current);
      html5QrCodeRef.current = html5QrCode;

      let lastScannedBarcode: string | null = null;
      let lastScanTime = 0;

      await html5QrCode.start(
        cameraConfig,
        config,
        (decodedText) => {
          if (!isMountedRef.current) return;

          const now = Date.now();

          // Always update the debug display with what was detected
          setLastDetectedBarcode(decodedText);
          setScanCount(c => c + 1);

          // Debounce: ignore same barcode within 2 seconds
          if (decodedText === lastScannedBarcode && now - lastScanTime < 2000) {
            return;
          }

          lastScannedBarcode = decodedText;
          lastScanTime = now;

          if (!scannedBarcodes.has(decodedText)) {
            console.log('[Html5Qrcode] New barcode detected:', decodedText);

            // Parse the barcode to extract weight, expiry, etc.
            const parsedData = parseIsraeliBarcode(decodedText) || {
              type: 'Standard',
              sku: '',
              weight: 0,
              expiry: '',
              raw_barcode: decodedText
            };

            console.log('[Html5Qrcode] Parsed data:', parsedData);
            setLastParsedData(parsedData);

            if (navigator.vibrate) navigator.vibrate(100);
            onBarcodeDetected(decodedText, parsedData);
          } else {
            console.log('[Html5Qrcode] Duplicate barcode');
            if (navigator.vibrate) navigator.vibrate(200);
            setError(`Duplicate: ${decodedText}`);
            setTimeout(() => setError(null), 2000);
          }
        },
        (errorMessage) => {
          // Log scanning errors occasionally
          if (Math.random() < 0.05) {
            setDebugInfo(`Scanning... (${scanCount})`);
          }
        }
      );

      if (isMountedRef.current) {
        setIsInitialized(true);
        setIsScanning(false);
        setScannerState('Scanning active - point at barcode');
        console.log('[Html5Qrcode] Scanner started successfully');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to start scanner';
      console.error('[Html5Qrcode] Start error:', err);
      setScannerState(`Error: ${errorMsg}`);
      setError(errorMsg);
      setIsScanning(false);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;

    async function initScanner() {
      try {
        console.log('[Html5Qrcode] Initializing scanner...');

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera not supported in this browser');
        }

        // Get best camera
        const cameraId = await getBestCamera();
        console.log('[Html5Qrcode] Using camera:', cameraId || 'default');

        // Start scanning
        await startScanning(cameraId);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize scanner';
        console.error('[Html5Qrcode] Initialization error:', err);
        setError(errorMsg);
        setIsScanning(false);
      }
    }

    initScanner();

    return () => {
      isMountedRef.current = false;
      console.log('[Html5Qrcode] Cleanup');

      if (html5QrCodeRef.current) {
        html5QrCodeRef.current.stop().catch(() => {
          // Ignore cleanup errors
        });
        html5QrCodeRef.current = null;
      }
    };
  }, []);

  if (error && !error.includes('Duplicate') && !error.includes('No barcode')) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-900 text-white p-4">
        <div className="text-center">
          <div className="text-4xl mb-4">📷</div>
          <p className="text-red-400 mb-4">{error}</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black">
      {/* Html5Qrcode renders its own video element - ensure proper sizing */}
      <div
        id={qrCodeRegionId.current}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />

      {/* Scanning overlay */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-4 right-4 h-0.5 bg-green-500 opacity-50"></div>
        <div className="absolute bottom-1/4 left-4 right-4 h-0.5 bg-green-500 opacity-50"></div>
        <div className="absolute top-4 bottom-4 left-1/4 w-0.5 bg-green-500 opacity-50"></div>
        <div className="absolute top-4 bottom-4 right-1/4 w-0.5 bg-green-500 opacity-50"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-32 h-32 border-2 border-green-500 rounded-lg opacity-50"></div>
      </div>

      {isScanning && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90">
          <div className="text-white text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <p>Starting camera...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-16 left-4 right-4 bg-yellow-600 text-white p-3 rounded-lg shadow-lg z-10">
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Top bar with camera selector and upload */}
      <div className="absolute top-4 left-4 right-4 bg-black bg-opacity-70 text-white p-2 rounded">
        <div className="flex justify-between items-center gap-2">
          <div className="flex-1 min-w-0">
            {availableCameras.length > 1 ? (
              <select
                value={selectedCameraId || ''}
                onChange={(e) => handleCameraSwitch(e.target.value)}
                className="w-full bg-gray-800 text-white text-xs px-2 py-1 rounded border border-gray-600"
              >
                {availableCameras.map((cam) => (
                  <option key={cam.id} value={cam.id}>
                    {cam.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs">
                {isInitialized ? 'Point camera at barcode' : 'Initializing...'}
                {debugInfo && <span className="text-gray-400 ml-2">{debugInfo}</span>}
              </p>
            )}
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessingImage}
            className="px-3 py-1 bg-blue-600 rounded text-sm hover:bg-blue-700 disabled:bg-gray-600 flex-shrink-0"
          >
            {isProcessingImage ? '...' : '📁'}
          </button>
        </div>
      </div>

      {/* Debug panel - shows last detected barcode */}
      {showDebug && (
        <div className="absolute bottom-4 left-4 right-4 max-w-md mx-auto">
          <div className="bg-gray-900 bg-opacity-90 text-white p-3 rounded-lg shadow-lg">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-bold text-green-400">🔍 DEBUG PANEL</span>
              <button
                onClick={() => setShowDebug(false)}
                className="text-xs text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Scanner State - most important for debugging */}
            <div className="mb-2 bg-blue-900 bg-opacity-50 p-2 rounded">
              <div className="text-xs text-gray-400">Status:</div>
              <div className="text-sm font-bold text-blue-300">
                {scannerState}
              </div>
            </div>

            {/* Last detected barcode */}
            <div className="mb-2">
              <div className="text-xs text-gray-400">Raw Barcode:</div>
              <div className="bg-black p-2 rounded mt-1 break-all font-mono text-xs">
                {lastDetectedBarcode ? (
                  <span className="text-green-400">{lastDetectedBarcode}</span>
                ) : (
                  <span className="text-gray-500">No barcode detected yet</span>
                )}
              </div>
            </div>

            {/* Parsed data */}
            {lastParsedData && (
              <div className="mb-2 bg-black p-2 rounded">
                <div className="text-xs text-gray-400 mb-1">Parsed Data:</div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <div>SKU: <span className="text-blue-400">{lastParsedData.sku || 'N/A'}</span></div>
                  <div>Type: <span className="text-purple-400">{lastParsedData.type}</span></div>
                  <div>Weight: <span className="text-yellow-400">{lastParsedData.weight} kg</span></div>
                  <div>Expiry: <span className="text-orange-400">{lastParsedData.expiry || 'N/A'}</span></div>
                </div>
              </div>
            )}

            {/* Scan count */}
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">Detections: <span className="text-white">{scanCount}</span></span>
              <span className="text-gray-400">Already Scanned: <span className="text-yellow-400">{scannedBarcodes.size}</span></span>
            </div>

            {/* Already scanned barcodes list */}
            {scannedBarcodes.size > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-white">
                  Scanned Barcodes ({scannedBarcodes.size})
                </summary>
                <div className="mt-1 max-h-20 overflow-y-auto bg-black p-2 rounded">
                  {Array.from(scannedBarcodes.entries()).map(([barcode, data], i) => (
                    <div key={i} className="text-xs mb-1 pb-1 border-b border-gray-700 last:border-0">
                      <div className="font-mono text-yellow-400 break-all">{barcode}</div>
                      <div className="text-gray-500">{data.weight} kg | {data.expiry}</div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
