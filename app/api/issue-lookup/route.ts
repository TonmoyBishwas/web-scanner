import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import { findBoxByBarcode, getInventoryRecord } from '@/lib/airtable';
import { t } from '@/lib/i18n/server';
import type { BoxLookupResult, ScanSession, Language } from '@/types';

/**
 * POST /api/issue-lookup
 * Look up a box by barcode for the issue flow.
 * Returns box details if found and available.
 */
export async function POST(request: NextRequest) {
  try {
    const { token, barcode } = await request.json();

    if (!token || !barcode) {
      return NextResponse.json(
        { found: false, error: 'error', message: t(undefined, 'errors.missingTokenOrBarcode') },
        { status: 400 }
      );
    }

    // Validate session
    const session: ScanSession | null = await sessionStorage.get(token);
    const lang = (session?.language as Language | undefined);
    if (!session) {
      return NextResponse.json(
        { found: false, error: 'error', message: t(lang, 'errors.sessionNotFound') },
        { status: 404 }
      );
    }

    if (session.operation_type !== 'ISSUE') {
      return NextResponse.json(
        { found: false, error: 'error', message: t(lang, 'errors.notIssueSession') },
        { status: 400 }
      );
    }

    if (session.status !== 'ACTIVE') {
      return NextResponse.json(
        { found: false, error: 'error', message: t(lang, 'errors.sessionInactive') },
        { status: 400 }
      );
    }

    // Check if already issued in this session
    const alreadyIssued = session.issued_boxes?.some(b => b.barcode === barcode);
    if (alreadyIssued) {
      return NextResponse.json({
        found: false,
        error: 'already_issued',
        message: t(lang, 'errors.boxAlreadyIssuedSession'),
      } satisfies BoxLookupResult);
    }

    // Look up box in Airtable
    const boxRecord = await findBoxByBarcode(barcode);
    if (!boxRecord) {
      return NextResponse.json({
        found: false,
        error: 'not_found',
        message: t(lang, 'errors.boxNotFound'),
      } satisfies BoxLookupResult);
    }

    const fields = boxRecord.fields;

    // Check status
    if (fields['Status'] !== 'Available') {
      return NextResponse.json({
        found: false,
        error: 'already_issued',
        message: t(lang, 'errors.boxStatusNotAvailable', { status: String(fields['Status']) }),
      } satisfies BoxLookupResult);
    }

    // Get linked inventory batch for item name, supplier, etc.
    let itemName = '';
    let supplier = '';
    let invoiceNumber = fields['Invoice Number'] || '';
    let batchId = '';

    const inventoryBatchIds = fields['Inventory Batch'];
    if (inventoryBatchIds && Array.isArray(inventoryBatchIds) && inventoryBatchIds.length > 0) {
      batchId = inventoryBatchIds[0];
      try {
        const batchRecord = await getInventoryRecord(batchId);
        itemName = batchRecord.fields['Item Name English'] || batchRecord.fields['Item Name Hebrew'] || '';
        supplier = batchRecord.fields['Supplier English'] || batchRecord.fields['Supplier Hebrew'] || '';
      } catch (e) {
        console.error(`[issue-lookup] Failed to get inventory batch ${batchId}:`, e);
      }
    }

    const result: BoxLookupResult = {
      found: true,
      box: {
        record_id: boxRecord.record_id,
        barcode: fields['Barcode'] || barcode,
        sku: fields['Box SKU'] || '',
        weight: fields['Box Weight'] || 0,
        expiry: fields['Box Expiry'] || '',
        status: fields['Status'],
        batch_id: batchId,
        item_name: itemName,
        supplier: supplier,
        invoice_number: invoiceNumber,
        received_date: fields['Received Date'] || '',
        production_date: fields['Production Date'] || undefined,
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error('[issue-lookup] Error:', error);
    return NextResponse.json(
      { found: false, error: 'error', message: t(undefined, 'errors.serverError') },
      { status: 500 }
    );
  }
}
