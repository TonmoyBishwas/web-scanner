import { NextRequest, NextResponse } from 'next/server';
import { isValidSessionToken } from '@/lib/session-guard';
import {
  listPallets,
  findPalletByBoxBarcode,
  getPalletDetail,
  type StatusFilter,
} from '@/lib/pallet-browser';

const STATUS_VALUES: StatusFilter[] = ['active', 'in_stock', 'partial', 'empty', 'all'];

/**
 * GET /api/pallets?token&q&status&barcode&lpn&page
 *
 * Pallets-browser list + scan-to-find. Requires a live scan-session token.
 *   - barcode: box barcode → returns the owning pallet as a 1-element list
 *   - lpn: exact LPN (scanned QR) → returns that pallet as a 1-element list
 *   - otherwise: paged list filtered by q (LPN / item name / document) + status
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const token = searchParams.get('token');

    if (!(await isValidSessionToken(token))) {
      return NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });
    }

    const barcode = searchParams.get('barcode');
    if (barcode) {
      const pallet = await findPalletByBoxBarcode(barcode);
      return NextResponse.json({ success: true, pallets: pallet ? [pallet] : [], hasMore: false });
    }

    const lpn = searchParams.get('lpn');
    if (lpn) {
      const detail = await getPalletDetail({ lpn });
      return NextResponse.json({
        success: true,
        pallets: detail ? [detail.card] : [],
        hasMore: false,
      });
    }

    const rawStatus = searchParams.get('status') as StatusFilter | null;
    const status = rawStatus && STATUS_VALUES.includes(rawStatus) ? rawStatus : 'active';
    const page = Math.max(parseInt(searchParams.get('page') ?? '0', 10) || 0, 0);
    const q = searchParams.get('q') ?? '';

    const result = await listPallets({ q, status, page });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[api/pallets] error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load pallets' }, { status: 500 });
  }
}
