'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { AlertTriangle, ScanLine } from 'lucide-react';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';

// Build a tiny looped silent WAV at runtime (no giant base64 literal). The
// volume-button capture trick needs an actively-playing <audio> element so the
// OS routes hardware volume-key presses to it; we then read `volumechange` as a
// capture trigger. Best-effort: flaky on some Android builds, a no-op on iOS.
function makeSilentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate; // ~1s of silence, loops cleanly
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); // 8-bit
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

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
 * Relative sharpness score (gradient energy) of a canvas. Higher = sharper.
 * Downscales to ~`sample` px wide grayscale and sums squared differences of
 * horizontally-adjacent pixels — a cheap focus/motion-blur proxy.
 */
function sharpnessScore(source: CanvasImageSource, srcW: number, srcH: number, sample = 320): number {
  if (!srcW || !srcH) return 0;
  const w = Math.min(sample, srcW);
  const h = Math.max(1, Math.round((srcH / srcW) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  if (!cx) return 0;
  cx.drawImage(source, 0, 0, w, h);
  const { data } = cx.getImageData(0, 0, w, h);
  let energy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = (y * w + x - 1) * 4;
      // luma (Rec. 601) of the two adjacent pixels
      const g1 = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const g0 = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      const d = g1 - g0;
      energy += d * d;
    }
  }
  return energy / (w * h);
}

/**
 * Capture the OCR image: grab a short burst of FULL-frame stills from the live
 * video and return the SHARPEST one as a JPEG data URL. Fixes the two capture
 * problems behind bad Hebrew name OCR — (1) the frame grabbed at barcode-
 * confirmation is motion-blurred, and (2) the barcode-detection canvas is
 * cropped, cutting off the product name. Here we use the whole frame (capped
 * at `maxWidth`) at higher quality.
 */
