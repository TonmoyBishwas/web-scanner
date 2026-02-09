import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { ManualEntryData, ScanEntry, ScannedItem } from '@/types';

/**
 * POST /api/manual-entry
 * Submit a manual entry (without barcode scanning)
 */
export async function POST(request: NextRequest) {
  try {
    const body: ManualEntryData = await request.json();
    const {
      token,
      item_index,
      weight,
      expiry,
      notes,
      image_url,
      image_public_id,
      document_number
    } = body;

    // Validate required fields
    if (!token || item_index === undefined || !weight || !expiry) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: token, item_index, weight, and expiry are required' },
        { status: 400 }
      );
    }

    // Get session
    const session = await sessionStorage.get(token);
    if (!session || session.status !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired session' },
        { status: 400 }
      );
    }

    // Find the invoice item
    const invoiceItem = session.invoice_items.find(
      (item: any) => item.item_index === item_index
    );

    if (!invoiceItem) {
      return NextResponse.json(
        { success: false, error: `Item ${item_index} not found in invoice` },
        { status: 400 }
      );
    }

    // Check if expected boxes limit reached
    const currentItemData = session.scanned_items[item_index];
    const scannedCount = currentItemData?.scanned_count || 0;
    if (scannedCount >= invoiceItem.expected_boxes) {
      return NextResponse.json(
        { success: false, error: `Expected boxes (${invoiceItem.expected_boxes}) already scanned for this item` },
        { status: 400 }
      );
    }

    // Generate a unique barcode ID for manual entry
    const manualBarcode = `manual-${Date.now()}-${item_index}`;

    // Create scan entry with manual entry data
    const scanEntry: ScanEntry = {
      barcode: manualBarcode,
      scanned_at: new Date().toISOString(),
      item_index: item_index,
      image_url: image_url || '',  // May be empty for manual entry
      image_public_id: image_public_id || '',
      ocr_status: 'manual',
      manual_entry: {
        item_index,
        weight,
        expiry,
        notes
      },
      scan_method: 'manual_entry'
    };

    // Add to scanned barcodes
    session.scanned_barcodes.push(scanEntry);

    // Update item totals
    if (!session.scanned_items[item_index]) {
      session.scanned_items[item_index] = {
        item_index: invoiceItem.item_index,
        item_name: invoiceItem.item_name_english,
        scanned_count: 0,
        scanned_weight: 0,
        expected_weight: invoiceItem.quantity_kg,
        expected_boxes: invoiceItem.expected_boxes
      };
    }

    session.scanned_items[item_index].scanned_count += 1;
    session.scanned_items[item_index].scanned_weight += weight;

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

    return NextResponse.json({
      success: true,
      is_duplicate: false,
      matched_item: session.scanned_items[item_index],
      overall_progress: {
        total_items: session.invoice_items.length,
        total_weight_scanned: totalWeightScanned,
        total_weight_expected: totalWeightExpected,
        completion_rate: totalWeightExpected > 0 ? totalWeightScanned / totalWeightExpected : 0
      }
    });

  } catch (error) {
    console.error('Error submitting manual entry:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
