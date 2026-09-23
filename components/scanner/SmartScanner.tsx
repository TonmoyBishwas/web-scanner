'use client';

import { useEffect, useState, useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, ScanLine, Camera, Check, X } from 'lucide-react';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';
import { useT } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';

/** Why a read was rejected — decides the label on the red hold. */
export type RejectKind = 'duplicate' | 'rejected';

interface SmartScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode, imageData?: string) => void;
  onManualCapture?: (imageData: string) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  onError?: (error: string) => void;
  onScannerTypeDetected?: (type: 'native' | 'fallback') => void;
  onDuplicateFlash?: (triggerFn: (kind?: RejectKind) => void) => void;
  /**
   * Synchronous "have I already got this one?", asked the instant a barcode is
   * confirmed — BEFORE the ~400ms sharpest-frame capture that runs ahead of
   * `onBarcodeDetected`.
   *
   * Without it the scanner cannot tell a good scan from a duplicate at the
   * moment it has to paint one, so it would show its green "saved" state for
   * that whole window and only flip to red once the parent's own duplicate
   * check finally lands. Optional: a page that doesn't pass it simply keeps
   * the parent-driven `onDuplicateFlash` path, which arrives later.
   */
  isDuplicateBarcode?: (barcode: string) => boolean;
  /**
   * What the post-scan hold is allowed to claim.
   *
   * 'saved' (default): a confirmed decode IS a box added to the job, so the
   * hold says "Box N saved" — pallet-verify and the carton /scan page.
   * 'captured': the decode only *starts* something that can still fail (the
   * /issue page looks the box up on the server, and the worker then has to
   * confirm it), so the hold confirms the read without claiming the outcome.
   */
  holdClaim?: 'saved' | 'captured';
  className?: string;
  /**
   * Target-frame style. 'square' = legacy centered 240×240 box.
   * 'corner' = terminal-design corner frame, centred in the camera strip the
   * floating sheet leaves visible (see CORNER_* below).
   */
  frame?: 'square' | 'corner';
  /**
   * Freeze the scanner without tearing the camera down.
   *
   * Set while a full-screen editor is over the page: the detection loop stops
   * (so nothing in the worker's peripheral vision can be scanned while they
   * are typing) and the preview pauses, but the `MediaStream` stays open, so
   * coming back is instant and the per-pallet scan state survives. Unmounting
   * the scanner would do neither — it re-requests the camera and resets the
   * "Box N saved" counter.
   */
  paused?: boolean;
}

/**
 * Corner-frame geometry, in CSS px.
 *
 * Grown from 276×150: workers reported the old box was both small and sitting
 * high in the viewfinder, so they were tilting the phone up to fill it instead
 * of just pointing it at the carton.
 *
 * CORNER_BAND_PX is the shortest camera strip the frame will centre itself in —
 * the frame plus its label and padding. It must stay ≤ the sheet's
 * MIN_CAMERA_PX, which is what guarantees that much camera at peek/mid.
 */
/**
 * What separates a deliberate capture tap from an accidental brush.
 * 12px of travel is roughly a still finger on a handheld phone; 600ms is
 * comfortably longer than a tap and shorter than a rest.
 */
const TAP_MAX_MOVE_PX = 12;
const TAP_MAX_MS = 600;

/**
 * Headroom the manual-capture control keeps at the top of the camera region,
 * so an unusually tall sheet can push it up but never off the top edge.
 * Roughly the control's own height plus its gap.
 */
const CONTROL_BAND_PX = 56;
/**
 * Height of the manual-capture control WITH its hint chip, which is what the
 * scan frame must stay clear of. Used to lift the frame on a short camera
 * strip (a landscape tablet, the non-meat page's bounded camera) where
 * centring it would put it under the control. On a phone the strip is tall
 * enough that this term never wins and the frame stays exactly where it was.
 */
const CONTROL_STACK_PX = 100;

const CORNER_W = 320;
const CORNER_H = 196;
const CORNER_BAND_PX = 240;

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
 * Which decoder reads the frames.
 *
 * 'native' is Chrome's BarcodeDetector. On Android it is not a browser
 * feature but a thin wrapper over the Google Play Services barcode module —
 * and on a good many tablets that module is missing (no Play Services, a
 * stripped-down or enterprise image, or simply never downloaded). Chrome then
 * still exposes the class, `getSupportedFormats()` answers `[]`, and every
 * `detect()` rejects with NotSupportedError "Barcode detection service
 * unavailable". The loop used to swallow that rejection on every frame, so
 * the camera looked live while nothing ever decoded — which is exactly how
 * "auto-capture doesn't work on the tablet" presents.
 *
 * 'zxing' is the pure-JS ZXing reader (already a dependency, never wired).
 * Slower per frame and less forgiving of blur, but it works on any device
 * that can open a camera. It is the fallback for a missing BarcodeDetector,
 * for an empty format list, and for a native detector that rejects at
 * runtime.
 */
type DecodeEngine = 'native' | 'zxing';

const NATIVE_FORMATS = [
  'code_128',
  'code_39',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'qr_code',
  'data_matrix',
];

/** Consecutive native `detect()` rejections before giving up on it. */
const NATIVE_MAX_ERRORS = 3;
/** ZXing is CPU-bound: cap it at ~10 fps so the preview stays smooth. */
const ZXING_MIN_INTERVAL_MS = 100;
/**
 * Native decode cadence. ML Kit needs ~40–80 ms per frame on a mid-range
 * Android SoC (Snapdragon 680 class); handing it a frame on every animation
 * frame only queued full-resolution copies behind the UI, which is what made a
 * 4 GB phone stutter on every touch. ~12 attempts/s is still 24+ reads per
 * 2-second hold — the two-identical-reads rule never waits on this.
 */
const NATIVE_MIN_INTERVAL_MS = 80;
/**
 * Adaptive pacing: the loop waits at least this many times the detector's own
 * (smoothed) wall time between attempts, capped at DECODE_MAX_INTERVAL_MS. On
 * a phone where a detect takes 150 ms the loop backs off to ~300 ms instead of
 * feeding the detector back to back — the UI keeps most of the main thread,
 * and a 2-second hold still yields 6+ reads for the two-identical-reads rule.
 */
