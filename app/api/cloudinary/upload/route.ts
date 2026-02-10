import { NextRequest, NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary with environment variables (server-side only)
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export interface CloudinaryUploadRequest {
  image?: string;  // Base64 data URL (optional if image_url provided)
  image_url?: string;  // Public URL to fetch image from (optional if image provided)
  barcode: string;
  document_number?: string;  // Invoice document number for folder structure
  image_type?: 'box' | 'invoice';  // Type of image being uploaded
}

/**
 * POST /api/cloudinary/upload
 * Upload a box image to Cloudinary (server-side only)
 *
 * Folder structure:
 * - With document_number: "Invoice {document_number}/box-{barcode}.jpg"
 * - Without document_number: "warehouse-boxes/box-{barcode}-{timestamp}.jpg"
 */
export async function POST(request: NextRequest) {
  try {
    const body: CloudinaryUploadRequest = await request.json();
    const { image, image_url, barcode, document_number, image_type = 'box' } = body;

    // Validate required fields - need either image (base64) or image_url
    if (!barcode || (!image && !image_url)) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: barcode and either image or image_url are required' },
        { status: 400 }
      );
    }

    // Check if Cloudinary is configured
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return NextResponse.json(
        { success: false, error: 'Cloudinary not configured' },
        { status: 500 }
      );
    }

    // Determine what to upload
    let uploadSource: string;

    if (image) {
      // Use provided base64 image
      uploadSource = image;
    } else if (image_url) {
      // Fetch image from URL and convert to base64
      try {
        const response = await fetch(image_url);
        if (!response.ok) {
          return NextResponse.json(
            { success: false, error: `Failed to fetch image from URL: ${response.statusText}` },
            { status: 400 }
          );
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        uploadSource = `data:image/jpeg;base64,${base64}`;
      } catch (fetchError) {
        return NextResponse.json(
          { success: false, error: `Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}` },
          { status: 400 }
        );
      }
    } else {
      return NextResponse.json(
        { success: false, error: 'Either image or image_url must be provided' },
        { status: 400 }
      );
    }

    // Determine folder structure based on document_number
    let folder = 'warehouse-boxes';
    let publicId: string;

    if (document_number) {
      // Use invoice-based folder structure: "Invoice {document_number}/"
      folder = `Invoice ${document_number}`;

      if (image_type === 'invoice') {
        publicId = 'invoice';
      } else {
        publicId = `box-${barcode}`;
      }
    } else {
      // Fallback to old structure
      publicId = `box-${barcode}-${Date.now()}`;
    }

    // Upload to Cloudinary
    const uploadOptions: any = {
      folder,
      public_id: publicId,
      resource_type: 'image',
      transformation: [
        { quality: 'auto', fetch_format: 'auto' },
      ],
      overwrite: true,
    };

    if (process.env.CLOUDINARY_UPLOAD_PRESET) {
      uploadOptions.upload_preset = process.env.CLOUDINARY_UPLOAD_PRESET;
    }

    console.log(`[API/cloudinary] Uploading to folder: ${folder}, public_id: ${publicId}`);

    const result = await cloudinary.uploader.upload(uploadSource, uploadOptions);

    return NextResponse.json({
      success: true,
      secure_url: result.secure_url,
      public_id: result.public_id,
      folder: result.folder,
      created_at: new Date(result.created_at).toISOString()
    });

  } catch (error) {
    console.error('Cloudinary upload error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
