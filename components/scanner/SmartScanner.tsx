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

// localStorage key for the worker's preferred-camera deviceId. Survives
// the per-pallet SmartScanner remounts triggered by the `key` prop on
// pallet-verify, and across page reloads. Picked up at mount time;
// updated whenever the worker taps the camera-switch button.
const CAMERA_PREFERENCE_KEY = 'pallet-scanner:preferred-camera-device-id';

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
  // Visible diagnostic state — surfaces silent camera failures to the user.
  const [diag, setDiag] = useState<
    | { state: 'init' }
    | { state: 'ready' }
    | { state: 'no_cameras' }
    | { state: 'error'; message: string }
  >({ state: 'init' });

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

  // Enumerate available cameras and pick a sensible default.
  //
  // The selection priority is, in order:
  //   1. Worker's saved preference from localStorage (their explicit
  //      camera-switch choice from a previous session/pallet).
  //   2. The OS-picked rear camera — captured by reading deviceId off the
  //      track returned from `getUserMedia({ facingMode: 'environment' })`.
  //      This is what the OS considers "the back camera" — on Samsung
  //      phones (S21 FE, S25 Ultra, …) it's the main lens, NOT the
  //      ultrawide that the previous label-based logic happened to pick.
  //   3. Label heuristic that prefers main/wide and avoids ultrawide /
  //      telephoto / macro lenses.
  //   4. Any back-labelled camera.
  //   5. First device.
  const enumerateCameras = useCallback(async () => {
    try {
      // Step 1: probe with facingMode='environment' to (a) trigger the
      // permission prompt so labels become available, and (b) read off
      // the deviceId the OS selected for "the rear camera" — which is
      // the system-default main lens on every modern Android phone.
      let osDefaultDeviceId: string | undefined;
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        const track = tempStream.getVideoTracks()[0];
        osDefaultDeviceId = track?.getSettings().deviceId;
        tempStream.getTracks().forEach((t) => t.stop());
      } catch (probeErr) {
        // Permission prompt rejected, no camera, etc. We can still try
        // enumerateDevices below — it'll just have empty labels.
        console.warn('[SmartScanner] facingMode probe failed:', probeErr);
      }

      // Step 2: full enumeration (labels are now populated thanks to step 1).
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');

      console.log(
        '[SmartScanner] Found cameras:',
        videoDevices.map((d) => ({
          id: d.deviceId.slice(0, 8) + '...',
          label: d.label,
          isOsDefault: d.deviceId === osDefaultDeviceId,
        })),
      );

      if (videoDevices.length === 0) {
        console.error('[SmartScanner] No cameras found');
        setDiag({ state: 'no_cameras' });
        return;
      }

      setCameras(videoDevices);

      let chosenIndex = -1;
      let pickedBy = '';

      // (1) Saved preference — user previously hit camera-switch.
      try {
        const saved = window.localStorage?.getItem(CAMERA_PREFERENCE_KEY);
        if (saved) {
          const i = videoDevices.findIndex((d) => d.deviceId === saved);
          if (i !== -1) {
            chosenIndex = i;
            pickedBy = 'saved-preference';
          }
        }
      } catch {
        // localStorage may throw (privacy mode); ignore.
      }

      // (2) OS-picked rear camera — the right answer on Samsung phones.
      if (chosenIndex === -1 && osDefaultDeviceId) {
        const i = videoDevices.findIndex((d) => d.deviceId === osDefaultDeviceId);
        if (i !== -1) {
          chosenIndex = i;
          pickedBy = 'os-default';
        }
      }

      // (3) Label heuristic — pick main/wide, skip ultra/tele/macro.
      if (chosenIndex === -1) {
        const isBack = (s: string) =>
          /back|rear|environment|traseira/i.test(s);
        const isAuxLens = (s: string) =>
          /ultra|tele|macro|wide-?angle|2\s*x|3\s*x|5\s*x/i.test(s);
        const i = videoDevices.findIndex(
          (d) => isBack(d.label) && !isAuxLens(d.label),
        );
        if (i !== -1) {
          chosenIndex = i;
          pickedBy = 'label-heuristic';
        }
      }

      // (4) Any back-labelled camera.
      if (chosenIndex === -1) {
        const i = videoDevices.findIndex((d) =>
          /back|rear|environment|traseira/i.test(d.label),
        );
        if (i !== -1) {
          chosenIndex = i;
          pickedBy = 'any-back';
        }
      }

      // (5) Fallback to first device.
      if (chosenIndex === -1) {
        chosenIndex = 0;
        pickedBy = 'first-device';
      }

      const chosen = videoDevices[chosenIndex];
      console.log(
        `[SmartScanner] Default camera (${pickedBy}): ${chosen.label || 'unlabelled'}`,
      );
      setCurrentCameraIndex(chosenIndex);
      setCurrentCameraLabel(chosen.label || 'Camera');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[SmartScanner] Failed to enumerate cameras:', err);
      setDiag({ state: 'error', message });
      onError?.(message);
    }
  }, [onError]);

  useEffect(() => {
    // Re-arm the mounted flag every time this effect runs so a key-driven
    // remount doesn't leave us stuck with isMountedRef.current === false
    // from a previous instance's cleanup.
    isMountedRef.current = true;

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

    // Persist this explicit choice — survives the per-pallet
    // SmartScanner remount (driven by the `key` prop on pallet-verify)
    // and across page reloads. Without this the worker had to switch
    // away from ultrawide on every single pallet.
    try {
      window.localStorage?.setItem(CAMERA_PREFERENCE_KEY, nextCamera.deviceId);
    } catch {
      // localStorage may throw (privacy mode); preference just won't persist.
    }

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
        setDiag({ state: 'ready' });
        scanContinuously();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[SmartScanner] Camera error:', err);
      setDiag({ state: 'error', message });
      onError?.(message);
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

          // Multi-read validation: require 2 consecutive identical reads within 3 seconds
          const pending = pendingReadsRef.current;

          if (!pending || pending.barcode !== barcode || now - pending.timestamp > 3000) {
            pendingReadsRef.current = { barcode, count: 1, timestamp: now };
            setCaptureCount(1);
            animationFrameRef.current = requestAnimationFrame(detect);
            return;
          }

          pending.count++;
          setCaptureCount(pending.count);

          if (pending.count < 2) {
            animationFrameRef.current = requestAnimationFrame(detect);
            return;
          }

          // SUCCESS: 2 identical reads confirmed
          console.log('[SmartScanner] Barcode confirmed:', barcode);
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

      {/* Diagnostic overlay — visible camera state for debugging silent failures */}
      {diag.state !== 'ready' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 text-white p-6 text-center">
          {diag.state === 'init' && (
            <>
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white mb-4" />
              <p className="text-base font-medium">Requesting camera permission…</p>
              <p className="text-xs text-gray-400 mt-2">Tap “Allow” if your browser asks for camera access.</p>
            </>
          )}
          {diag.state === 'no_cameras' && (
            <>
              <AlertTriangle className="w-10 h-10 text-amber-400 mb-3" />
              <p className="text-base font-semibold">No cameras detected</p>
              <p className="text-xs text-gray-300 mt-2 max-w-xs">
                Your device reported no video input. If you opened this link inside WhatsApp, tap “Open in browser” (Chrome on Android, Safari on iOS) and try again.
              </p>
              <button
                onClick={() => {
                  setDiag({ state: 'init' });
                  enumerateCameras();
                }}
                className="mt-4 bg-white text-gray-900 px-5 py-2 rounded-lg text-sm font-semibold"
              >
                Retry
              </button>
            </>
          )}
          {diag.state === 'error' && (
            <>
              <AlertTriangle className="w-10 h-10 text-red-400 mb-3" />
              <p className="text-base font-semibold">Camera error</p>
              <p className="text-xs text-red-200 mt-2 break-words max-w-xs font-mono">
                {diag.message}
              </p>
              <p className="text-xs text-gray-400 mt-3 max-w-xs">
                Common fixes: open the link in Chrome/Safari (not WhatsApp&apos;s in-app browser), check Settings → Site permissions → Camera, then tap Retry.
              </p>
              <button
                onClick={() => {
                  setDiag({ state: 'init' });
                  enumerateCameras();
                }}
                className="mt-4 bg-white text-gray-900 px-5 py-2 rounded-lg text-sm font-semibold"
              >
                Retry
              </button>
            </>
          )}
        </div>
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
