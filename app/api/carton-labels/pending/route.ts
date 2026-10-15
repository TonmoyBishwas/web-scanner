import { NextRequest, NextResponse } from 'next/server';
import { listPendingForDocument } from '@/lib/carton-labels';
import { verifyLabelsLink } from '@/lib/label-link';
import { groupLabelsByPallet } from '@/lib/label-batches';

/**
 * GET /api/carton-labels/pending?doc&sig[&printed=1]
 *
 * The signed "labels waiting — print later" page (lib/label-link.ts): every
 * label of one delivery note still at status 'created', grouped by pallet
 * (0 = loose pile, null = unknown last). `printed=1` also lists the printed
 * ones, for a reprint. No scanner session needed — the link outlives it —
 * but nothing outside that delivery note is reachable, and nothing can be
 * deleted or booked from here.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const doc = (searchParams.get('doc') ?? '').trim();
    if (!doc || !verifyLabelsLink(doc, searchParams.get('sig'))) {
      return NextResponse.json({ success: false, error: 'invalid_link' }, { status: 401 });
    }
    const labels = await listPendingForDocument(doc, searchParams.get('printed') === '1');
    return NextResponse.json({
      success: true,
      document_number: doc,
      labels,
      pallets: groupLabelsByPallet(labels),
    });
  } catch (error) {
    console.error('[api/carton-labels/pending] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load labels' }, { status: 500 });
  }
}
