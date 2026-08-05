import { NextRequest, NextResponse } from 'next/server';
import { isValidSessionToken } from '@/lib/session-guard';
import { getDocumentDetail, type DocSource } from '@/lib/documents';

/**
 * GET /api/documents/detail?token&source&id
 *
 * Full document view: card + invoice lines (with discrepancies) + pallets
 * created + Type B voice note. `source` = meat|non_meat; `id` = delivery uuid
 * (meat) or non_meat_inventory.session_id (non-meat).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const token = searchParams.get('token');

    if (!(await isValidSessionToken(token))) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired session' },
        { status: 401 }
      );
    }

    const source = searchParams.get('source') as DocSource | null;
    const id = searchParams.get('id');
    if ((source !== 'meat' && source !== 'non_meat') || !id) {
      return NextResponse.json(
        { success: false, error: 'source and id are required' },
        { status: 400 }
      );
    }

    const detail = await getDocumentDetail(source, id);
    if (!detail) {
      return NextResponse.json(
        { success: false, error: 'Document not found' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, ...detail });
  } catch (error) {
    console.error('[api/documents/detail] error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load document' },
      { status: 500 }
    );
  }
}
