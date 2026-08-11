import { NextRequest, NextResponse } from 'next/server';
import { isValidSessionToken } from '@/lib/session-guard';
import { listDocuments, type CategoryFilter } from '@/lib/documents';

const CATEGORY_VALUES: CategoryFilter[] = ['all', 'meat', 'non_meat'];

/**
 * GET /api/documents?token&q&category&month&page
 *
 * Documents-archive list (completed deliveries only). Requires a live
 * scan-session token. `q` matches document number / supplier / item names;
 * `category` = all|meat|non_meat; `month` = YYYY-MM.
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

    const rawCategory = searchParams.get('category') as CategoryFilter | null;
    const category =
      rawCategory && CATEGORY_VALUES.includes(rawCategory) ? rawCategory : 'all';
    const rawMonth = searchParams.get('month') ?? '';
    const month = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : undefined;
    const page = Math.max(parseInt(searchParams.get('page') ?? '0', 10) || 0, 0);
    const q = searchParams.get('q') ?? '';

    const result = await listDocuments({ q, category, month, page });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[api/documents] error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load documents' },
      { status: 500 }
    );
  }
}
