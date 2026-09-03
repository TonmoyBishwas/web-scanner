import { NextRequest, NextResponse } from 'next/server';
import { getSessionContext } from '@/lib/session-guard';
import {
  getCartonLabelsByBatches,
  getCartonLabelsByIds,
  markCartonLabelsPrinted,
  LABEL_SIZES,
  type LabelSize,
} from '@/lib/carton-labels';

const splitCsv = (v: string | null) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

/**
 * GET /api/carton-labels/print?token&batches|ids
 *
 * Feeds the print sheet. Selection on the Labels screen is per batch, so the
 * sheet is normally addressed by `batches` — a URL carrying 200 individual
 * label ids would blow past what some browsers accept.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const context = await getSessionContext(searchParams.get('token'));
    if (!context) {
      return NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });
    }

    const batches = splitCsv(searchParams.get('batches'));
    const labels = batches.length
      ? await getCartonLabelsByBatches(batches)
      : await getCartonLabelsByIds(splitCsv(searchParams.get('ids')));
    return NextResponse.json({ success: true, labels });
  } catch (error) {
    console.error('[api/carton-labels/print] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load labels' }, { status: 500 });
  }
}

/**
 * POST /api/carton-labels/print
 *
 * Marks labels as sent to the printer. The browser's print dialog never tells
 * us whether paper came out, so this records the hand-off; reprinting the same
 * sticker simply increments its print count.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const context = await getSessionContext(body.token ?? null);
    if (!context) {
      return NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });
    }

    const asStrings = (v: unknown) => (Array.isArray(v) ? v.filter((i): i is string => typeof i === 'string') : []);
    const batchIds = asStrings(body.batch_ids);
    const ids = batchIds.length
      ? (await getCartonLabelsByBatches(batchIds)).map(l => l.id)
      : asStrings(body.ids);
    if (!ids.length) {
      return NextResponse.json({ success: false, error: 'ids or batch_ids is required' }, { status: 400 });
    }

    const labelSize: LabelSize | undefined = LABEL_SIZES.includes(body.label_size)
      ? body.label_size
      : undefined;

    const updated = await markCartonLabelsPrinted(ids, labelSize);
    return NextResponse.json({ success: true, updated });
  } catch (error) {
    console.error('[api/carton-labels/print] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update labels' }, { status: 500 });
  }
}
