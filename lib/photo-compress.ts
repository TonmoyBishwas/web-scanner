/**
 * Shrink a sticker photo before it is archived (2026-10-15).
 *
 * The scanner captures its frame at q0.9 (the OCR reads that one, untouched);
 * the archived copy only has to show a person what the sticker said. At
 * ≤ 1280 px on the long side and JPEG q0.75 it is roughly half the bytes
 * (≈ 325 KB → ≈ 150 KB), which halves the warehouse-images bucket's growth
 * and the uplink the upload shares with the next OCR request.
 *
 * Browser only. Any failure (no canvas, a decode error) returns the input
 * unchanged — a photo is never lost to compression. A result that is not
 * smaller is discarded too.
 */

export const PHOTO_MAX_EDGE_PX = 1280;
export const PHOTO_JPEG_QUALITY = 0.75;

/** Approximate decoded size of a base64 data URL, in bytes. */
export function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export async function compressPhoto(
  dataUrl: string,
  maxEdge = PHOTO_MAX_EDGE_PX,
  quality = PHOTO_JPEG_QUALITY,
): Promise<string> {
  if (typeof document === 'undefined' || !dataUrl.startsWith('data:image/')) return dataUrl;
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
    });
    img.src = dataUrl;
    await loaded;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return dataUrl;
    const k = Math.min(1, maxEdge / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', quality);
    return out.startsWith('data:image/jpeg') && out.length < dataUrl.length ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}
