/// <reference lib="webworker" />
/**
 * Runs the edge-to-edge Code 128 reader (lib/code128-e2e.ts) off the main
 * thread, so a frame with no barcode in it — the worst case, every scanline
 * tried — never stalls the camera preview on a low-end phone.
 *
 * In:  { id, buffer, width, height }  — RGBA pixels, transferred.
 *      `max` (optional, a photo capture — lib/nobc-photo-decode.ts): how
 *      many distinct symbols to look for; absent = the reader's default
 *      (the live camera loop, unchanged).
 * Out: { id, reads, ms, buffer }       — the buffer is handed back for reuse.
 */
import { scanCode128 } from './code128-e2e';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<{ id: number; buffer: ArrayBuffer; width: number; height: number; max?: number }>) => {
  const { id, buffer, width, height, max } = e.data;
  const t0 = performance.now();
  let reads: { value: string; dist: number }[] = [];
  try {
    reads = scanCode128({ data: new Uint8ClampedArray(buffer), width, height }, max ? { max } : {});
  } catch {
    reads = [];
  }
  ctx.postMessage({ id, reads, ms: performance.now() - t0, buffer }, [buffer]);
};
