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
  const [isInCooldown, setIsInCooldown] = useState(false);
  const [cooldownTimeLeft, setCooldownTimeLeft] = useState(0);
  const [captureCount, setCaptureCount] = useState(0); // 0 | 1 | 2 | 3
  const [isDuplicate, setIsDuplicate] = useState(false);
  const duplicateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Multi-read validation to ensure barcode is read correctly
  const pendingReadsRef = useRef<{ barcode: string; count: number; timestamp: number } | null>(null);

  // GS1-128 checksum validation
  const validateGS1Checksum = (barcode: string): boolean => {
    if (barcode.length !== 31 && barcode.length !== 25) return false;

    // Calculate GS1-128 check digit (modulo 10)
    let sum = 0;
    for (let i = barcode.length - 2; i >= 0; i--) {
      const digit = parseInt(barcode[i]);
      if ((barcode.length - 1 - i) % 2 === 0) {
        sum += digit * 3;
      } else {
        sum += digit;
      }
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    const expectedCheckDigit = parseInt(barcode[barcode.length - 1]);

    return checkDigit === expectedCheckDigit;
  };

  // Enumerate available cameras (AFTER getting initial permission for labels)
  const enumerateCameras = useCallback(async () => {
    try {
      // First request permission to get proper camera labels
      const tempStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      tempStream.getTracks().forEach(track => track.stop());

      // Now enumerate - labels will be available
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');

      console.log('[SmartScanner] Found cameras:', videoDevices.map(d => ({
        id: d.deviceId.slice(0, 8) + '...',
        label: d.label
      })));

      if (videoDevices.length === 0) {
        console.error('[SmartScanner] No cameras found');
        return;
      }

      setCameras(videoDevices);

      // Find back camera as default (check for back/rear/environment keywords)
      let backCameraIndex = videoDevices.findIndex(device =>
        device.label.toLowerCase().includes('back') ||
        device.label.toLowerCase().includes('rear') ||
        device.label.toLowerCase().includes('environment') ||
        device.label.toLowerCase().includes('traseira') // Portuguese
      );

      // If no back camera found by label, assume first camera is back (mobile convention)
      if (backCameraIndex === -1 && videoDevices.length > 1) {
        backCameraIndex = 0;
        console.log('[SmartScanner] No back camera label found, using first camera');
      }

      if (backCameraIndex !== -1) {
        setCurrentCameraIndex(backCameraIndex);
        setCurrentCameraLabel(videoDevices[backCameraIndex].label || 'Back Camera');
      } else {
        setCurrentCameraIndex(0);
        setCurrentCameraLabel(videoDevices[0].label || 'Camera');
      }
    } catch (err) {
      console.error('[SmartScanner] Failed to enumerate cameras:', err);
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }, [onError]);

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

  // Function to trigger duplicate indicator (called by parent on duplicate detection)
  const triggerRedFlash = useCallback(() => {
    setIsDuplicate(true);
    if (duplicateTimerRef.current) clearTimeout(duplicateTimerRef.current);
    duplicateTimerRef.current = setTimeout(() => setIsDuplicate(false), 1000);
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
    const nextCamera = cameras[nextIndex];

    setCurrentCameraIndex(nextIndex);

    // Create informative label
    let label = nextCamera.label || `Camera ${nextIndex + 1}`;

    // Simplify label (remove technical IDs in parentheses)
    label = label.replace(/\([^)]*\)/g, '').trim();

    // Add position indicator
    label = `${label} (${nextIndex + 1}/${cameras.length})`;

    setCurrentCameraLabel(label);

    console.log('[SmartScanner] Switching to camera:', nextCamera.label, nextCamera.deviceId.slice(0, 8) + '...');
  }, [cameras, currentCameraIndex]);

  const startNativeScanning = async () => {
    try {
      const currentCamera = cameras[currentCameraIndex];

      if (!currentCamera) {
        console.error('[SmartScanner] No camera selected');
        return;
      }

      console.log('[SmartScanner] Starting camera:', currentCamera.label, currentCamera.deviceId.slice(0, 8) + '...');

      // Try with deviceId first, with flexible constraints
      let stream: MediaStream | null = null;

      try {
        // Attempt 1: Use specific deviceId (preferred method)
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: currentCamera.deviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        console.log('[SmartScanner] Camera started with deviceId');
      } catch (deviceIdError) {
        console.warn('[SmartScanner] Failed with deviceId, trying with facingMode fallback:', deviceIdError);

        // Attempt 2: Fallback to facingMode (less precise but more compatible)
        const isFrontCamera = currentCamera.label.toLowerCase().includes('front') ||
                              currentCamera.label.toLowerCase().includes('user') ||
                              currentCamera.label.toLowerCase().includes('face');

        const facingMode = isFrontCamera ? 'user' : 'environment';

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 }, // Lower resolution for compatibility
            height: { ideal: 720 },
          },
          audio: false,
        });
        console.log('[SmartScanner] Camera started with facingMode:', facingMode);
      }

      if (!stream) {
        throw new Error('Failed to get camera stream');
      }

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

          // Log format info (no blocking — let all detected barcodes through)
          const isGS1Format = /^\d{25}$|^\d{31}$/.test(barcode);
          if (!isGS1Format) {
            console.log('[SmartScanner] Non-standard barcode length:', barcode.length, 'digits — passing through');
          }

          // Multi-read validation: require 2 consecutive identical reads within 3 seconds
          // to filter out single misreads caused by blur/motion, while staying fast.
          const pending = pendingReadsRef.current;

          if (!pending || pending.barcode !== barcode || now - pending.timestamp > 3000) {
            // First read or different barcode or timeout - start new validation
            pendingReadsRef.current = { barcode, count: 1, timestamp: now };
            setCaptureCount(1);
            console.log('[SmartScanner] Barcode read 1/2:', barcode);
            animationFrameRef.current = requestAnimationFrame(detect);
            return;
          }

          // Same barcode read again - increment count
          pending.count++;
          setCaptureCount(pending.count);
          console.log(`[SmartScanner] Barcode read ${pending.count}/2:`, barcode);

          if (pending.count < 2) {
            // Need one more confirmation
            animationFrameRef.current = requestAnimationFrame(detect);
            return;
          }

          // SUCCESS: 2 identical reads confirmed! Process the scan
          console.log('[SmartScanner] Barcode CONFIRMED after 2 identical reads:', barcode);
          pendingReadsRef.current = null;
          setCaptureCount(0);

          // Check cooldown
          const timeSinceLastScan = now - lastScanTimeRef.current;
          if (timeSinceLastScan < 3000) {
            console.log('[SmartScanner] Cooldown active, ignoring confirmed scan');
            animationFrameRef.current = requestAnimationFrame(detect);
            return;
          }

          // Process confirmed scan
          lastScannedRef.current = barcode;
          lastScanTimeRef.current = now;

          // Set cooldown state
          setIsInCooldown(true);
          setCooldownTimeLeft(3);

          // Start cooldown countdown timer
          let countdown = 3;
          const countdownInterval = setInterval(() => {
            countdown--;
            setCooldownTimeLeft(countdown);
            if (countdown <= 0) {
              clearInterval(countdownInterval);
              setIsInCooldown(false);
            }
          }, 1000);

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
          <div className="relative" style={{ width: 240, height: 240 }}>

            {/* === COOLDOWN STATE === */}
            {isInCooldown && (
              <>
                <div className="absolute inset-0 border-[3px] border-red-500 rounded" />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-6xl font-bold text-red-400">
                    {cooldownTimeLeft}
                  </span>
                </div>
              </>
            )}

            {/* === DUPLICATE STATE === */}
            {!isInCooldown && isDuplicate && (
              <>
                <div className="absolute inset-0 border-[3px] border-red-500 rounded" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-base font-semibold text-red-400">Already scanned</span>
                </div>
              </>
            )}

            {/* === IDLE / CAPTURING STATE (green trail) === */}
            {!isInCooldown && !isDuplicate && (
              <>
                {/* Dim green base border (shows unfilled portion) */}
                <div className="absolute inset-0 border-[3px] border-green-400/25 rounded" />

                {/* SVG trail overlay */}
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  viewBox="0 0 240 240"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect
                    x="1.5" y="1.5"
                    width="237" height="237"
                    rx="4"
                    fill="none"
                    stroke="rgb(74, 222, 128)"
                    strokeWidth="3"
                    pathLength="1"
                    strokeDasharray="1"
                    strokeDashoffset={
                      captureCount === 0 ? 1 :
                      captureCount === 1 ? 0.5 : 0
                    }
                    style={{
                      transition: captureCount > 0 ? 'stroke-dashoffset 0.25s ease-out' : 'none',
                    }}
                  />
                </svg>
              </>
            )}

          </div>
        </div>
        {/* Active scanner indicator */}
        <div className="absolute top-2 left-2">
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full ${
            (isInCooldown || isDuplicate) ? 'bg-red-600/80' : 'bg-green-600/80'
          }`}>
            <div className={`w-2 h-2 rounded-full ${
              (isInCooldown || isDuplicate) ? 'bg-red-300' : 'bg-green-300 animate-pulse'
            }`}></div>
            {isInCooldown ? (
              <span className="text-white text-xs font-bold">{cooldownTimeLeft}s</span>
            ) : isDuplicate ? (
              <span className="text-white text-xs font-bold">Duplicate</span>
            ) : (
              <ScanLine className="w-3 h-3 text-white" />
            )}
          </div>
        </div>
        {/* Camera switch button */}
        {cameras.length > 1 && (
          <div className="absolute top-2 right-2 pointer-events-auto">
            <button
              onClick={switchCamera}
              className="flex items-center gap-1.5 bg-gray-900/80 hover:bg-gray-800/80 px-3 py-2 rounded-full text-white text-xs font-medium transition-colors backdrop-blur-sm border border-gray-600/50"
              aria-label="Switch camera"
              title="Tap to switch camera"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="max-w-[140px] truncate">
                {currentCameraLabel || 'Camera'}
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
