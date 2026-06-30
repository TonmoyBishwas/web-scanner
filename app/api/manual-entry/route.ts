import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { ManualEntryData, ScanEntry } from '@/types';

/**
 * POST /api/manual-entry
 * Submit a manual entry (without barcode scanning)
 * Used by force confirm dialog for remaining unscanned boxes
 */
export async function POST(request: NextRequest) {
  try {
    const body: ManualEntryData = await request.json();
    const {
      token,
      item_name,
      weight,
      expiry,
      notes,
      image_url,
      image_public_id,
    } = body;

    // Validate required fields
    if (!token || !item_name || !weight) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: token, item_name, and weight are required' },
        { status: 400 }
      );
    }

    let errorResult: { status: number; body: Record<string, unknown> } | null = null;
    let okResult: Record<string, unknown> | null = null;

    // Lock the session so a manual entry and a concurrent scan/ocr serialize
    // their read-modify-write — otherwise one writer's counts get lost.
    await sessionStorage.withLock(token, async () => {
      // Get session
      const session = await sessionStorage.get(token);
      if (!session || session.status !== 'ACTIVE') {
        errorResult = { status: 400, body: { success: false, error: 'Invalid or expired session' } };
        return;
      }

      // Find the invoice item by name
      const invoiceItem = session.invoice_items.find(
        (item: any) =>
          item.item_name_english === item_name ||
          item.item_name_hebrew === item_name
      );

      if (!invoiceItem) {
        errorResult = { status: 400, body: { success: false, error: `Item "${item_name}" not found in invoice` } };
        return;
      }

      const itemIndex = invoiceItem.item_index;

      // Generate a unique barcode ID for manual entry
      const manualBarcode = `manual-${Date.now()}-${itemIndex}`;

      // Create scan entry
      const scanEntry: ScanEntry = {
        barcode: manualBarcode,
        scanned_at: new Date().toISOString(),
        image_url: image_url || '',
        image_public_id: image_public_id || '',
        ocr_status: 'manual',
        manual_entry: {
          item_name,
          weight,
          expiry: expiry || '',
          notes
        },
        scan_method: 'force_confirm'
      };

      // Add to scanned barcodes
      session.scanned_barcodes.push(scanEntry);

      // Update item totals
      if (!session.scanned_items[itemIndex]) {
        session.scanned_items[itemIndex] = {
          item_index: invoiceItem.item_index,
          item_name: invoiceItem.item_name_english,
          scanned_count: 0,
          scanned_weight: 0,
          expected_weight: invoiceItem.quantity_kg,
          expected_boxes: invoiceItem.expected_boxes
        };
      }

      session.scanned_items[itemIndex].scanned_count += 1;
      session.scanned_items[itemIndex].scanned_weight += weight;

      // Save session
      await sessionStorage.set(token, session, { ex: 3600 });

      // Calculate progress
      const totalWeightScanned = Object.values(session.scanned_items).reduce(
        (sum: number, item: any) => sum + (item.scanned_weight || 0),
        0
      );
      const totalWeightExpected = session.invoice_items.reduce(
        (sum: number, item: any) => sum + item.quantity_kg,
        0
      );
      const totalBoxesScanned = session.scanned_barcodes.length;
      const totalBoxesExpected = session.invoice_items.reduce(
        (sum: number, item: any) => sum + (item.expected_boxes || 0),
        0
      );

      okResult = {
        success: true,
        is_duplicate: false,
        matched_item: session.scanned_items[itemIndex],
        overall_progress: {
          total_items: session.invoice_items.length,
          total_weight_scanned: totalWeightScanned,
          total_weight_expected: totalWeightExpected,
          completion_rate: totalWeightExpected > 0 ? totalWeightScanned / totalWeightExpected : 0,
          total_boxes_scanned: totalBoxesScanned,
          total_boxes_expected: totalBoxesExpected
        }
      };
    });

    if (errorResult) {
      const e = errorResult as { status: number; body: Record<string, unknown> };
      return NextResponse.json(e.body, { status: e.status });
    }
    return NextResponse.json(okResult);

  } catch (error) {
    console.error('Error submitting manual entry:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
