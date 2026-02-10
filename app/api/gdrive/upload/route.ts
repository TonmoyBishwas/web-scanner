import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { Readable } from 'stream';

export interface GDriveUploadRequest {
    image?: string;  // Base64 data URL
    image_url?: string;  // Public URL to fetch image from
    barcode: string;
    document_number?: string;
    image_type?: 'box' | 'invoice';
}

/**
 * Get or create the uploads folder inside the Shared Drive
 */
async function getOrCreateUploadFolder(drive: any, sharedDriveId: string): Promise<string> {
    const folderName = 'Scanner-Uploads';

    try {
        // Search for existing folder
        const searchResponse = await drive.files.list({
            q: `name='${folderName}' and '${sharedDriveId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: 'drive',
            driveId: sharedDriveId,
        });

        if (searchResponse.data.files && searchResponse.data.files.length > 0) {
            console.log(`[API/gdrive] Using existing folder: ${folderName}`);
            return searchResponse.data.files[0].id!;
        }

        // Create new folder
        console.log(`[API/gdrive] Creating new folder: ${folderName}`);
        const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [sharedDriveId],
        };

        const folderResponse = await drive.files.create({
            requestBody: folderMetadata,
            fields: 'id',
            supportsAllDrives: true,
        });

        return folderResponse.data.id!;
    } catch (error) {
        console.error('[API/gdrive] Error with upload folder, using root:', error);
        // Fallback to using the Shared Drive root
        return sharedDriveId;
    }
}


/**
 * POST /api/gdrive/upload
 * Upload a box image to Google Drive
 */
export async function POST(request: NextRequest) {
    try {
        const body: GDriveUploadRequest = await request.json();
        const { image, image_url, barcode, document_number, image_type = 'box' } = body;

        // Validate required fields
        if (!barcode || (!image && !image_url)) {
            return NextResponse.json(
                { success: false, error: 'Missing required fields: barcode and either image or image_url are required' },
                { status: 400 }
            );
        }

        // Check if Google Drive is configured
        const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

        if (!credentials || !folderId) {
            return NextResponse.json(
                { success: false, error: 'Google Drive not configured' },
                { status: 500 }
            );
        }

        // Parse credentials
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(credentials),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });

        const drive = google.drive({ version: 'v3', auth });

        // Determine upload source
        let imageBuffer: Buffer;
        let mimeType = 'image/jpeg';

        if (image) {
            // Remove data URL prefix if present
            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            imageBuffer = Buffer.from(base64Data, 'base64');
        } else if (image_url) {
            // Fetch image from URL
            const response = await fetch(image_url);
            if (!response.ok) {
                return NextResponse.json(
                    { success: false, error: `Failed to fetch image from URL: ${response.statusText}` },
                    { status: 400 }
                );
            }
            const arrayBuffer = await response.arrayBuffer();
            imageBuffer = Buffer.from(arrayBuffer);
        } else {
            return NextResponse.json(
                { success: false, error: 'Either image or image_url must be provided' },
                { status: 400 }
            );
        }


        // Get or create subfolder in Shared Drive
        const uploadFolderId = await getOrCreateUploadFolder(drive, folderId);

        // Create filename
        const timestamp = Date.now();
        const fileName = document_number
            ? `${document_number}/${image_type}-${barcode}.jpg`
            : `box-${barcode}-${timestamp}.jpg`;

        console.log(`[API/gdrive] Uploading to Google Drive subfolder: ${fileName}`);

        // Upload to Google Drive
        const fileMetadata = {
            name: fileName,
            parents: [uploadFolderId],
        };

        const media = {
            mimeType,
            body: Readable.from(imageBuffer),
        };

        const uploadResponse = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink, webContentLink',
            supportsAllDrives: true,  // CRITICAL: Enable Shared Drives support
            supportsTeamDrives: true, // Legacy parameter for compatibility
        });

        const fileId = uploadResponse.data.id;

        // Make file publicly accessible (optional - adjust permissions as needed)
        await drive.permissions.create({
            fileId: fileId!,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
            supportsAllDrives: true,  // CRITICAL: Enable Shared Drives support
            supportsTeamDrives: true, // Legacy parameter for compatibility
        });

        // Generate public URL
        const publicUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

        console.log(`[API/gdrive] Upload successful: ${publicUrl}`);

        return NextResponse.json({
            success: true,
            secure_url: publicUrl,
            public_id: fileId,
            folder: folderId,
            created_at: new Date().toISOString(),
        });

    } catch (error) {
        console.error('Google Drive upload error:', error);
        const errorMsg = error instanceof Error ? error.message : 'Upload failed';
        const errorDetails = error && typeof error === 'object' ? JSON.stringify(error) : errorMsg;
        return NextResponse.json(
            { success: false, error: errorMsg, details: errorDetails },
            { status: 500 }
        );
    }
}
