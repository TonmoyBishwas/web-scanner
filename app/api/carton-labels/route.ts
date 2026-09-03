import { NextRequest, NextResponse } from 'next/server';
import { getSessionContext } from '@/lib/session-guard';
import {
  createCartonBatch,
  deleteCartonBatch,
  listCartonLabels,
  LABEL_SIZES,
  type LabelSize,
} from '@/lib/carton-labels';

const unauthorized = () =>
  NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });

/**
 * GET /api/carton-labels?token&scope&status
 *
 * Labels screen list. `scope=delivery` (default) returns the stickers minted
 * for the session's own delivery; `scope=all` returns the most recent stickers
 * warehouse-wide, which is also what an ISSUE session (no document number)
 * falls back to.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const context = await getSessionContext(searchParams.get('token'));
    if (!context) return unauthorized();

    const scope = searchParams.get('scope') === 'all' ? 'all' : 'delivery';
    const rawStatus = searchParams.get('status');
    const status = rawStatus === 'created' || rawStatus === 'printed' ? rawStatus : 'all';

    const labels = await listCartonLabels({
      documentNumber: scope === 'delivery' ? context.documentNumber : null,
      status,
    });

    return NextResponse.json({
      success: true,
      labels,
      document_number: context.documentNumber,
      scope,
    });
  } catch (error) {
    console.error('[api/carton-labels] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load labels' }, { status: 500 });
  }
}

/**
 * POST /api/carton-labels
 *
 * Mint one sticker per carton for an item on this delivery's invoice. Creating
 * labels books no stock — the printed sticker goes on the box and is scanned
 * in through the ordinary receiving flow.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const token: string | undefined = body.token;
    const context = await getSessionContext(token ?? null);
    if (!context || !token) return unauthorized();

    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 500) {
      return NextResponse.json(
        { success: false, error: 'quantity must be between 1 and 500' },
        { status: 400 }
      );
    }

    const nameHe = typeof body.item_name_hebrew === 'string' ? body.item_name_hebrew.trim() : '';
    const nameEn = typeof body.item_name_english === 'string' ? body.item_name_english.trim() : '';
    if (!nameHe && !nameEn) {
      return NextResponse.json(
        { success: false, error: 'an item must be selected' },
        { status: 400 }
      );
    }

    const rawWeight = body.weight_kg;
    const weight =
      rawWeight === null || rawWeight === undefined || rawWeight === ''
        ? null
        : Number(rawWeight);
    if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 2000)) {
      return NextResponse.json({ success: false, error: 'invalid weight_kg' }, { status: 400 });
    }

    const labelSize: LabelSize = LABEL_SIZES.includes(body.label_size) ? body.label_size : '10x15';

    const labels = await createCartonBatch({
      sessionToken: token,
      documentNumber: context.documentNumber,
      itemCode: typeof body.item_code === 'string' ? body.item_code : null,
      itemNameHebrew: nameHe || null,
      itemNameEnglish: nameEn || null,
      weightKg: weight,
      quantity,
      productionDate: typeof body.production_date === 'string' ? body.production_date : null,
      expiryDate: typeof body.expiry_date === 'string' ? body.expiry_date : null,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 500) : null,
      printBarcode: body.print_barcode !== false,
      labelSize,
      createdByChatId: context.chatId,
    });

    return NextResponse.json({ success: true, labels, batch_id: labels[0]?.batch_id ?? null });
  } catch (error) {
    console.error('[api/carton-labels] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create labels' }, { status: 500 });
  }
}

/**
 * DELETE /api/carton-labels?token&batch
 *
 * Removes a whole batch — the undo for a mis-typed submission. Safe because a
 * label row owns no stock; the worst case is a printed sticker with no ledger
 * entry, which is exactly the situation the feature exists to fix.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const context = await getSessionContext(searchParams.get('token'));
    if (!context) return unauthorized();

    const batchId = searchParams.get('batch');
    if (!batchId) {
      return NextResponse.json({ success: false, error: 'batch is required' }, { status: 400 });
    }

    const deleted = await deleteCartonBatch(batchId);
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error('[api/carton-labels] DELETE error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete labels' }, { status: 500 });
  }
}
