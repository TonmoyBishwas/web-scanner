import { NextRequest, NextResponse } from 'next/server';
import { isValidSessionToken } from '@/lib/session-guard';
import { getPalletDetail } from '@/lib/pallet-browser';

/**
 * GET /api/pallets/detail?token&id
 *
 * Pallet header + per-item remaining/expected breakdown (meat, non-meat and
 * Loose branches). Requires a live scan-session token.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const token = searchParams.get('token');

    if (!(await isValidSessionToken(token))) {
      return NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });
    }

    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing pallet id' }, { status: 400 });
    }

    const detail = await getPalletDetail({ id });
    if (!detail) {
      return NextResponse.json({ success: false, error: 'Pallet not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, ...detail });
  } catch (error) {
    console.error('[api/pallets/detail] error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load pallet' }, { status: 500 });
  }
}
