'use client';

import { useEffect, useRef, useState } from 'react';
import type { ParsedBarcode } from '@/types';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';

interface ZXingScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode, imageData?: string) => void;
  onManualCapture?: (imageData: string) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  onError?: (error: string) => void;
}

interface CameraDevice {
  deviceId: string;
  label: string;
}

export function ZXingScanner({ onBarcodeDetected, onManualCapture, scannedBarcodes, onError }: ZXingScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [debugInfo, setDebugInfo] = useState('');
  const [availableCameras, setAvailableCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | undefined>(undefined);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const isMountedRef = useRef(true);

  // Get cameras and select best one - does NOT keep the stream
  const getBestCamera = async (): Promise<string | undefined> => {
    try {
      // Temporary stream just to get permission and labels
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });

      // Stop the temporary stream immediately
      tempStream.getTracks().forEach(track => track.stop());

      // Now enumerate devices with labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices
        .filter(d => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i}`
        }));

      console.log('[ZXing] Available cameras:', videoDevices.map((c, i) => `${i}: "${c.label}"`).join(', '));
      setAvailableCameras(videoDevices);

      if (videoDevices.length === 0) {
        return undefined;
      }

      // Check for saved selection first
      const savedCameraId = sessionStorage.getItem('selectedCameraId');
      if (savedCameraId && videoDevices.find(c => c.deviceId === savedCameraId)) {
        console.log('[ZXing] Using saved camera:', videoDevices.find(c => c.deviceId === savedCameraId)?.label);
        setSelectedCameraId(savedCameraId);
        return savedCameraId;
      }

      // Find back camera by looking at labels
      const backCamera = videoDevices.find(cam => {
        const label = cam.label.toLowerCase();
        return label.includes('back') || label.includes('rear') || label.includes('environment');
      });

      if (backCamera) {
        console.log('[ZXing] Selected back camera:', backCamera.label);
        setSelectedCameraId(backCamera.deviceId);
        return backCamera.deviceId;
      }

      // Fallback to first camera
      const selectedCamera = videoDevices[0];
      console.log('[ZXing] No back camera found, using first camera:', selectedCamera.label);
      setSelectedCameraId(selectedCamera.deviceId);
      return selectedCamera.deviceId;
    } catch (err) {
      console.error('[ZXing] Error getting cameras:', err);
      return undefined;
    }
  };

  // Handle image upload
  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    console.log('[ZXing] Processing uploaded image:', file.name);
    setIsProcessingImage(true);

    try {
      const imageUrl = URL.createObjectURL(file);
      const img = new Image();
      img.src = imageUrl;

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const hints = new Map<DecodeHintType, any>();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE,
      ]);

      const reader = new BrowserMultiFormatReader(hints);
      const result = await reader.decodeFromImageElement(img);

      if (result) {
        const barcode = result.getText();
        console.log('[ZXing] Barcode detected from image:', barcode);

        if (!scannedBarcodes.has(barcode)) {
          if (navigator.vibrate) navigator.vibrate(100);
          onBarcodeDetected(barcode, {
            type: 'unknown', sku: barcode, weight: 0, expiry: '', raw_barcode: barcode, expiry_source: 'ocr_required'
          });
        } else {
          if (navigator.vibrate) navigator.vibrate(200);
          setError(`Duplicate: ${barcode}`);
          setTimeout(() => setError(null), 2000);
        }
      }

      URL.revokeObjectURL(imageUrl);
    } catch (err) {
      console.error('[ZXing] Image decode error:', err);
      setError('No barcode found in image. Try a clearer photo.');
      setTimeout(() => setError(null), 3000);
    } finally {
      setIsProcessingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    let controlsRef: IScannerControls | null = null;

    async function initScanner() {
      try {
        console.log('[ZXing] Initializing scanner...');
        setIsScanning(true);

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera not supported in this browser');
        }

        // Get best camera (stops temp stream immediately)
        const deviceId = await getBestCamera();
        console.log('[ZXing] Using camera:', deviceId || 'default');

        // Initialize ZXing with hints
        const hints = new Map<DecodeHintType, any>();
        hints.set(DecodeHintType.TRY_HARDER, true);
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
          BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE,
        ]);

        const reader = new BrowserMultiFormatReader(hints);
        readerRef.current = reader;

        let lastScannedBarcode: string | null = null;
        let lastScanTime = 0;
        let frameCount = 0;

        // Use decodeFromVideoDevice with selected camera
        const controls = await reader.decodeFromVideoDevice(
          deviceId, // Use selected camera, or undefined for default
          videoRef.current!,
          (result, error) => {
            if (!isMountedRef.current) return;

            frameCount++;
            if (frameCount % 100 === 0) {
              console.log(`[ZXing] Frame: ${frameCount}`);
              setDebugInfo(`Frame: ${frameCount}`);
            }

            if (error) {
              const isNotFoundError =
                error.name === 'NotFoundException' ||
                error.message?.includes('No MultiFormat Readers were able to detect') ||
                error.message?.includes('No barcode detected');

              if (!isNotFoundError) {
                console.log('[ZXing] Scan error:', error.name);
              }
              return;
            }

            if (result) {
              const barcode = result.getText();
              const now = Date.now();

              // Debounce: ignore same barcode within 2 seconds
              if (barcode === lastScannedBarcode && now - lastScanTime < 2000) {
                return;
              }

              lastScannedBarcode = barcode;
              lastScanTime = now;

              if (!scannedBarcodes.has(barcode)) {
                console.log('[ZXing] New barcode detected:', barcode);
                if (navigator.vibrate) navigator.vibrate(100);
                onBarcodeDetected(barcode, {
                  type: 'unknown', sku: barcode, weight: 0, expiry: '', raw_barcode: barcode, expiry_source: 'ocr_required'
                });
              } else {
                console.log('[ZXing] Duplicate barcode');
                if (navigator.vibrate) navigator.vibrate(200);
                setError(`Duplicate: ${barcode}`);
                setTimeout(() => setError(null), 2000);
              }
            }
          }
        );

        if (isMountedRef.current) {
          controlsRef = controls;
          scannerControlsRef.current = controls;
          setIsInitialized(true);
          setIsScanning(false);
          console.log('[ZXing] Scanner initialized successfully');
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize scanner';
        console.error('[ZXing] Initialization error:', err);
        setError(errorMsg);
        setIsScanning(false);
      }
    }

    initScanner();

    return () => {
      isMountedRef.current = false;
      console.log('[ZXing] Cleanup');

      if (controlsRef) {
        controlsRef.stop();
        controlsRef = null;
      }

      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  // Handle camera switch
  const handleCameraSwitch = (deviceId: string) => {
    console.log('[ZXing] Switching to camera:', deviceId);
    // Save to session storage BEFORE reloading
    sessionStorage.setItem('selectedCameraId', deviceId);
    setSelectedCameraId(deviceId);
    // Reload to apply new camera
    setTimeout(() => window.location.reload(), 100);
  };

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
      <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
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
                  <option key={cam.deviceId} value={cam.deviceId}>
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
    </div>
  );
}
