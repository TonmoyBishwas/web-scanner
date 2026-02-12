import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { sessionStorage } from '@/lib/redis';
import type { ScanSession, SessionResponse, ScanEntry } from '@/types';

/**
 * POST /api/session
 * Create a new scan session
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      chat_id,
      operation_type,
      invoice_items,
      document_number,
      invoice_image_url
    } = body;

    // Validate required fields
    if (!chat_id || !operation_type || !invoice_items || !Array.isArray(invoice_items)) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Generate unique token
    const token = nanoid();

    // Create session
    const session: ScanSession = {
      token,
      chat_id,
      operation_type,
      document_number: document_number || '',
      invoice_items,
      scanned_barcodes: [],
      scanned_items: {},
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      status: 'ACTIVE',
      invoice_image_url  // Store invoice image URL if provided
    };

    // Store in Redis
    await sessionStorage.set(token, session, { ex: 3600 });

    // Build response
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const response: SessionResponse = {
      token,
      scan_url: `${appUrl}/scan/${token}`,
      expires_at: session.expires_at
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error creating session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/session?token=xxx
 * Get session details
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json(
        { error: 'Missing token parameter' },
        { status: 400 }
      );
    }

    const session = await sessionStorage.get(token);

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(session);
  } catch (error) {
    console.error('Error getting session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/session?token=xxx
 * Update session details
 */
// PUT /api/session - Update session data
// SUPPORTS:
// 1. Atomic Status Updates (Recommended): { updates: [{ barcode, ocr_status, ... }] }
// 2. Full Session Overwrite (Legacy/Dangerous): { ...sessionData }
export async function PUT(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const body = await request.json();

    if (!token) {
      return NextResponse.json({ success: false, error: 'Token required' }, { status: 400 });
    }

    // ── MODE 1: Atomic Updates (Safe) ──────────────────────────────
    if (body.updates && Array.isArray(body.updates)) {
      console.log(`[API/session] Processing ${body.updates.length} atomic updates for ${token}`);

      try {
        await sessionStorage.withLock(token, async () => {
          const currentSession = await sessionStorage.get(token);
          if (!currentSession) throw new Error('Session not found');

          let changesMade = false;
          body.updates.forEach((update: any) => {
            const entry = currentSession.scanned_barcodes.find((b: ScanEntry) => b.barcode === update.barcode);
            if (entry) {
              // Only update if status implies a change
              if (update.ocr_status && entry.ocr_status !== 'complete') { // Don't overwrite completed items with timeout
                entry.ocr_status = update.ocr_status;
                if (update.ocr_error) entry.ocr_error = update.ocr_error;
                changesMade = true;
              }
            }
          });

          if (changesMade) {
            await sessionStorage.set(token, currentSession, { ex: 3600 });
            console.log(`[API/session] Atomically updated session ${token}`);
          }
        });

        return NextResponse.json({ success: true, mode: 'atomic' });
      } catch (err) {
        console.error('[API/session] Lock/Update error:', err);
        return NextResponse.json({ success: false, error: 'Lock failed' }, { status: 500 });
      }
    }

    // ── MODE 2: Full Overwrite (Legacy - Risk of Race Conditions) ──
    console.warn(`[API/session] ⚠️ PERFORMING FULL SESSION OVERWRITE for ${token} - This risks data loss!`);

    // Validate required fields for full overwrite
    if (!body.scanned_barcodes || !body.invoice_items) {
      return NextResponse.json(
        { success: false, error: 'Invalid session data for full overwrite' },
        { status: 400 }
      );
    }

    const sessionData: ScanSession = body;
    await sessionStorage.set(token, sessionData, { ex: 3600 });
    return NextResponse.json({ success: true, mode: 'overwrite' });

  } catch (error) {
    console.error('Error updates session:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
