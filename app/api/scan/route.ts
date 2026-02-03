import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';
import type { ScanRequest, ScanResponse, ScanEntry, ScannedItem, ParsedBarcode } from '@/types';

/**
 * POST /api/scan
 * Submit a barcode scan
 */
export async function POST(request: NextRequest) {
  try {
    const body: ScanRequest = await request.json();
    const { token, barcode, parsed_data, detected_at } = body;

    // Validate required fields
    if (!token || !barcode) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
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

    // Check for duplicate
    const isDuplicate = session.scanned_barcodes.some(
      (b: ScanEntry) => b.barcode === barcode
    );

    if (isDuplicate) {
      return NextResponse.json({
        success: false,
        is_duplicate: true,
        message: 'Barcode already scanned'
      });
    }

    // Parse barcode if not provided
    let boxData: ParsedBarcode | null = parsed_data || null;
    if (!boxData) {
      boxData = parseIsraeliBarcode(barcode);
    }

    if (!boxData) {
      return NextResponse.json(
        { success: false, error: 'Invalid barcode format' },
        { status: 400 }
      );
    }

    // Match to invoice item
    // Try exact match first, then substring match (item_code may be embedded in SKU)
    const matchedItem = session.invoice_items.find(
      (item: any) => item.item_code === boxData!.sku || boxData!.sku.includes(item.item_code)
    );

    if (!matchedItem) {
      return NextResponse.json({
        success: false,
        error: `Barcode ${boxData.sku} (item_code: ${boxData.sku.slice(-4)}) does not match any invoice item`
      });
    }

    // Create scan entry
    const scanEntry: ScanEntry = {
      barcode: boxData.raw_barcode,
      sku: boxData.sku,
      weight: boxData.weight,
      expiry: boxData.expiry,
      scanned_at: detected_at || new Date().toISOString(),
      item_index: matchedItem.item_index
    };

    // Add to scanned barcodes
    session.scanned_barcodes.push(scanEntry);

    // Update item totals
    const sku = boxData.sku;
    if (!session.scanned_items[sku]) {
      session.scanned_items[sku] = {
        item_index: matchedItem.item_index,
        item_name: matchedItem.item_name_english,
        scanned_count: 0,
        scanned_weight: 0,
        expected_weight: matchedItem.quantity_kg,
        expected_boxes: matchedItem.expected_boxes
      };
    }

    session.scanned_items[sku].scanned_count += 1;
    session.scanned_items[sku].scanned_weight += boxData.weight;

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

    const response: ScanResponse = {
      success: true,
      is_duplicate: false,
      matched_item: session.scanned_items[sku],
      overall_progress: {
        total_items: session.invoice_items.length,
        total_weight_scanned: totalWeightScanned,
        total_weight_expected: totalWeightExpected,
        completion_rate: totalWeightExpected > 0 ? totalWeightScanned / totalWeightExpected : 0
      }
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error submitting scan:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
