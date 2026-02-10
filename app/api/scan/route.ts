import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';
import type { ScanRequest, ScanResponse, ScanEntry, ParsedBarcode } from '@/types';

/**
 * POST /api/scan
 * Submit a barcode scan
 *
 * Barcodes are IDs only (for deduplication). All data comes from OCR or manual entry.
 * Item matching happens via OCR product name, NOT barcode SKU.
 */
export async function POST(request: NextRequest) {
  try {
    const body: ScanRequest = await request.json();
    const {
      token,
      barcode,
      parsed_data,
      image_url,
      image_public_id,
      detected_at,
      document_number,
      scan_method = 'barcode'
    } = body;

    // Validate required fields
    if (!token || !barcode) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: token and barcode are required' },
        { status: 400 }
      );
    }

    // image_url is now required for all scans
    if (!image_url) {
      return NextResponse.json(
        { success: false, error: 'Missing required field: image_url is required for all scans' },
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

    // Check for duplicate barcode (deduplication only)
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

    // Parse barcode (for ID only, no data extraction)
    let boxData: ParsedBarcode | null = parsed_data || null;
    if (!boxData) {
      boxData = parseIsraeliBarcode(barcode);
    }

    // Create scan entry - barcode is just an ID, item matching happens via OCR later
    const scanEntry: ScanEntry = {
      barcode: boxData?.raw_barcode || barcode,
      scanned_at: detected_at || new Date().toISOString(),
      image_url: image_url,
      image_public_id: image_public_id || '',
      ocr_status: 'pending',
      scan_method: scan_method as 'barcode' | 'manual_capture' | 'force_confirm'
    };

    // Add to scanned barcodes
    session.scanned_barcodes.push(scanEntry);

    // Save session
    await sessionStorage.set(token, session, { ex: 3600 });

    // Calculate box progress
    const totalBoxesScanned = session.scanned_barcodes.length;
    const totalBoxesExpected = session.invoice_items.reduce(
      (sum: number, item: any) => sum + (item.expected_boxes || 0),
      0
    );

    const totalWeightScanned = Object.values(session.scanned_items || {}).reduce(
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
      overall_progress: {
        total_items: session.invoice_items.length,
        total_weight_scanned: totalWeightScanned,
        total_weight_expected: totalWeightExpected,
        completion_rate: totalWeightExpected > 0 ? totalWeightScanned / totalWeightExpected : 0,
        total_boxes_scanned: totalBoxesScanned,
        total_boxes_expected: totalBoxesExpected
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
