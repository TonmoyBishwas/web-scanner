import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { sessionStorage } from '@/lib/redis';
import type { ScanSession, SessionResponse } from '@/types';

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
