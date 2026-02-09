/**
 * Cloudinary upload utility for Next.js App Router (server-side only)
 *
 * This file provides type definitions and API client functions for Cloudinary.
 * The actual upload happens via the API route to avoid client-side Node.js dependencies.
 */

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  folder?: string;
  created_at: string;
}

export interface CloudinaryUploadOptions {
  document_number?: string;  // Invoice document number for folder structure
  image_type?: 'box' | 'invoice';  // Type of image being uploaded
}

/**
 * Upload a box image to Cloudinary via API route
 * This is a client-side wrapper that calls the server-side API
 *
 * @param base64Image - Base64 encoded image data (with or without data URI prefix)
 * @param barcode - The barcode associated with this image
 * @param options - Optional parameters including document_number
 * @returns The secure URL and public_id of the uploaded image
 * @throws Error if upload fails
 */
export async function uploadBoxImage(
  base64Image: string,
  barcode: string,
  options?: CloudinaryUploadOptions
): Promise<CloudinaryUploadResult> {
  try {
    // Add data URL prefix if not present
    const imageData = base64Image.startsWith('data:')
      ? base64Image
      : `data:image/jpeg;base64,${base64Image}`;

    // Call the API route for server-side upload
    const response = await fetch('/api/cloudinary/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: imageData,
        barcode,
        document_number: options?.document_number,
        image_type: options?.image_type || 'box'
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Upload failed: ${response.statusText}`);
    }

    const result: CloudinaryUploadResult = await response.json();
    return result;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw new Error(`Failed to upload image: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Upload an invoice image to Cloudinary via API route
 *
 * @param base64Image - Base64 encoded invoice image data
 * @param documentNumber - The invoice document number
 * @returns The secure URL and public_id of the uploaded invoice
 * @throws Error if upload fails
 */
export async function uploadInvoiceImage(
  base64Image: string,
  documentNumber: string
): Promise<CloudinaryUploadResult> {
  return uploadBoxImage(base64Image, documentNumber, {
    document_number: documentNumber,
    image_type: 'invoice'
  });
}

/**
 * Check if Cloudinary is properly configured
 * This is a client-side check for development purposes
 *
 * @returns true if all required environment variables might be set
 */
export function isCloudinaryConfigured(): boolean {
  // We can't check server-side env vars from the client
  // This is just a hint for development
  return typeof window !== 'undefined';
}
