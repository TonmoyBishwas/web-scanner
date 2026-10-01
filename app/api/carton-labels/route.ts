import { NextRequest, NextResponse } from 'next/server';
import { getSessionContext } from '@/lib/session-guard';
import {
  batchHasBookedBoxes,
  createCartonBatch,
  deleteCartonBatch,
  deleteUnprintedLabelByBarcode,
  listCartonLabels,
  LABEL_SIZES,
  type LabelSize,
} from '@/lib/carton-labels';
import { parseBatchId, parseLabelOrigin } from '@/lib/label-batches';
import type { CartonLabelOrigin } from '@/types';

const unauthorized = () =>
  NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });

/**
 * GET /api/carton-labels?token&scope&status
 *
 * Labels screen list.
 *   scope=session (default) — only what THIS scanner session minted. A worker
 *     must not open the screen onto a previous job's stickers, and re-scanning
 *     the same invoice makes a fresh session under the same document number,
 *     so the delivery is too coarse a boundary.
 *   scope=all — the most recent stickers warehouse-wide; the escape hatch for
 *     reprinting something from an earlier job.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const context = await getSessionContext(searchParams.get('token'));
    if (!context) return unauthorized();

    const scope = searchParams.get('scope') === 'all' ? 'all' : 'session';
    const rawStatus = searchParams.get('status');
    const status = rawStatus === 'created' || rawStatus === 'printed' ? rawStatus : 'all';

    const labels = await listCartonLabels({
      sessionToken: scope === 'session' ? searchParams.get('token') : null,
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
 * SAVE one label per carton for an item on this delivery's invoice; printing
 * happens later, from the Labels screen. Writing a label books no stock: a
 * New carton label is scanned in through the ordinary receiving flow, and an
 * identical / receiving label stands for a scan row the page already holds.
 *
 * `batch_id` (optional, a UUID made by the client per form open) makes a
 * retry after a lost response return the same batch instead of a second one.
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

    // "All boxes identical" (pallet-verify), the edit panel's new barcode
    // ('receiving'), or the New carton chip (the default). Each records which
    // pallet it was saved on (0 = loose pile); the identical path also which
    // supplier barcode the batch stands in for.
    const origin: CartonLabelOrigin = parseLabelOrigin(body.origin);
    const sourceBarcode =
      typeof body.source_barcode === 'string' ? body.source_barcode.replace(/\D/g, '').slice(0, 40) || null : null;
    const rawPallet = body.pallet_number;
    const palletNumber =
      rawPallet === null || rawPallet === undefined || rawPallet === '' ? null : Number(rawPallet);
    if (palletNumber !== null && (!Number.isInteger(palletNumber) || palletNumber < 0)) {
      return NextResponse.json({ success: false, error: 'invalid pallet_number' }, { status: 400 });
    }

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
      origin,
      sourceBarcode,
      palletNumber,
      batchId: parseBatchId(body.batch_id),
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
 * Removes a whole batch — the undo for a mis-typed submission. Refused with
 * 409 `labels_booked` when any of its cartons is already stock (booked on an
 * LPN): those labels are on boxes in the warehouse and can only be reprinted.
 * The response names the deleted barcodes so the page can drop their rows.
 *
 * DELETE /api/carton-labels?token&barcode
 *
 * The scan row of an identical / receiving label was deleted from the list:
 * remove that ONE label, but only while it is unprinted and belongs to this
 * session (see deleteUnprintedLabelByBarcode). Anything else is a no-op.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const token = searchParams.get('token');
    const context = await getSessionContext(token);
    if (!context || !token) return unauthorized();

    const barcode = (searchParams.get('barcode') ?? '').replace(/\D/g, '');
    if (barcode) {
      const deleted = await deleteUnprintedLabelByBarcode(token, barcode);
      return NextResponse.json({ success: true, deleted });
    }

    const batchId = searchParams.get('batch');
    if (!batchId) {
      return NextResponse.json({ success: false, error: 'batch or barcode is required' }, { status: 400 });
    }

    if (await batchHasBookedBoxes(batchId)) {
      return NextResponse.json({ success: false, error: 'labels_booked' }, { status: 409 });
    }

    const result = await deleteCartonBatch(batchId);
    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      barcodes: result.barcodes,
      source_barcode: result.sourceBarcode,
    });
  } catch (error) {
    console.error('[api/carton-labels] DELETE error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete labels' }, { status: 500 });
  }
}