const DECODE_BACKOFF_FACTOR = 2;
const DECODE_MAX_INTERVAL_MS = 400;
/**
 * Longest edge of the frame handed to the decoder. A 1080×1920 stream is kept
 * for the OCR capture (the sticker text needs it), but the barcode decoder
 * only ever sees the strip of camera the worker can SEE (above the bottom
 * sheet / beside the side panel), shrunk to this edge. A carton barcode filling
 * the 320px scan frame is still ≥3 px per module after the shrink.
 */
const DECODE_MAX_EDGE_PX = 1280;

interface FrameDecoder {
  engine: DecodeEngine;
  /** Resolves the first barcode's payload in the frame, or null. Throws only for engine failure. */
  detect(source: HTMLCanvasElement | ImageBitmap): Promise<string | null>;
}

async function pickDecodeEngine(): Promise<DecodeEngine> {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return 'zxing';
  try {
    const fn = window.BarcodeDetector.getSupportedFormats;
    if (typeof fn === 'function') {
      const formats: unknown = await fn.call(window.BarcodeDetector);
      if (Array.isArray(formats) && formats.length === 0) {
        console.warn('[SmartScanner] BarcodeDetector present but supports no formats — using ZXing');
        return 'zxing';
      }
    }
  } catch (err) {
    console.warn('[SmartScanner] getSupportedFormats failed — using ZXing:', err);
    return 'zxing';
  }
  return 'native';
}

function createNativeDecoder(): FrameDecoder {
  const detector = new window.BarcodeDetector({ formats: NATIVE_FORMATS });
  return {
    engine: 'native',
    async detect(source) {
      const barcodes = await detector.detect(source);
      return barcodes.length > 0 ? String(barcodes[0].rawValue) : null;
    },
  };
}

async function createZxingDecoder(): Promise<FrameDecoder> {
  const [{ BrowserMultiFormatReader }, lib] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ]);
  const hints = new Map();
  hints.set(lib.DecodeHintType.POSSIBLE_FORMATS, [
    lib.BarcodeFormat.CODE_128,
    lib.BarcodeFormat.CODE_39,
    lib.BarcodeFormat.EAN_13,
    lib.BarcodeFormat.EAN_8,
    lib.BarcodeFormat.UPC_A,
    lib.BarcodeFormat.UPC_E,
    lib.BarcodeFormat.QR_CODE,
    lib.BarcodeFormat.DATA_MATRIX,
  ]);
  hints.set(lib.DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints);
  console.log('[SmartScanner] ZXing decoder ready');
  let lastAttempt = 0;
  return {
    engine: 'zxing',
    async detect(source) {
      // The loop only ever feeds ZXing a canvas; the bitmap path is native-only.
      if (!(source instanceof HTMLCanvasElement)) return null;
      const now = performance.now();
      if (now - lastAttempt < ZXING_MIN_INTERVAL_MS) return null;
      lastAttempt = now;
      try {
        return reader.decodeFromCanvas(source).getText();
      } catch (err) {
        // "Nothing in this frame" is the normal case, not a failure.
        if (
          err instanceof lib.NotFoundException ||
          err instanceof lib.ChecksumException ||
          err instanceof lib.FormatException
        ) {
          return null;
        }
        throw err;
      }
    },
  };
}

/**
 * Relative sharpness score (gradient energy) of a canvas. Higher = sharper.
 * Downscales to ~`sample` px wide grayscale and sums squared differences of
 * horizontally-adjacent pixels — a cheap focus/motion-blur proxy. `scratch`
 * is reused across the burst so no canvas is allocated per frame.
 */
function sharpnessScore(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  scratch: HTMLCanvasElement,
  sample = 320,
): number {
  if (!srcW || !srcH) return 0;
  const w = Math.min(sample, srcW);
  const h = Math.max(1, Math.round((srcH / srcW) * w));
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const cx = scratch.getContext('2d', { willReadFrequently: true });
  if (!cx) return 0;
  cx.drawImage(source, 0, 0, w, h);
  const { data } = cx.getImageData(0, 0, w, h);
  let energy = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let g0 = 0.299 * data[row] + 0.587 * data[row + 1] + 0.114 * data[row + 2];
    for (let x = 1; x < w; x++) {
      const i = row + x * 4;
      // luma (Rec. 601) of the two adjacent pixels
      const g1 = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const d = g1 - g0;
      energy += d * d;
      g0 = g1;
    }
  }
  return energy / (w * h);
}

