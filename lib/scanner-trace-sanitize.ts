/**
 * Pure helpers for the scanner trace (no `window`), kept apart from
 * `scanner-trace.ts` so they can be unit-tested and so the sanitiser is
 * the single place that decides what never reaches the database.
 *
 * The trail is for replaying what a worker did — barcodes, names, weights,
 * counts, statuses — not for storing photos. Every captured frame is a
 * base64 JPEG of 100 KB+, so any string that looks like one is replaced by
 * a short marker, and well-known photo keys are dropped by name.
 */

const IMAGE_KEYS = new Set([
  'image', 'image_data', 'imageData', 'image_base64', 'imageBase64', 'photo',
  'frame', 'dataUrl', 'data_url',
]);

const MAX_STRING = 1000;
const MAX_ARRAY = 60;
const MAX_KEYS = 80;
const MAX_DEPTH = 6;
/** Hard cap on one event's serialised `data`; above it a preview is kept. */
export const MAX_EVENT_CHARS = 16_000;

function looksLikeImage(s: string): boolean {
  if (s.startsWith('data:image/')) return true;
  // A long run of base64 characters with no spaces is a photo, not a label.
  return s.length > 300 && /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 400));
}

export function sanitizeForTrace(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (looksLikeImage(value)) return `<image ${value.length} chars>`;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth >= MAX_DEPTH) return '<depth>';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitizeForTrace(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`<+${value.length - MAX_ARRAY} more>`);
    return out;
  }
  if (value instanceof Map) return sanitizeForTrace(Array.from(value.entries()), depth);
  if (value instanceof Set) return sanitizeForTrace(Array.from(value), depth);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) { out['<more>'] = true; break; }
      out[k] = IMAGE_KEYS.has(k) && typeof v === 'string' && v
        ? `<omitted ${v.length} chars>`
        : sanitizeForTrace(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Sanitise and enforce the per-event size cap. Never throws. */
export function packEventData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    const clean = sanitizeForTrace(data);
    const s = JSON.stringify(clean);
    if (s === undefined) return undefined;
    if (s.length <= MAX_EVENT_CHARS) return clean;
    return { truncated: true, chars: s.length, preview: s.slice(0, 4000) };
  } catch (e) {
    return { unserialisable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse a JSON request/response body for the trail; text stays text. */
export function bodyForTrace(body: unknown): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    try {
      return sanitizeForTrace(JSON.parse(body));
    } catch {
      return sanitizeForTrace(body);
    }
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) return '<FormData>';
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `<Blob ${body.size} bytes>`;
  return sanitizeForTrace(body);
}
