'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { AlertTriangle, ScanLine } from 'lucide-react';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';

interface SmartScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode, imageData?: string) => void;
  onManualCapture?: (imageData: string) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  onError?: (error: string) => void;
  onScannerTypeDetected?: (type: 'native' | 'fallback') => void;
  onDuplicateFlash?: (triggerFn: () => void) => void;
  className?: string;
}

// Declare BarcodeDetector types
declare global {
  interface Window {
    BarcodeDetector: any;
  }
}

/**
 * SmartScanner - uses native BarcodeDetector API (hardware accelerated).
 * Shows unsupported browser message if BarcodeDetector is not available.
 */
export function SmartScanner({
  onBarcodeDetected,
  onManualCapture,
  scannedBarcodes,
  ocrResults,
  onError,
  onScannerTypeDetected,
  onDuplicateFlash,
  className
}: SmartScannerProps) {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [currentCameraIndex, setCurrentCameraIndex] = useState(0);
  const [currentCameraLabel, setCurrentCameraLabel] = useState('Back Camera');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number>(0);
  const lastScannedRef = useRef<string>('');
  const lastScanTimeRef = useRef<number>(0);
  const isMountedRef = useRef(true);
  const [flashColor, setFlashColor] = useState<'green' | 'red' | null>(null);

  // Enumerate available cameras
  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      setCameras(videoDevices);

      // Find back camera as default
      const backCameraIndex = videoDevices.findIndex(device =>
        device.label.toLowerCase().includes('back') ||
        device.label.toLowerCase().includes('rear') ||
        device.label.toLowerCase().includes('environment')
      );

      if (backCameraIndex !== -1) {
        setCurrentCameraIndex(backCameraIndex);
        setCurrentCameraLabel(videoDevices[backCameraIndex].label || 'Back Camera');
      } else if (videoDevices.length > 0) {
        setCurrentCameraIndex(0);
        setCurrentCameraLabel(videoDevices[0].label || 'Camera');
      }

      console.log('[SmartScanner] Found cameras:', videoDevices.map(d => d.label));
    } catch (err) {
      console.error('[SmartScanner] Failed to enumerate cameras:', err);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      console.log('[SmartScanner] Native BarcodeDetector API available');
      setIsSupported(true);
      onScannerTypeDetected?.('native');
      enumerateCameras();
    } else {
      console.log('[SmartScanner] Native BarcodeDetector API not available');
      setIsSupported(false);
    }

    return () => {
      isMountedRef.current = false;
      stopNativeScanning();
    };
  }, [onScannerTypeDetected, enumerateCameras]);

  // Function to trigger red flash (called by parent on duplicate detection)
  const triggerRedFlash = useCallback(() => {
    setFlashColor('red');
    setTimeout(() => setFlashColor(null), 300);
  }, []);

  // Expose flash trigger to parent
  useEffect(() => {
    if (onDuplicateFlash) {
      onDuplicateFlash(triggerRedFlash as any);
    }
  }, [onDuplicateFlash, triggerRedFlash]);

  const stopNativeScanning = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const switchCamera = useCallback(() => {
    if (cameras.length === 0) return;

    stopNativeScanning();

    // Cycle to next camera
    const nextIndex = (currentCameraIndex + 1) % cameras.length;
    setCurrentCameraIndex(nextIndex);
    setCurrentCameraLabel(cameras[nextIndex].label || `Camera ${nextIndex + 1}`);

    console.log('[SmartScanner] Switching to camera:', cameras[nextIndex].label);
  }, [cameras, currentCameraIndex]);

  const startNativeScanning = async () => {
    try {
      const currentCamera = cameras[currentCameraIndex];
      const constraints: MediaStreamConstraints = {
        video: currentCamera?.deviceId
          ? {
              deviceId: { exact: currentCamera.deviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      streamRef.current = stream;

      if (videoRef.current && isMountedRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        scanContinuously();
      }
    } catch (err) {
      console.error('[SmartScanner] Camera error:', err);
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };

  const scanContinuously = async () => {
    if (!videoRef.current || !canvasRef.current || !isMountedRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const barcodeDetector = new window.BarcodeDetector({
      formats: [
        'code_128',
        'code_39',
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'qr_code',
        'data_matrix',
      ],
    });

    const detect = async () => {
      if (!isMountedRef.current) return;

      if (!video.readyState || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      // Compute target ratio from container dimensions (dynamic for layout flip)
      const container = video.parentElement;
      const containerW = container?.clientWidth || video.videoWidth;
      const containerH = container?.clientHeight || video.videoHeight;
      const videoRatio = video.videoWidth / video.videoHeight;
      const targetRatio = containerW / Math.max(containerH, 1);

      let sWidth, sHeight, sx, sy;

      if (videoRatio > targetRatio) {
        sHeight = video.videoHeight;
        sWidth = sHeight * targetRatio;
        sx = (video.videoWidth - sWidth) / 2;
        sy = 0;
      } else {
        sWidth = video.videoWidth;
        sHeight = sWidth / targetRatio;
        sx = 0;
        sy = (video.videoHeight - sHeight) / 2;
      }

      canvas.width = sWidth;
      canvas.height = sHeight;

      ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);

      try {
        const barcodes = await barcodeDetector.detect(canvas);

        if (barcodes.length > 0) {
          const barcode = barcodes[0].rawValue;
          const now = Date.now();

          // Increase cooldown to 5 seconds to prevent rapid duplicate scans
          if (barcode !== lastScannedRef.current || now - lastScanTimeRef.current > 5000) {
            lastScannedRef.current = barcode;
            lastScanTimeRef.current = now;

            setFlashColor('green');
            setTimeout(() => setFlashColor(null), 200);

            // Vibration handled by parent component with settings check

            const parsedData = parseIsraeliBarcode(barcode) || {
              type: 'unknown',
              sku: barcode,
              weight: 0,
              expiry: '',
              raw_barcode: barcode,
              expiry_source: 'ocr_required' as const
            };

            const imageData = canvas.toDataURL('image/jpeg', 0.8);
            onBarcodeDetected(barcode, parsedData, imageData);
          }
        }
      } catch (err) {
        console.error('[SmartScanner] Detection error:', err);
      }

      animationFrameRef.current = requestAnimationFrame(detect);
    };

    detect();
  };

  useEffect(() => {
    if (isSupported === true && cameras.length > 0) {
      startNativeScanning();
    }
    return () => {
      stopNativeScanning();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, currentCameraIndex, cameras.length]);

  // Loading state
  if (isSupported === null) {
    return (
      <div className={`w-full bg-gray-800 rounded-lg flex items-center justify-center ${className || 'aspect-square'}`}>
        <p className="text-gray-400">Initializing scanner...</p>
      </div>
    );
  }

  // Browser not supported
  if (!isSupported) {
    return (
      <div className={`w-full bg-gray-800 rounded-lg flex flex-col items-center justify-center gap-3 p-6 ${className || 'aspect-square'}`}>
        <AlertTriangle className="w-10 h-10 text-amber-400" />
        <p className="text-white font-medium text-center">Browser Not Supported</p>
        <p className="text-gray-400 text-sm text-center">
          This browser does not support the BarcodeDetector API.
          Please use Chrome or Edge on Android for barcode scanning.
        </p>
      </div>
    );
  }

  // Native scanner
  return (
    <div className={`relative w-full bg-black rounded-lg overflow-hidden ${className || 'aspect-square'}`}>
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        muted
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Camera flash overlay */}
      {flashColor && (
        <div
          className={`absolute inset-0 pointer-events-none ${flashColor === 'green' ? 'bg-green-400/70' : 'bg-red-500/70'
            }`}
          style={{
            animation: 'cameraFlash 0.2s ease-out',
            zIndex: 10
          }}
        />
      )}

      {/* Minimal scanning indicator */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Target box */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-72 h-72 border-4 border-green-400 rounded-lg animate-pulse" />
        </div>
        {/* Active scanner indicator */}
        <div className="absolute top-2 left-2">
          <div className="flex items-center gap-1 bg-green-600/80 px-2 py-1 rounded-full">
            <div className="w-2 h-2 bg-green-300 rounded-full animate-pulse"></div>
            <ScanLine className="w-3 h-3 text-white" />
          </div>
        </div>
        {/* Camera switch button */}
        {cameras.length > 1 && (
          <div className="absolute top-2 right-2 pointer-events-auto">
            <button
              onClick={switchCamera}
              className="flex items-center gap-1.5 bg-gray-900/80 hover:bg-gray-800/80 px-3 py-2 rounded-full text-white text-xs font-medium transition-colors backdrop-blur-sm border border-gray-600/50"
              aria-label="Switch camera"
              title={`Switch camera (${currentCameraIndex + 1}/${cameras.length})`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="max-w-[120px] truncate">
                {currentCameraLabel.replace(/\(.*?\)/g, '').trim() || 'Camera'}
              </span>
            </button>
          </div>
        )}

      </div>

      {/* Flash animation CSS */}
      <style jsx>{`
        @keyframes cameraFlash {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