/** One full frame of the live video as a JPEG data URL (no burst, no scoring). */
function snapshotFrame(video: HTMLVideoElement, maxWidth = 1280): string {
  const vw = video.videoWidth || maxWidth;
  const vh = video.videoHeight || Math.round(maxWidth * 0.75);
  const w = Math.min(maxWidth, vw);
  const h = Math.max(1, Math.round((vh / vw) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.9);
}

/**
 * Capture the OCR image: grab a short burst of FULL-frame stills from the live
 * video and return the SHARPEST one as a JPEG data URL. Fixes the two capture
 * problems behind bad Hebrew name OCR — (1) the frame grabbed at barcode-
 * confirmation is motion-blurred, and (2) the barcode-detection canvas is
 * cropped, cutting off the product name. Here we use the whole frame (capped
 * at `maxWidth`) at higher quality.
 *
 * The best frame is kept as pixels (one canvas copy) and JPEG-encoded exactly
 * once at the end. Encoding every candidate cost up to four 1080×1920 JPEG
 * encodes per scan — ~100 ms each on a low-end phone, all on the main thread.
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
  const best = document.createElement('canvas');
  best.width = w;
  best.height = h;
  const bestCtx = best.getContext('2d');
  const scratch = document.createElement('canvas');
  if (!ctx || !bestCtx) return video as unknown as string; // unreachable; satisfies types

  let bestScore = -1;
  for (let f = 0; f < frames; f++) {
    ctx.drawImage(video, 0, 0, w, h);
    const score = sharpnessScore(canvas, w, h, scratch);
    if (score > bestScore) {
      bestScore = score;
      bestCtx.drawImage(canvas, 0, 0);
    }
    if (f < frames - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return best.toDataURL('image/jpeg', 0.9);
}

/**
 * The part of the camera the worker can actually see, in VIDEO pixels, plus
 * the size the decoder should get it at.
 *
 * The <video> is object-fit: cover inside `container`; BottomSheet publishes
 * the height it covers as `--sheet-h` (or the width it takes as `--sheet-w`
 * when docked as a side panel, at the inline end — the LEFT in RTL). Anything
 * under the sheet is invisible to the worker, so decoding it is pure waste —
 * at the mid snap that is ~40 % of every frame.
 */
function decodeRegion(video: HTMLVideoElement, container: HTMLElement | null) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = container?.clientWidth || vw;
  const ch = container?.clientHeight || vh;

  let sheetH = 0;
  let sheetW = 0;
  let rtl = false;
  let dragging = false;
  if (container) {
    const cs = getComputedStyle(container);
    sheetH = parseFloat(cs.getPropertyValue('--sheet-h')) || 0;
    sheetW = parseFloat(cs.getPropertyValue('--sheet-w')) || 0;
    rtl = cs.direction === 'rtl';
    dragging = cs.getPropertyValue('--sheet-h-dur').trim() === '0s';
  }
  // Never shrink the visible strip below a third of the container — a stray
  // value in the variable must not blind the decoder.
  const visH = Math.max(ch / 3, ch - sheetH);
  const visW = Math.max(cw / 3, cw - sheetW);
  const visX = rtl && sheetW > 0 ? cw - visW : 0;

  // object-fit: cover — scale so the video fills the container, centred.
  const scale = Math.max(cw / vw, ch / vh);
  const offX = (cw - vw * scale) / 2;
  const offY = (ch - vh * scale) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const sx = clamp((visX - offX) / scale, 0, vw);
  const sy = clamp((0 - offY) / scale, 0, vh);
  const sw = clamp((visX + visW - offX) / scale, 0, vw) - sx;
  const sh = clamp((visH - offY) / scale, 0, vh) - sy;

  const k = Math.min(1, DECODE_MAX_EDGE_PX / Math.max(sw, sh, 1));
  return {
    sx,
    sy,
    sw: Math.max(1, sw),
    sh: Math.max(1, sh),
    dw: Math.max(1, Math.round(sw * k)),
    dh: Math.max(1, Math.round(sh * k)),
    scaled: k < 1,
    dragging,
  };
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
  isDuplicateBarcode,
  holdClaim = 'saved',
  className,
  frame = 'square',
  paused = false
}: SmartScannerProps) {
  const tr = useT();
  // Tap anywhere on the camera = capture the label. Default ON — a torn or
  // glared barcode has no other way onto a pallet. See the settings store for
  // why this is no longer bundled with the Bluetooth-remote trigger.
  const tapCaptureEnabled = useSettingsStore((s) => s.tapCaptureEnabled);
  const hardwareTriggerEnabled = useSettingsStore((s) => s.hardwareTriggerEnabled);
  // Hidden by default — see `cameraSwitchEnabled` in the settings store.
  // Cycling lenses stays available via the drawer's Settings screen.
  const cameraSwitchEnabled = useSettingsStore((s) => s.cameraSwitchEnabled);
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  // Decoder currently in use. A ref, not state: the detect loop reads it on
  // every frame and may swap it mid-loop when the native detector fails.
  const engineRef = useRef<DecodeEngine>('native');
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
  // A first read that never gets its confirming second read (the barcode left
  // the frame) used to leave the trail half-lit until the next decode. Now
  // that "reading" is loud, it must also let go: back to idle after 1.5s
  // unless the second read landed (captureCount moved on).
  useEffect(() => {
    if (captureCount !== 1) return;
    const t = setTimeout(() => setCaptureCount((c) => (c === 1 ? 0 : c)), 1500);
    return () => clearTimeout(t);
  }, [captureCount]);
  const [isDuplicate, setIsDuplicate] = useState(false);
  // Why the parent rejected the read: a duplicate says "already scanned";
  // a misread (bad check digit, fragment) must NOT — on 2026-09-23 a worker
  // was told "already scanned" on his first carton with zero counted.
  const [rejectKind, setRejectKind] = useState<RejectKind>('duplicate');
  const duplicateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * What the 3-second post-scan hold is actually reporting.
   *
   * This window used to be painted as an error — red border, big red numeral,
   * red status dot — which is the SAME treatment the duplicate state gets. So a
   * good scan read as: 200ms of green flash, then three seconds of red. Workers
   * could not tell "saved" from "already scanned" by sight; only the sound
   * differed. The hold is not a failure, it is "captured — reading the sticker",
   * so it is now coloured by its outcome.
   *
   * `outcomeRef` mirrors the state because `triggerRedFlash` (the parent saying
   * "actually, rejected") must read it synchronously.
   */
  const [scanOutcome, setScanOutcome] = useState<'saved' | 'duplicate'>('saved');
  const outcomeRef = useRef<'saved' | 'duplicate'>('saved');
  // Boxes saved through THIS scanner instance. pallet-verify keys the scanner
  // per pallet, so it reads as "box N on this pallet"; /scan and /issue mount
  // once, so it counts the session. Only ever used as a label.
  const savedCountRef = useRef(0);
  const [savedCount, setSavedCount] = useState(0);
  // Read by triggerRedFlash to decide whether a rejection lands inside the hold
  // it needs to correct, or is a standalone one (a rejected manual capture).
  const inCooldownRef = useRef(false);
  // The duplicate predicate lives behind a ref: `detect` is a long-lived rAF
  // closure and would otherwise capture the first render's prop forever.
  const isDupRef = useRef(isDuplicateBarcode);
  useEffect(() => {
    isDupRef.current = isDuplicateBarcode;
  }, [isDuplicateBarcode]);
  const holdClaimRef = useRef(holdClaim);
  useEffect(() => {
    holdClaimRef.current = holdClaim;
  }, [holdClaim]);
  // `detect` is a long-lived rAF closure, so the pause flag has to reach it
  // through a ref — reading the prop would pin the first render's value.
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
    const v = videoRef.current;
    if (!v) return;
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, [paused]);
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

    // The only hard requirement is a camera. The decoder is negotiable: native
    // BarcodeDetector when it genuinely works here, ZXing otherwise (see
    // DecodeEngine). "Browser not supported" used to fire on every device
    // without BarcodeDetector, which excluded whole classes of tablets.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      console.log('[SmartScanner] mediaDevices.getUserMedia not available');
      setIsSupported(false);
    } else {
      let cancelled = false;
      pickDecodeEngine().then((engine) => {
        if (cancelled || !isMountedRef.current) return;
        engineRef.current = engine;
        console.log(`[SmartScanner] Decode engine: ${engine}`);
        setIsSupported(true);
        onScannerTypeDetected?.(engine === 'native' ? 'native' : 'fallback');
        enumerateCameras();
      });
      return () => {
        cancelled = true;
        isMountedRef.current = false;
        stopNativeScanning();
      };
    }

    return () => {
      isMountedRef.current = false;
      stopNativeScanning();
    };
  }, [onScannerTypeDetected, enumerateCameras]);

  // Function to trigger duplicate indicator (called by parent on duplicate detection)
  // The parent rejecting a scan the predicate could not have known about — a
  // split-assignment clash, or a manual capture whose OCR resolved to a box
  // another worker already has. If it lands inside a hold we are currently
  // painting as "saved", correct that hold (and take the box back off the
  // label count) so it can never end on a green "saved" for a rejected box.
  const triggerRedFlash = useCallback((kind: RejectKind = 'duplicate') => {
    setRejectKind(kind);
    if (inCooldownRef.current && outcomeRef.current === 'saved') {
      outcomeRef.current = 'duplicate';
      setScanOutcome('duplicate');
      if (holdClaimRef.current === 'saved') {
        savedCountRef.current = Math.max(0, savedCountRef.current - 1);
        setSavedCount(savedCountRef.current);
      }
    }
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
      const imageData = await captureSharpestFrame(video).catch(() => snapshotFrame(video));
      if (imageData) onManualCapture(imageData);
      lastActivityRef.current = Date.now();
      setShowCaptureHint(false);
    } finally {
      setTimeout(() => setCaptureBusy(false), 1200);
    }
  }, [isInCooldown, captureBusy, onManualCapture]);

  // ── Tap-anywhere-on-the-camera capture ──
  // A tap has to be a TAP: one finger, almost no travel, and let go quickly.
  // That distinction is the whole reason this can be on by default — a swipe
  // across the viewfinder, a drag that started on the camera and ended on the
  // sheet, a second finger pinching to zoom, or a hand resting on the glass
  // while the worker lifts a carton all fail one of the three tests and
  // capture nothing. A phantom box costs the worker a delete, so the gesture
  // errs towards doing nothing.
  const tapStartRef = useRef<{ id: number; x: number; y: number; t: number } | null>(null);

  const handleTapPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Any non-primary pointer means a multi-touch gesture (pinch-zoom) — arm
    // nothing, and disarm whatever the first finger armed.
    if (!e.isPrimary) {
      tapStartRef.current = null;
      return;
    }
    tapStartRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }, []);

  const handleTapPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = tapStartRef.current;
      tapStartRef.current = null;
      if (!start || start.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_MAX_MOVE_PX) return;
      if (e.timeStamp - start.t > TAP_MAX_MS) return;
      handleManualCaptureClick();
    },
    [handleManualCaptureClick]
  );

  const handleTapPointerCancel = useCallback(() => {
    tapStartRef.current = null;
  }, []);

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
    // Both decoders read this canvas back every frame (ZXing via getImageData,
    // the native detector from the pixel buffer); the hint keeps it CPU-backed
    // so those reads don't stall on a GPU round-trip.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // Decoder for this loop. Starts on whatever pickDecodeEngine chose; a
    // native detector that rejects at runtime is swapped for ZXing in place,
    // without restarting the camera.
    let decoder: FrameDecoder | null = null;
    let decoderLoading: Promise<void> | null = null;
    let nativeErrors = 0;
    let lastDecodeAt = 0;
    // Smoothed wall time of one decode attempt (bitmap/canvas prep + detect).
    let decodeCostMs = 0;
    let bitmapPath = typeof createImageBitmap === 'function';

    const ensureDecoder = () => {
      if (decoder && decoder.engine === engineRef.current) return;
      if (decoderLoading) return;
      const loading = (async () => {
        try {
          if (engineRef.current === 'native') {
            try {
              decoder = createNativeDecoder();
            } catch (err) {
              console.warn('[SmartScanner] BarcodeDetector constructor threw — using ZXing:', err);
              engineRef.current = 'zxing';
              decoder = await createZxingDecoder();
              onScannerTypeDetected?.('fallback');
            }
          } else {
            decoder = await createZxingDecoder();
          }
        } catch (err) {
          console.error('[SmartScanner] Could not create any decoder:', err);
        }
      })();
      // Cleared from a continuation, never from inside the IIFE: the native
      // branch has no await, so a `finally` in there would run BEFORE this
      // assignment and leave the flag set forever.
      decoderLoading = loading;
      loading.finally(() => {
        if (decoderLoading === loading) decoderLoading = null;
      });
    };

    const switchToZxing = async (reason: string) => {
      if (engineRef.current === 'zxing') return;
      console.warn(`[SmartScanner] Switching to ZXing decoder: ${reason}`);
      engineRef.current = 'zxing';
      decoder = null;
      ensureDecoder();
      await decoderLoading;
      onScannerTypeDetected?.('fallback');
    };
    ensureDecoder();

    const detect = async () => {
      if (!isMountedRef.current) return;

      // Paused: keep the loop alive (so resuming needs no restart) but read
      // nothing. Deliberately before the readyState check — a paused <video>
      // still reports readyState 4, so this must short-circuit first.
      if (pausedRef.current) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      if (!video.readyState || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      // Pace the decoder instead of running it on every animation frame. The
      // skipped frames cost nothing — no video readback, no canvas draw.
      const nowMs = performance.now();
      const baseInterval =
        engineRef.current === 'zxing' ? ZXING_MIN_INTERVAL_MS : NATIVE_MIN_INTERVAL_MS;
      const minInterval = Math.min(
        DECODE_MAX_INTERVAL_MS,
        Math.max(baseInterval, decodeCostMs * DECODE_BACKOFF_FACTOR),
      );
      if (nowMs - lastDecodeAt < minInterval) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }
      lastDecodeAt = nowMs;

      try {
        ensureDecoder();
        const active = decoder;
        if (!active) {
          animationFrameRef.current = requestAnimationFrame(detect);
          return;
        }

        const roi = decodeRegion(video, video.parentElement);
        // While the sheet is being dragged (BottomSheet publishes
        // `--sheet-h-dur: 0s` for exactly that window) give the finger the
        // whole main thread; the loop resumes the moment it settles.
        if (roi.dragging) {
          lastDecodeAt = 0;
          animationFrameRef.current = requestAnimationFrame(detect);
          return;
        }

        // Native path: crop + shrink straight from the video into an
        // ImageBitmap (GPU-side in Chrome), so the only pixels that ever reach
        // the CPU are the ones the detector needs. Falls back to the canvas
        // permanently if this browser can't do it.
        let source: HTMLCanvasElement | ImageBitmap = canvas;
        let bitmap: ImageBitmap | null = null;
        if (active.engine === 'native' && bitmapPath) {
          try {
            bitmap = await createImageBitmap(
              video,
              roi.sx,
              roi.sy,
              roi.sw,
              roi.sh,
              roi.scaled
                ? { resizeWidth: roi.dw, resizeHeight: roi.dh, resizeQuality: 'low' }
                : undefined,
            );
            if (!bitmap.width || !bitmap.height) {
              bitmap.close();
              bitmap = null;
              bitmapPath = false;
            } else {
              source = bitmap;
            }
          } catch (err) {
            bitmapPath = false;
            console.warn('[SmartScanner] createImageBitmap(video) unavailable — using canvas:', err);
          }
        }
        if (!bitmap) {
          // Resizing a canvas reallocates its backing store; only do it when
          // the visible region actually changed (sheet moved, rotation).
          if (canvas.width !== roi.dw || canvas.height !== roi.dh) {
            canvas.width = roi.dw;
            canvas.height = roi.dh;
          }
          ctx.drawImage(video, roi.sx, roi.sy, roi.sw, roi.sh, 0, 0, roi.dw, roi.dh);
          source = canvas;
        }

        let barcode: string | null = null;
        try {
          barcode = await active.detect(source);
          if (active.engine === 'native') nativeErrors = 0;
          const took = performance.now() - nowMs;
          decodeCostMs = decodeCostMs === 0 ? took : decodeCostMs * 0.7 + took * 0.3;
        } catch (err) {
          if (active.engine === 'native') {
            nativeErrors += 1;
            const name = err instanceof Error ? err.name : '';
            // NotSupportedError is the "service unavailable" case and is
            // permanent for this session; anything else gets a few chances.
            if (name === 'NotSupportedError' || nativeErrors >= NATIVE_MAX_ERRORS) {
              await switchToZxing(`native detect() failed ${nativeErrors}× (${name || String(err)})`);
            } else {
              console.warn('[SmartScanner] native detect() error:', err);
            }
          } else {
            throw err;
          }
        } finally {
          bitmap?.close();
        }

        if (barcode) {
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

          // Decide saved-vs-duplicate NOW, while we still have to paint
          // something. The parent's own duplicate verdict only arrives after
          // the sharpest-frame capture below (~400ms), which is far too late
          // to be showing a green "saved" in the meantime.
          const isDup = isDupRef.current?.(barcode) ?? false;
          outcomeRef.current = isDup ? 'duplicate' : 'saved';
          setScanOutcome(outcomeRef.current);
          if (isDup) setRejectKind('duplicate');
          if (!isDup && holdClaimRef.current === 'saved') {
            savedCountRef.current += 1;
            setSavedCount(savedCountRef.current);
          }

          // Set cooldown state
          inCooldownRef.current = true;
          setIsInCooldown(true);
          setCooldownTimeLeft(3);

          // Start cooldown countdown timer
          let countdown = 3;
          const countdownInterval = setInterval(() => {
            countdown--;
            setCooldownTimeLeft(countdown);
            if (countdown <= 0) {
              clearInterval(countdownInterval);
              inCooldownRef.current = false;
              setIsInCooldown(false);
            }
          }, 1000);

          // Long enough to register as a deliberate confirmation rather than a
          // blink. A rejected scan keeps the old short red blink — the red
          // frame behind it is what carries that message.
          setFlashColor(isDup ? 'red' : 'green');
          setTimeout(() => setFlashColor(null), isDup ? 200 : 420);

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
          const imageData = await captureSharpestFrame(video).catch(() => snapshotFrame(video));
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
      <div className={`w-full bg-cam-scrim rounded-xl flex items-center justify-center ${className || 'aspect-square'}`}>
        <p className="text-cam-ink-muted">{tr('scanner.initializing')}</p>
      </div>
    );
  }

  // Browser not supported
  if (!isSupported) {
    return (
      <div className={`w-full bg-cam-scrim rounded-xl flex flex-col items-center justify-center gap-3 p-6 ${className || 'aspect-square'}`}>
        <AlertTriangle className="w-10 h-10 text-warn" />
        <p className="text-cam-ink font-medium text-center">{tr('scanner.notSupportedTitle')}</p>
        <p className="text-cam-ink-muted text-sm text-center">
          {tr('scanner.notSupportedDesc')}
        </p>
      </div>
    );
  }

  // Native scanner
  return (
    <div className={`relative w-full bg-black rounded-xl overflow-hidden ${className || 'aspect-square'}`}>
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        muted
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Tap-anywhere capture. A full-area transparent layer that fires the same
          manual capture as the on-screen button — no aiming for a small target
          with a carton in the other hand. Placed BEFORE the control buttons in
          the DOM so the camera-switch / capture buttons (later siblings,
          pointer-events-auto) paint on top and still receive their own taps;
          they are siblings, not children, so tapping one cannot also fire this.
          Unmounted during the cooldown so a tap can't queue a capture mid-hold
          (the handler bails on cooldown too). Not focusable and aria-hidden:
          the "capture anyway" button below is the accessible control, and a
          full-screen tab stop would only get in the way. */}
      {tapCaptureEnabled && onManualCapture && !isInCooldown && (
        <div
          onPointerDown={handleTapPointerDown}
          onPointerUp={handleTapPointerUp}
          onPointerCancel={handleTapPointerCancel}
          className="absolute inset-0 z-0"
          style={{ touchAction: 'manipulation' }}
          aria-hidden
        />
      )}

      {/* Camera flash overlay */}
      {flashColor && (
        <div
          className={`absolute inset-0 pointer-events-none ${flashColor === 'green' ? 'bg-ok/70' : 'bg-danger/70'
            }`}
          style={{
            animation: `cameraFlash ${flashColor === 'green' ? '0.42s' : '0.2s'} ease-out forwards`,
            zIndex: 10
          }}
        />
      )}

      {/* Whole-camera tint for the post-scan hold. The frame alone is a small
          box in the middle of a busy video; tinting everything green (or red)
          for the full 3s is what makes the outcome readable from arm's length.
          Decodes are ignored during the hold anyway, so nothing is lost. */}
      {isInCooldown && (
        <div
          className={`absolute inset-0 pointer-events-none ${scanOutcome === 'saved' ? 'bg-ok/20' : 'bg-danger/20'}`}
          style={{ zIndex: 5 }}
        />
      )}

      {/* Diagnostic overlay — visible camera state for debugging silent failures */}
      {diag.state !== 'ready' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-cam-scrim text-cam-ink p-6 text-center">
          {diag.state === 'init' && (
            <>
              <div className="animate-spin rounded-full h-10 w-10 border-2 border-line-strong border-t-brand mb-4" />
              <p className="text-base font-bold">{tr('scanner.requestingPermission')}</p>
              <p className="text-xs text-cam-ink-muted mt-2">{tr('scanner.permissionHint')}</p>
            </>
          )}
          {diag.state === 'no_cameras' && (
            <>
              <AlertTriangle className="w-10 h-10 text-warn mb-3" />
              <p className="text-base font-extrabold">{tr('scanner.noCamerasTitle')}</p>
              <p className="text-xs text-cam-ink-muted mt-2 max-w-xs">
                {tr('scanner.noCamerasDesc')}
              </p>
              <button
                onClick={() => {
                  setDiag({ state: 'init' });
                  enumerateCameras();
                }}
                className="mt-4 tap-target bg-brand hover:bg-brand-hover active:bg-brand-active text-ink-inverse px-5 py-2 rounded-xl text-sm font-extrabold"
              >
                {tr('common.retry')}
              </button>
            </>
          )}
          {diag.state === 'error' && (
            <>
              <AlertTriangle className="w-10 h-10 text-danger mb-3" />
              <p className="text-base font-extrabold">{tr('scanner.cameraErrorTitle')}</p>
              <p className="text-xs text-danger-weak-ink mt-2 break-words max-w-xs font-mono" dir="ltr">
                {diag.message}
              </p>
              <p className="text-xs text-cam-ink-muted mt-3 max-w-xs">
                {tr('scanner.cameraErrorHint')}
              </p>
              <button
                onClick={() => {
                  setDiag({ state: 'init' });
                  enumerateCameras();
                }}
                className="mt-4 tap-target bg-brand hover:bg-brand-hover active:bg-brand-active text-ink-inverse px-5 py-2 rounded-xl text-sm font-extrabold"
              >
                {tr('common.retry')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Minimal scanning indicator. `--sheet-w` is set by BottomSheet when it
          docks as a side panel (wide landscape hosts — tablets on their side);
          every overlay here then keeps to the camera the worker can see
          instead of centring under the panel. 0 on a bottom sheet. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ insetInlineEnd: 'var(--sheet-w, 0px)' }}
      >
        {/* Target box — centered square (legacy) or terminal corner frame */}
        <div
          className={
            frame === 'corner'
              ? 'absolute inset-x-0 top-0 flex flex-col items-center justify-center px-6 py-3'
              : 'absolute inset-0 flex items-center justify-center'
          }
          style={
            frame === 'corner'
              ? {
                  // Centre the frame in the camera the worker can actually SEE:
                  // the strip above the bottom sheet, not the whole element.
                  // `--sheet-h` is published by BottomSheet as it drags and
                  // snaps (a CSS var, not a prop — the height changes on every
                  // pointermove and re-rendering the live camera at that rate
                  // is not affordable). The min() keeps CORNER_BAND_PX of room
                  // so the tall snap can't centre the frame under the sheet;
                  // there it stays top-anchored, as it always was.
                  // Centre the frame in the visible strip, EXCEPT that its
                  // bottom edge must clear the capture control + hint stacked
                  // above the sheet (CONTROL_STACK_PX). With the frame centred
                  // in a wrapper whose bottom is B, its bottom edge sits at
                  // (100% + B)/2 − CORNER_BAND/2, so clearing the control needs
                  // B ≥ 2·sheet + CORNER_BAND + 2·CONTROL_STACK − 100%. On a
                  // tall strip that term is negative and the plain sheet
                  // height wins; on a short one it lifts the frame just enough.
                  bottom: `min(max(var(--sheet-h, 0px), calc(2 * var(--sheet-h, 0px) + ${CORNER_BAND_PX + 2 * CONTROL_STACK_PX}px - 100%)), calc(100% - ${CORNER_BAND_PX}px))`,
                  transition: 'bottom var(--sheet-h-dur, 0s) cubic-bezier(.4,0,.2,1)',
                }
              : undefined
          }
        >
          {frame === 'corner' && (
            <span className="text-[10px] font-semibold mb-2" style={{ color: 'rgba(226,232,240,.5)' }}>
              {tr('terminal.tapToScan')}
            </span>
          )}
          <div
            className={frame === 'corner' ? 'relative w-full' : 'relative'}
            style={frame === 'corner' ? { maxWidth: CORNER_W, height: CORNER_H } : { width: 240, height: 240 }}
          >

            {/* === POST-SCAN HOLD — green "saved" or red "already scanned" === */}
            {isInCooldown && (
              <>
                {/* Thick border + a near-solid fill: the 3px line + 10% tint
                    it replaced was invisible against a bright carton. */}
                <div
                  className={`absolute inset-0 border-[6px] rounded-xl ${
                    scanOutcome === 'saved' ? 'border-ok' : 'border-danger'
                  }`}
                  style={{
                    background: scanOutcome === 'saved' ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)',
                    boxShadow: scanOutcome === 'saved'
                      ? '0 0 0 4px rgba(34,197,94,.35), 0 0 32px rgba(34,197,94,.6)'
                      : '0 0 0 4px rgba(239,68,68,.35), 0 0 32px rgba(239,68,68,.6)',
                    animation: 'scanHoldIn .32s cubic-bezier(.2,1.3,.4,1)',
                  }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                  {scanOutcome === 'saved' ? (
                    <>
                      <Check
                        className={frame === 'corner' ? 'w-16 h-16 text-white' : 'w-20 h-20 text-white'}
                        strokeWidth={4}
                        style={{
                          animation: 'scanSavedPop .28s cubic-bezier(.2,1.3,.4,1)',
                          filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.5))',
                        }}
                      />
                      <span className="px-4 py-1.5 rounded-full bg-ok text-canvas text-base font-black tracking-[.3px] uppercase shadow-lg">
                        {holdClaim === 'saved'
                          ? tr('scanner.boxSaved', { n: savedCount })
                          : tr('scanner.boxCaptured')}
                      </span>
                    </>
                  ) : (
                    <>
                      <X
                        className={frame === 'corner' ? 'w-16 h-16 text-white' : 'w-20 h-20 text-white'}
                        strokeWidth={4}
                        style={{
                          animation: 'scanSavedPop .28s cubic-bezier(.2,1.3,.4,1)',
                          filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.5))',
                        }}
                      />
                      <span className="px-4 py-1.5 rounded-full bg-danger text-white text-base font-black tracking-[.3px] uppercase shadow-lg">
                        {/* "Already scanned" is only true where a decode IS the
                            save. On /issue a rejection can equally be not-found,
                            already-issued or a network error — the toast says
                            which, so the frame stays neutral. */}
                        {holdClaim === 'saved'
                          ? tr(rejectKind === 'duplicate' ? 'scanner.alreadyScanned' : 'scanner.badRead')
                          : tr('scanner.scanRejected')}
                      </span>
                    </>
                  )}
                  {/* The wait is still real — the scanner ignores decodes for
                      3s — but it no longer shouts. It was a full-height red
                      numeral, which is what made a good scan look like a fault. */}
                  <span
                    className="font-mono text-[11px] font-bold text-white/80"
                    dir="ltr"
                  >
                    {cooldownTimeLeft}
                  </span>
                </div>
              </>
            )}

            {/* === DUPLICATE STATE (outside a hold) === */}
            {!isInCooldown && isDuplicate && (
              <>
                <div
                  className="absolute inset-0 border-[6px] border-danger rounded-xl"
                  style={{ background: 'rgba(239,68,68,.45)', boxShadow: '0 0 0 4px rgba(239,68,68,.35)' }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="px-4 py-1.5 rounded-full bg-danger text-white text-base font-black uppercase shadow-lg">{tr(rejectKind === 'duplicate' ? 'scanner.alreadyScanned' : 'scanner.badRead')}</span>
                </div>
              </>
            )}

            {/* === IDLE / CAPTURING STATE === */}
            {!isInCooldown && !isDuplicate && (
              <>
                {frame === 'corner' ? (
                  <>
                    {/* Terminal corner frame: faint brand fill + 4 L-corners */}
                    <div
                      className="absolute inset-0 rounded-[12px]"
                      style={{
                        border: '1px solid rgba(19,164,236,.2)',
                        // Reading = the frame lights up, not just its outline.
                        background: captureCount > 0 ? 'rgba(19,164,236,.28)' : 'rgba(19,164,236,.05)',
                        boxShadow: captureCount > 0 ? '0 0 0 3px rgba(19,164,236,.35), 0 0 28px rgba(19,164,236,.55)' : 'none',
                        transition: 'background .15s ease-out, box-shadow .15s ease-out',
                      }}
                    />
                    <span className="absolute -top-px -left-px w-6 h-6 border-t-4 border-l-4 border-brand rounded-tl-[10px]" />
                    <span className="absolute -top-px -right-px w-6 h-6 border-t-4 border-r-4 border-brand rounded-tr-[10px]" />
                    <span className="absolute -bottom-px -left-px w-6 h-6 border-b-4 border-l-4 border-brand rounded-bl-[10px]" />
                    <span className="absolute -bottom-px -right-px w-6 h-6 border-b-4 border-r-4 border-brand rounded-br-[10px]" />
                  </>
                ) : (
                  /* Dim green base border (shows unfilled portion) */
                  <div className="absolute inset-0 border-[3px] border-ok/25 rounded-xl" />
                )}

                {/* SVG capture-progress trail. The stroke follows the frame's
                    own hue — the corner frame is brand blue, and stroking its
                    progress in green made the two colours bleed into each
                    other mid-scan. Green stays reserved for the confirmed-scan
                    flash, where it actually means "captured". */}
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  viewBox={frame === 'corner' ? `0 0 ${CORNER_W} ${CORNER_H}` : '0 0 240 240'}
                  preserveAspectRatio="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect
                    x="1.5" y="1.5"
                    width={frame === 'corner' ? CORNER_W - 3 : 237}
                    height={frame === 'corner' ? CORNER_H - 3 : 237}
                    rx="10"
                    fill="none"
                    stroke={frame === 'corner' ? 'var(--brand)' : 'var(--ok)'}
                    strokeWidth="7"
                    strokeLinecap="round"
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

                {/* "Reading…" — a decode is in progress (first of the two
                    required reads landed). The worker's question at this
                    moment is "is it seeing the barcode?", and a 3px stroke
                    creeping round the frame did not answer it. */}
                {captureCount > 0 && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none">
                    <span
                      className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand text-white text-base font-black uppercase shadow-lg"
                      style={{ animation: 'scanSavedPop .18s ease-out' }}
                    >
                      <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
                      {tr('scanner.reading')}
                    </span>
                    <span className="text-[11px] font-semibold text-white/85" style={{ textShadow: '0 1px 3px rgba(0,0,0,.7)' }}>
                      {tr('scanner.holdStill')}
                    </span>
                  </div>
                )}
              </>
            )}

          </div>
        </div>
        {/* Active scanner indicator. Glass chip (same treatment as the camera
            switch) with the state carried by the dot — the old solid green /
            red fill was a loud block of colour sitting right beside the brand
            frame. */}
        <div className="absolute top-2 left-2">
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full border ${
            isInCooldown
              ? scanOutcome === 'saved' ? 'bg-ok border-ok' : 'bg-danger border-danger'
              : captureCount > 0
                ? 'bg-brand border-brand'
                : 'border-cam-border bg-cam-chip'
          }`}>
            <div className={`w-2 h-2 rounded-full ${
              isInCooldown || captureCount > 0
                ? 'bg-white'
                : isDuplicate ? 'bg-danger' : 'bg-ok animate-pulse'
            }`}></div>
            {isInCooldown ? (
              <span className={`text-xs font-bold ${scanOutcome === 'saved' ? 'text-canvas' : 'text-white'}`} dir="ltr">
                {scanOutcome === 'saved' ? '✓' : '✕'} {cooldownTimeLeft}s
              </span>
            ) : captureCount > 0 ? (
              <span className="text-white text-xs font-bold">{tr('scanner.reading')}</span>
            ) : isDuplicate ? (
              <span className="text-cam-ink text-xs font-bold">{tr('scanner.duplicateBadge')}</span>
            ) : (
              <ScanLine className="w-3 h-3 text-cam-ink" />
            )}
          </div>
        </div>
        {/* Camera switch button — off unless enabled in Settings */}
        {cameraSwitchEnabled && cameras.length > 1 && (
          <div className="absolute top-2 right-2 pointer-events-auto">
            <button
              onClick={switchCamera}
              className="flex items-center gap-1.5 bg-cam-chip hover:bg-cam-chip-hover px-3 py-2 rounded-full text-cam-ink text-xs font-medium transition-colors border border-cam-border"
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
            seconds pass with no decode.

            Anchored to the top of the BOTTOM SHEET, not to the bottom of this
            element. The camera runs full height *behind* the floating sheet on
            every page that wires `onManualCapture`, so the old `bottom-3` put
            this control — and the hint that explains it — permanently off
            screen: the fallback for a damaged barcode had no reachable UI at
            all. `--sheet-h` is the same live variable the corner frame reads,
            but NOT with the frame's clamp: `min(sheet, 100% - band)` is there
            to let a tall sheet cover the frame and keep it top-anchored, which
            for this control means sliding straight back under the sheet — the
            exact bug being fixed. Here the offset tracks the sheet outright and
            the min() only stops it running off the TOP of the camera region.
            The 0px fallback leaves a sheetless page exactly as it was. */}
        {onManualCapture && !isInCooldown && (
          <div
            className="absolute inset-x-0 flex flex-col items-center gap-2 px-4"
            style={{
              bottom: `min(calc(var(--sheet-h, 0px) + 12px), calc(100% - ${CONTROL_BAND_PX}px))`,
              transition: 'bottom var(--sheet-h-dur, 0s) cubic-bezier(.4,0,.2,1)',
            }}
          >
            {showCaptureHint && (
              <span className="text-xs font-semibold text-warn-weak-ink bg-cam-chip border border-cam-border px-3 py-1 rounded-full text-center max-w-[280px] pointer-events-none">
                {tr('scanner.captureHint')}
              </span>
            )}
            <button
              onClick={handleManualCaptureClick}
              disabled={captureBusy}
              className={`pointer-events-auto flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold transition-all border disabled:opacity-50 ${
                showCaptureHint
                  ? 'bg-warn text-canvas border-warn animate-pulse shadow-lg scale-105'
                  : 'bg-cam-chip text-cam-ink border-cam-border'
              }`}
            >
              <Camera className="w-4 h-4" /> {tr('scanner.captureAnyway')}
              {/* Tap-anywhere is the default, so it needs no badge — the hint
                  above says it when it matters. The remote is opt-in hardware,
                  and a worker who paired one wants to see the page listening. */}
              {hardwareTriggerEnabled && (
                <span className={`ms-1 text-[10px] font-semibold ${showCaptureHint ? 'text-canvas/80' : 'text-ok-weak-ink'}`}>
                  {tr('scanner.hardwareTriggerOn')}
                </span>
              )}
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
        @keyframes scanSavedPop {
          0%   { transform: scale(.5); opacity: 0; }
          100% { transform: scale(1);  opacity: 1; }
        }
        @keyframes scanHoldIn {
          0%   { transform: scale(.92); opacity: .3; }
          100% { transform: scale(1);   opacity: 1; }
        }
      `}</style>
    </div>
  );
}