async function captureSharpestFrame(
  video: HTMLVideoElement,
  maxWidth = 1280,
  frames = 4,
  intervalMs = 110,
): Promise<string> {
  const vw = video.videoWidth || maxWidth;
  const vh = video.videoHeight || Math.round(maxWidth * 0.75);
  const w = Math.min(maxWidth, vw);
  const h = Math.max(1, Math.round((vh / vw) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return video as unknown as string; // unreachable; satisfies types

  let bestData = '';
  let bestScore = -1;
  for (let f = 0; f < frames; f++) {
    ctx.drawImage(video, 0, 0, w, h);
    const score = sharpnessScore(canvas, w, h);
    if (score > bestScore) {
      bestScore = score;
      bestData = canvas.toDataURL('image/jpeg', 0.9);
    }
    if (f < frames - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return bestData;
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
  const tr = useT();
  const hardwareTriggerEnabled = useSettingsStore((s) => s.hardwareTriggerEnabled);
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
  // Manual OCR-capture fallback (for boxes whose barcode won't decode — glare,
  // a label folded around a corner, or a torn/half barcode). `lastActivityRef`
  // tracks the last confirmed decode (or mount); when no decode has happened in
  // a few seconds the "capture anyway" button surfaces prominently.
  const lastActivityRef = useRef<number>(Date.now());
  const [showCaptureHint, setShowCaptureHint] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
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
  // On Samsung phones (S21 FE, S25 Ultra) the OS often returns the
  // ULTRAWIDE camera for `facingMode: 'environment'`, even though the
  // worker wants the MAIN lens. Labels alone don't disambiguate either
  // (some labels are just "camera2 0", with no descriptive text). The
  // signal that DOES discriminate reliably is `track.getCapabilities()`:
  // main back cameras virtually always advertise `zoom.max >= 2`;
  // ultrawide / fixed-FoV lenses report no zoom or zoom.max == 1.
  //
  // Selection priority (first hit wins):
  //   1. Worker's saved preference from localStorage.
  //   2. Lowest-numbered back camera (`camera 0, facing back` over
  //      `camera 2, facing back`). Samsung's Camera2 HAL consistently
  //      puts the main lens at camera 0; its facingMode='environment'
  //      default is the ULTRAWIDE (camera 2) which ALSO reports zoom>=2,
  //      so all the capability-based rules below pick wrong on Samsung.
  //      The label number is the only reliable discriminator. Falls
  //      through cleanly when labels don't match (iOS, custom skins).
  //   3. OS-picked rear camera, IF its capabilities advertise zoom — i.e.
  //      it's the main lens on most phones. Free check: we already have
  //      the stream open from the permission probe.
  //   4. Probe the other back cameras one at a time (briefly) and pick
  //      the first one with `zoom.max >= 2`. ~500ms per probe; only
  //      runs on first mount when nothing's saved AND the OS default
  //      is the wrong lens.
  //   5. OS-picked rear camera (even without zoom).
  //   6. Label heuristic that prefers main/wide and avoids
  //      ultrawide / telephoto / macro tags.
  //   7. Any back-labelled camera.
  //   8. First device.
  const enumerateCameras = useCallback(async () => {
    try {
      // Helper: open a track briefly, return whether it has zoom >= 2.
      const probeHasZoom = async (deviceId: string): Promise<boolean> => {
        let stream: MediaStream | null = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId } },
            audio: false,
          });
          const track = stream.getVideoTracks()[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const caps = (track?.getCapabilities?.() as any) || {};
          return !!(caps.zoom && typeof caps.zoom.max === 'number' && caps.zoom.max >= 2);
        } catch {
          return false;
        } finally {
          stream?.getTracks().forEach((t) => t.stop());
        }
      };

      // Step 1: probe with facingMode='environment' to (a) trigger the
      // permission prompt so labels populate, (b) read the deviceId the
      // OS picked, and (c) check whether that camera supports zoom.
      let osDefaultDeviceId: string | undefined;
      let osDefaultHasZoom = false;
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        const track = tempStream.getVideoTracks()[0];
        osDefaultDeviceId = track?.getSettings().deviceId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const caps = (track?.getCapabilities?.() as any) || {};
        osDefaultHasZoom = !!(caps.zoom && typeof caps.zoom.max === 'number' && caps.zoom.max >= 2);
        tempStream.getTracks().forEach((t) => t.stop());
      } catch (probeErr) {
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
          osDefaultHasZoom: d.deviceId === osDefaultDeviceId ? osDefaultHasZoom : undefined,
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

      // (2) Lowest-numbered back camera. On Samsung's Camera2 HAL labels
      // ("camera 0, facing back", "camera 2, facing back", …) camera 0 is
      // consistently the main lens — but the OS default for
      // facingMode='environment' returns the ULTRAWIDE (camera 2) and
      // even reports zoom>=2, defeating the rules below. The label
      // numbering is the only reliable discriminator on this hardware.
      // Falls through cleanly when labels don't match this format
      // (iOS Safari, custom Android skins, etc.).
      if (chosenIndex === -1) {
        const isBack = (s: string) =>
          /back|rear|environment|traseira/i.test(s);
        const numberedBacks = videoDevices
          .map((d, i) => {
            if (!isBack(d.label || '')) return null;
            const m = /\bcamera\s*(\d+)/i.exec(d.label || '');
            return m ? { device: d, index: i, number: parseInt(m[1], 10) } : null;
          })
          .filter((x): x is { device: MediaDeviceInfo; index: number; number: number } => x !== null);
        if (numberedBacks.length >= 2) {
          numberedBacks.sort((a, b) => a.number - b.number);
          const winner = numberedBacks[0];
          chosenIndex = winner.index;
          pickedBy = `lowest-back-number(camera ${winner.number})`;
        }
      }

      // (3) OS default + has zoom — that's the main lens on most phones.
      if (chosenIndex === -1 && osDefaultDeviceId && osDefaultHasZoom) {
        const i = videoDevices.findIndex((d) => d.deviceId === osDefaultDeviceId);
        if (i !== -1) {
          chosenIndex = i;
          pickedBy = 'os-default-with-zoom';
        }
      }

      // (4) Probe other back cameras for zoom support — finds the main
      // lens on Samsung where the OS default is the ultrawide.
      if (chosenIndex === -1) {
        const isFront = (s: string) => /front|user|face/i.test(s);
        const candidates = videoDevices
          .map((d, i) => ({ device: d, index: i }))
          .filter(
            ({ device }) =>
              !isFront(device.label) && device.deviceId !== osDefaultDeviceId,
          );
        for (const { device, index } of candidates) {
          // eslint-disable-next-line no-await-in-loop
          const hasZoom = await probeHasZoom(device.deviceId);
          if (hasZoom) {
            chosenIndex = index;
            pickedBy = 'probe-zoom-capable';
            break;
          }
        }
      }

      // (5) OS default (fallback even if it had no zoom — better than nothing).
      if (chosenIndex === -1 && osDefaultDeviceId) {
        const i = videoDevices.findIndex((d) => d.deviceId === osDefaultDeviceId);
        if (i !== -1) {
          chosenIndex = i;
          pickedBy = 'os-default-fallback';
        }
      }

      // (6) Label heuristic — prefer main/wide, skip ultra/tele/macro.
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

      // (7) Any back-labelled camera.
      if (chosenIndex === -1) {
        const i = videoDevices.findIndex((d) =>
          /back|rear|environment|traseira/i.test(d.label),
        );
        if (i !== -1) {
          chosenIndex = i;
          pickedBy = 'any-back';
        }
      }

      // (8) Fallback to first device.
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

  // Surface the "capture anyway" button prominently once a few seconds pass
  // with no successful decode (worker is fighting glare / a damaged barcode).
  useEffect(() => {
    const id = setInterval(() => {
      setShowCaptureHint(!isInCooldown && Date.now() - lastActivityRef.current > 3500);
    }, 1000);
    return () => clearInterval(id);
  }, [isInCooldown]);

  // Manual OCR capture: grab the sharpest full frame and hand it to the parent
  // WITHOUT a decoded barcode. OCR then reads the name/weight AND the printed
  // digit string under the barcode (used as the dedupe ID). Guarded against the
  // post-scan cooldown and rapid re-taps.
  const handleManualCaptureClick = useCallback(async () => {
    if (isInCooldown || captureBusy || !onManualCapture) return;
    const video = videoRef.current;
    if (!video) return;
    setCaptureBusy(true);
    setFlashColor('green');
    setTimeout(() => setFlashColor(null), 200);
    try {
      const imageData = await captureSharpestFrame(video).catch(() => {
        const c = canvasRef.current;
        return c ? c.toDataURL('image/jpeg', 0.9) : '';
      });
      if (imageData) onManualCapture(imageData);
      lastActivityRef.current = Date.now();
      setShowCaptureHint(false);
    } finally {
      setTimeout(() => setCaptureBusy(false), 1200);
    }
  }, [isInCooldown, captureBusy, onManualCapture]);

  // ── Hardware capture trigger: Bluetooth remote keystroke ──
  // Opt-in (settings). A paired BT camera-remote / ring clicker emits a real
  // keydown; we fire the same manual-capture path. Deterministic — one press =
  // one capture (handleManualCaptureClick is debounced by cooldown/captureBusy,
  // so a held or repeated key can't double-fire). Ignored while typing.
  useEffect(() => {
    if (!hardwareTriggerEnabled || !onManualCapture) return;
    const TRIGGER_KEYS = new Set([
      'Enter', ' ', 'Spacebar', 'ArrowUp', 'ArrowDown',
      'AudioVolumeUp', 'AudioVolumeDown', 'VolumeUp', 'VolumeDown',
      'MediaPlayPause',
    ]);
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
      ) {
        return; // don't hijack count inputs / the edit modal
      }
      if (!TRIGGER_KEYS.has(e.key)) return;
      e.preventDefault();
      handleManualCaptureClick();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hardwareTriggerEnabled, onManualCapture, handleManualCaptureClick]);

  // ── Hardware capture trigger: phone volume button (volumechange hack) ──
  // Opt-in (settings). Play a silent looped <audio> so the OS routes hardware
  // volume presses to it, then treat any volume change as a capture and
  // re-center the level. Best-effort — known to be flaky on some Android builds
  // and inert on iOS; the on-screen button + BT remote are the reliable paths.
  useEffect(() => {
    if (!hardwareTriggerEnabled || !onManualCapture) return;
    if (typeof window === 'undefined') return;
    const url = makeSilentWavUrl();
    const audio = document.createElement('audio');
    audio.loop = true;
    audio.src = url;
    audio.volume = 0.5;
    let ready = false;     // ignore the volumechange from our own initial set
    let resetting = false; // ignore the volumechange from our re-center
    const onVolume = () => {
      if (!ready || resetting) return;
      resetting = true;
      handleManualCaptureClick();
      audio.volume = 0.5; // headroom for the next press in either direction
      setTimeout(() => { resetting = false; }, 60);
    };
    const tryPlay = () => {
      audio.play().then(() => { ready = true; }).catch(() => { /* needs gesture */ });
    };
    audio.addEventListener('volumechange', onVolume);
    tryPlay();
    // Autoplay is often blocked until a user gesture — retry on the first tap.
    const onGesture = () => tryPlay();
    window.addEventListener('pointerdown', onGesture, { once: true });
    return () => {
      audio.removeEventListener('volumechange', onVolume);
      window.removeEventListener('pointerdown', onGesture);
      audio.pause();
      audio.src = '';
      URL.revokeObjectURL(url);
    };
  }, [hardwareTriggerEnabled, onManualCapture, handleManualCaptureClick]);

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
          lastActivityRef.current = now; // a decode just happened — reset the manual-capture nudge

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

          // OCR image: sharpest of a short burst of FULL-frame stills (not the
          // cropped barcode region) so the whole sticker is captured and motion
          // blur from the aiming moment is avoided. Runs inside the 3s cooldown.
          const imageData = await captureSharpestFrame(video).catch(
            () => canvas.toDataURL('image/jpeg', 0.9),
          );
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

  // Resume the camera after the page comes back from background. Mobile
  // browsers freeze MediaStream tracks while the tab is hidden; on return
  // they don't restart, so the worker sees a frozen frame until reload.
  // We restart only when we can prove the existing stream is dead (a track
  // is no longer `live` OR the <video> is paused) — so a clean foreground
  // tab-switch doesn't cause an unnecessary camera flicker.
  useEffect(() => {
    function isStreamDead() {
      const s = streamRef.current;
      if (!s) return false; // never started yet — let the normal effects handle it
      if (videoRef.current?.paused) return true;
      return !s.getVideoTracks().some((t) => t.readyState === 'live');
    }
    function maybeRestart() {
      if (!isMountedRef.current) return;
      if (document.visibilityState !== 'visible') return;
      if (isSupported !== true || cameras.length === 0) return;
      if (!isStreamDead()) return;
      console.log('[SmartScanner] Resuming from background — stream dead, restarting');
      stopNativeScanning();
      startNativeScanning();
    }
    document.addEventListener('visibilitychange', maybeRestart);
    window.addEventListener('pageshow', maybeRestart);
    return () => {
      document.removeEventListener('visibilitychange', maybeRestart);
      window.removeEventListener('pageshow', maybeRestart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, cameras.length]);

  // Loading state
  if (isSupported === null) {
    return (
      <div className={`w-full bg-gray-800 rounded-lg flex items-center justify-center ${className || 'aspect-square'}`}>
        <p className="text-gray-400">{tr('scanner.initializing')}</p>
      </div>
    );
  }

  // Browser not supported
  if (!isSupported) {
    return (
      <div className={`w-full bg-gray-800 rounded-lg flex flex-col items-center justify-center gap-3 p-6 ${className || 'aspect-square'}`}>
        <AlertTriangle className="w-10 h-10 text-amber-400" />
        <p className="text-white font-medium text-center">{tr('scanner.notSupportedTitle')}</p>
        <p className="text-gray-400 text-sm text-center">
          {tr('scanner.notSupportedDesc')}
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
              <p className="text-base font-medium">{tr('scanner.requestingPermission')}</p>
              <p className="text-xs text-gray-400 mt-2">{tr('scanner.permissionHint')}</p>
            </>
          )}
          {diag.state === 'no_cameras' && (
            <>
              <AlertTriangle className="w-10 h-10 text-amber-400 mb-3" />
              <p className="text-base font-semibold">{tr('scanner.noCamerasTitle')}</p>
              <p className="text-xs text-gray-300 mt-2 max-w-xs">
                {tr('scanner.noCamerasDesc')}
              </p>
              <button
                onClick={() => {
                  setDiag({ state: 'init' });
                  enumerateCameras();
                }}
                className="mt-4 bg-white text-gray-900 px-5 py-2 rounded-lg text-sm font-semibold"
              >
                {tr('common.retry')}
              </button>
            </>
          )}
          {diag.state === 'error' && (
            <>
              <AlertTriangle className="w-10 h-10 text-red-400 mb-3" />
              <p className="text-base font-semibold">{tr('scanner.cameraErrorTitle')}</p>
              <p className="text-xs text-red-200 mt-2 break-words max-w-xs font-mono" dir="ltr">
                {diag.message}
              </p>
              <p className="text-xs text-gray-400 mt-3 max-w-xs">
                {tr('scanner.cameraErrorHint')}
              </p>
              <button
                onClick={() => {
                  setDiag({ state: 'init' });
                  enumerateCameras();
                }}
                className="mt-4 bg-white text-gray-900 px-5 py-2 rounded-lg text-sm font-semibold"
              >
                {tr('common.retry')}
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
                  <span className="text-base font-semibold text-red-400">{tr('scanner.alreadyScanned')}</span>
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
              <span className="text-white text-xs font-bold">{tr('scanner.duplicateBadge')}</span>
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
              aria-label={tr('scanner.switchCamera')}
              title={tr('scanner.tapToSwitch')}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="max-w-[140px] truncate">
                {currentCameraLabel || tr('scanner.cameraGeneric')}
              </span>
            </button>
          </div>
        )}

        {/* Manual OCR-capture fallback — registers a box whose barcode won't
            decode (glare / folded / torn). Subtle by default; pulses once a few
            seconds pass with no decode. */}
        {onManualCapture && !isInCooldown && (
          <>
            {showCaptureHint && (
              <div className="absolute bottom-16 inset-x-0 flex justify-center px-4 pointer-events-none">
                <span className="text-xs text-amber-100 bg-black/60 px-3 py-1 rounded-full text-center max-w-[260px]">
                  {tr('scanner.captureHint')}
                </span>
              </div>
            )}
            <div className="absolute bottom-3 inset-x-0 flex justify-center pointer-events-auto">
              <button
                onClick={handleManualCaptureClick}
                disabled={captureBusy}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold transition-all backdrop-blur-sm border disabled:opacity-50 ${
                  showCaptureHint
                    ? 'bg-amber-500 text-white border-amber-300 animate-pulse shadow-lg scale-105'
                    : 'bg-gray-900/70 text-gray-200 border-gray-600/50'
                }`}
              >
                📷 {tr('scanner.captureAnyway')}
                {hardwareTriggerEnabled && (
                  <span className="ms-1 text-[10px] text-green-300 font-medium">
                    {tr('scanner.hardwareTriggerOn')}
                  </span>
                )}
              </button>
            </div>
          </>
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
