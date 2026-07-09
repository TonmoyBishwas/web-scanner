import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * Image upload endpoint — now backed by SUPABASE STORAGE (was Cloudinary).
 *
 * The route path is kept as `/api/cloudinary/upload` for backwards compatibility
 * so the Telegram/WhatsApp bot (which POSTs here over HTTP) and the scanner's
 * box-scan flow need no change. The name is a misnomer, same spirit as
 * `airtable_service.py` after the Postgres migration.
 *
 * All images (box-sticker photos, invoice photos, LPN sticker PNGs) land in the
 * public `warehouse-images` bucket. The response shape is unchanged
 * (`secure_url` / `public_id` / `folder` / `created_at`) so every caller keeps
 * working; `secure_url` is now a Supabase public URL instead of a Cloudinary one.
 */

const BUCKET = 'warehouse-images';

export interface CloudinaryUploadRequest {
  image?: string;         // data-URL, raw base64, or an http(s) URL
  image_url?: string;     // public URL to fetch the image from
  image_base64?: string;  // raw base64 (the bot's invoice field)
  barcode: string;
  document_number?: string;  // invoice document number → folder structure
  image_type?: 'box' | 'invoice' | 'lpn_sticker';
}

/** Keep object-key segments to characters that are safe in a storage path. */
function sanitizeSegment(value: string): string {
  return (value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

interface ResolvedImage {
  buffer: Buffer;
  contentType: string;
}

/**
 * Turn whatever the caller sent (data-URL, raw base64, or a URL to fetch) into
 * a Buffer + content-type. `defaultMime` is used when the source carries no mime
 * of its own (raw base64).
 */
async function resolveImage(
  source: string,
  defaultMime: string
): Promise<ResolvedImage> {
  // A URL → fetch it.
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || defaultMime;
    return { buffer, contentType };
  }

  // A data-URL → parse mime + decode.
  const dataUrlMatch = source.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1] || defaultMime;
    const isBase64 = Boolean(dataUrlMatch[2]);
    const payload = dataUrlMatch[3];
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf-8');
    return { buffer, contentType: mime };
  }

  // Otherwise treat it as raw base64.
  return { buffer: Buffer.from(source, 'base64'), contentType: defaultMime };
}

/**
 * POST /api/cloudinary/upload
 * Upload an image to Supabase Storage (server-side only).
 *
 * Object-key structure (preserves the old Cloudinary folder semantics):
 * - lpn_sticker            → lpn-stickers/sticker-{barcode}.png   (overwrite in place)
 * - invoice + document_no  → invoices/{doc}/invoice-{ts}-{rand}.jpg
 * - box + document_no      → boxes/{doc}/box-{barcode}-{ts}-{rand}.jpg
 * - box (no document_no)   → boxes/box-{barcode}-{ts}-{rand}.jpg
 */
export async function POST(request: NextRequest) {
  try {
    const body: CloudinaryUploadRequest = await request.json();
    const {
      image,
      image_url,
      image_base64,
      barcode,
      document_number,
      image_type = 'box',
    } = body;

    const rawSource = image || image_base64 || image_url;

    // Validate required fields — need a barcode and some image source.
    if (!barcode || !rawSource) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Missing required fields: barcode and one of image / image_base64 / image_url are required',
        },
        { status: 400 }
      );
    }

    const defaultMime = image_type === 'lpn_sticker' ? 'image/png' : 'image/jpeg';

    let resolved: ResolvedImage;
    try {
      resolved = await resolveImage(rawSource, defaultMime);
    } catch (fetchError) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to load image: ${
            fetchError instanceof Error ? fetchError.message : 'Unknown error'
          }`,
        },
        { status: 400 }
      );
    }

    if (!resolved.buffer.length) {
      return NextResponse.json(
        { success: false, error: 'Decoded image is empty' },
        { status: 400 }
      );
    }

    // Determine the object key + folder, preserving the old Cloudinary layout.
    const barcodeSan = sanitizeSegment(barcode);
    const ext = resolved.contentType.includes('png') ? 'png' : 'jpg';
    const rand = crypto.randomUUID().slice(0, 8);

    let folder: string;
    let key: string;
    let upsert = false;

    if (image_type === 'lpn_sticker') {
      // LPN stickers are keyed by LPN so re-renders overwrite in place.
      folder = 'lpn-stickers';
      key = `${folder}/sticker-${barcodeSan}.png`;
      upsert = true;
    } else if (document_number) {
      const docSan = sanitizeSegment(document_number);
      if (image_type === 'invoice') {
        folder = `invoices/${docSan}`;
        key = `${folder}/invoice-${Date.now()}-${rand}.${ext}`;
      } else {
        folder = `boxes/${docSan}`;
        key = `${folder}/box-${barcodeSan}-${Date.now()}-${rand}.${ext}`;
      }
    } else {
      folder = 'boxes';
      key = `${folder}/box-${barcodeSan}-${Date.now()}-${rand}.${ext}`;
    }

    console.log(
      `[API/upload] Supabase Storage → bucket: ${BUCKET}, key: ${key}, type: ${resolved.contentType}, upsert: ${upsert}`
    );

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(key, resolved.buffer, {
        contentType: resolved.contentType,
        upsert,
      });

    if (uploadError) {
      console.error('[API/upload] Supabase Storage upload failed:', uploadError);
      return NextResponse.json(
        { success: false, error: uploadError.message, details: JSON.stringify(uploadError) },
        { status: 500 }
      );
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(BUCKET).getPublicUrl(key);

    return NextResponse.json({
      success: true,
      secure_url: publicUrl,
      public_id: key,
      folder,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Storage upload error (full):', JSON.stringify(error, null, 2));
    const errorMsg = error instanceof Error ? error.message : 'Upload failed';
    const errorDetails = error && typeof error === 'object' ? JSON.stringify(error) : errorMsg;
    return NextResponse.json(
      { success: false, error: errorMsg, details: errorDetails },
      { status: 500 }
    );
  }
}
