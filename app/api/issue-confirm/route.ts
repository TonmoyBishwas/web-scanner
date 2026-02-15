import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import {
  findBoxByBarcode,
  getInventoryRecord,
  createIssueTransaction,
  issueBox,
  updateInventoryQuantity,
} from '@/lib/airtable';
import type { IssuedBox, ScanSession } from '@/types';

/**
 * POST /api/issue-confirm
 * Confirm issuing a specific box. Creates transaction, marks box as issued,
 * decrements inventory.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      token,
      box_record_id,
      batch_id,
      barcode,
      weight,
      sku,
      item_name,
      supplier,
      invoice_number,
      expiry,
    } = body;

    if (!token || !box_record_id || !barcode) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    let result: { success: boolean; transaction_id?: string; error?: string } | null = null;
    let errorResponse: NextResponse | null = null;

    try {
      await sessionStorage.withLock(token, async () => {
        // Validate session
        const session: ScanSession | null = await sessionStorage.get(token);
        if (!session) {
          errorResponse = NextResponse.json(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
          return;
        }

        if (session.operation_type !== 'ISSUE' || session.status !== 'ACTIVE') {
          errorResponse = NextResponse.json(
            { success: false, error: 'Invalid session state' },
            { status: 400 }
          );
          return;
        }

        // Double-check box is still available (race condition guard)
        const boxRecord = await findBoxByBarcode(barcode);
        if (!boxRecord || boxRecord.fields['Status'] !== 'Available') {
          errorResponse = NextResponse.json(
            { success: false, error: 'Box is no longer available' },
            { status: 409 }
          );
          return;
        }

        // Get batch details for transaction
        let itemCode = '';
        let itemNameEng = item_name || '';
        let itemNameHeb = '';
        let supplierEng = supplier || '';
        let supplierHeb = '';

        if (batch_id) {
          try {
            const batchRecord = await getInventoryRecord(batch_id);
            itemCode = batchRecord.fields['Item Code'] || '';
            itemNameEng = batchRecord.fields['Item Name English'] || itemNameEng;
            itemNameHeb = batchRecord.fields['Item Name Hebrew'] || '';
            supplierEng = batchRecord.fields['Supplier English'] || supplierEng;
            supplierHeb = batchRecord.fields['Supplier Hebrew'] || '';
          } catch (e) {
            console.error(`[issue-confirm] Failed to get batch ${batch_id}:`, e);
          }
        }

        // 1. Create OUT transaction
        const txResult = await createIssueTransaction({
          itemCode,
          itemNameEnglish: itemNameEng,
          itemNameHebrew: itemNameHeb,
          supplierEnglish: supplierEng,
          supplierHebrew: supplierHeb,
          quantity: weight || 0,
          batchId: batch_id || '',
          boxBarcode: barcode,
          chatId: session.chat_id,
        });

        // 2. Mark box as Issued
        await issueBox(box_record_id, txResult.transaction_id);

        // 3. Decrement inventory batch quantity
        if (batch_id && weight) {
          await updateInventoryQuantity(batch_id, weight);
        }

        // 4. Add to session issued_boxes
        const issuedBox: IssuedBox = {
          barcode,
          sku: sku || '',
          item_name: itemNameEng,
          weight: weight || 0,
          expiry: expiry || '',
          supplier: supplierEng,
          invoice_number: invoice_number || '',
          box_record_id,
          batch_id: batch_id || '',
          transaction_id: txResult.transaction_id,
          issued_at: new Date().toISOString(),
        };

        if (!session.issued_boxes) {
          session.issued_boxes = [];
        }
        session.issued_boxes.push(issuedBox);

        // Save session
        await sessionStorage.set(token, session, { ex: 3600 });

        result = {
          success: true,
          transaction_id: txResult.transaction_id,
        };

        console.log(
          `[issue-confirm] Box ${barcode} issued. Transaction: ${txResult.transaction_id}`
        );
      });
    } catch (lockError) {
      console.error('[issue-confirm] Lock error:', lockError);
      return NextResponse.json(
        { success: false, error: 'Failed to acquire lock. Please try again.' },
        { status: 500 }
      );
    }

    if (errorResponse) return errorResponse;
    return NextResponse.json(result);
  } catch (error) {
    console.error('[issue-confirm] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
