/**
 * nobc_photo_decode (18/11, approved by Mevaser; Well Done note 48971).
 *
 * The double count: the worker taps "take photo anyway" on a sticker the
 * camera did not read, the label reader finds no digits, and the carton is
 * booked as a no-barcode NOBC- row (lib/no-barcode.ts). Later the camera
 * reads the SAME sticker's 6-digit serial (camera_short_serial) and books it
 * again — one carton, two rows. The count step catches it ("the list has 7,
 * you entered 6") but also offers to keep 7.
 *
 * The fix: before a photo capture is booked NOBC-, the scanner's own
 * edge-to-edge Code 128 reader (lib/code128-e2e.ts) reads the photo. When it
 * finds EXACTLY ONE serial the camera would accept (the page's
 * serialAccepted = lib/carton-barcode.ts cameraSerialBookable), the carton is
 * booked under that serial, as if the label reader had printed it — so the
 * later camera read is "already on the list". None, or two or more (a
 * neighbouring carton's sticker in view, as on 48971's photo: 412916 and
 * 412924), and the carton is booked NOBC- exactly as today. A label reading
 * of 6+ digits that names another number also keeps NOBC-, and so does a
 * serial already on the list that the label reader did not print (a
 * neighbour's sticker — see nobcPhotoDecision).
 *
 * Only the NOBC- outcome is touched: digits the label reader read, a held
 * capture (manual_capture_review) and a capture sent to review are not.
 * A missing scanner_flags row is OFF; the photo is then never decoded.
 */
import { cameraSerialOcrVerdict } from './carton-barcode';
import { scanCode128, type ScanImage } from './code128-e2e';

/**
 * Distinct symbols to look for in one photo. Above 1 on purpose: the reader
 * stops at `max`, and a photo with a second sticker in view must be seen to
 * have two, or the nearest one would be taken for the carton.
 */
export const PHOTO_DECODE_MAX = 4;

/** How long the page waits for the decode before booking NOBC- as today. */
export const PHOTO_DECODE_TIMEOUT_MS = 3000;

/** Every Code 128 value the reader finds in a photo, nearest the centre first. */
export function photoCodeReads(img: ScanImage): string[] {
  return scanCode128(img, { max: PHOTO_DECODE_MAX }).map((r) => r.value);
}

/** Why a photo was (or was not) given a serial — the `nobc_photo_decode` trace. */
export type NobcPhotoOutcome = 'serial' | 'none' | 'several' | 'other_digits' | 'listed';

/**
 * The serial to book a would-be NOBC- photo capture under, or null (NOBC- as
 * today), with the reason:
 *  * the reads the camera would accept as a carton serial (`accept`),
 *    distinct, must be exactly one ('none' / 'several');
 *  * the label reader's printed digits must not name another number
 *    (cameraSerialOcrVerdict 'other' → 'other_digits'); none, fewer than 6
 *    or the same number is fine;
 *  * `listed` (review 18/11): a serial already on the list (or a teammate's
 *    pallet) is taken only when the label reader printed that same number.
 *    The photo of a carton whose own sticker would not read often shows a
 *    NEIGHBOUR's sticker instead (48745 P1-2: 410405 and 410410, both
 *    already counted; 48651 P1-7, 48936 P1-9 the same), and booking under
 *    it would DROP the photographed carton as "already counted" — no
 *    "different carton?" offer exists for a serial, so the carton would be
 *    lost. The bug being fixed (photo first, camera later) never has the
 *    serial on the list yet, so nothing it needs is refused ('listed').
 */
export function nobcPhotoDecision(
  reads: readonly string[] | null | undefined,
  accept: (value: string) => boolean,
  ocrDigits: string | null | undefined,
  listed?: (serial: string) => boolean,
): { serial: string | null; outcome: NobcPhotoOutcome } {
  const accepted = new Set<string>();
  for (const raw of reads ?? []) {
    const v = String(raw ?? '').trim();
    if (v && accept(v)) accepted.add(v);
  }
  if (accepted.size === 0) return { serial: null, outcome: 'none' };
  if (accepted.size > 1) return { serial: null, outcome: 'several' };
  const [serial] = accepted;
  const verdict = cameraSerialOcrVerdict(serial, ocrDigits);
  if (verdict === 'other') return { serial: null, outcome: 'other_digits' };
  if (verdict !== 'agrees' && listed?.(serial)) return { serial: null, outcome: 'listed' };
  return { serial, outcome: 'serial' };
}

/** nobcPhotoDecision's serial alone. */
export function nobcPhotoSerial(
  reads: readonly string[] | null | undefined,
  accept: (value: string) => boolean,
  ocrDigits: string | null | undefined,
  listed?: (serial: string) => boolean,
): string | null {
  return nobcPhotoDecision(reads, accept, ocrDigits, listed).serial;
}

/** The photo's pixels, or null when the browser cannot draw it. */
async function photoPixels(dataUrl: string): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof document === 'undefined' || !dataUrl) return null;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height };
}

/** The reads from the Code 128 worker (lib/code128.worker.ts), off the main thread. */
function readsInWorker(px: { data: Uint8ClampedArray; width: number; height: number }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./code128.worker.ts', import.meta.url));
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (ev: MessageEvent<{ reads?: { value: string }[] }>) => {
      worker.terminate();
      resolve((ev.data?.reads ?? []).map((r) => r.value));
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    const buffer = px.data.buffer.slice(0) as ArrayBuffer;
    worker.postMessage({ id: 0, buffer, width: px.width, height: px.height, max: PHOTO_DECODE_MAX }, [buffer]);
  });
}

/**
 * Browser only: the Code 128 values in a photo capture (a data URL). In the
 * worker when it can be made, else on the main thread (~20 ms for a
 * 720x1280 photo). Never throws: a photo that cannot be drawn, a failed
 * worker or no answer within `timeoutMs` is no reads (NOBC- as today).
 */
export function decodePhotoReads(dataUrl: string, timeoutMs = PHOTO_DECODE_TIMEOUT_MS): Promise<string[]> {
  const work = (async () => {
    const px = await photoPixels(dataUrl);
    if (!px) return [];
    try {
      return await readsInWorker(px);
    } catch {
      return photoCodeReads(px);
    }
  })().catch(() => [] as string[]);
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs));
  return Promise.race([work, timeout]);
}
