import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { ScanEntry } from '@/types';

/**
 * POST /api/resolve
 * Resolve an OCR issue by manually providing item_name, weight, or expiry
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { token, barcode, resolved_item_name, resolved_weight, resolved_expiry } = body;

        if (!token || !barcode) {
            return NextResponse.json(
                { success: false, error: 'Missing required fields: token and barcode' },
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

        // Find scan entry
        const entry = session.scanned_barcodes.find(
            (b: ScanEntry) => b.barcode === barcode
        );

        if (!entry) {
            return NextResponse.json(
                { success: false, error: 'Barcode not found in session' },
                { status: 400 }
            );
        }

        // Update with resolved values
        if (resolved_item_name) {
            entry.resolved_item_name = resolved_item_name;

            // Also try to update scanned_items if we can match to an invoice item
            const matchedItem = session.invoice_items.find(
                (item: any) =>
                    item.item_name_hebrew === resolved_item_name ||
                    item.item_name_english === resolved_item_name
            );

            if (matchedItem) {
                const itemIndex = matchedItem.item_index;
                if (!session.scanned_items[itemIndex]) {
                    session.scanned_items[itemIndex] = {
                        item_index: matchedItem.item_index,
                        item_name: matchedItem.item_name_english,
                        scanned_count: 0,
                        scanned_weight: 0,
                        expected_weight: matchedItem.quantity_kg,
                        expected_boxes: matchedItem.expected_boxes
                    };
                }
                session.scanned_items[itemIndex].scanned_count += 1;
            }
        }

        if (resolved_weight !== undefined && resolved_weight !== null) {
            entry.resolved_weight = resolved_weight;

            // Update weight in scanned_items
            const itemName = resolved_item_name || entry.ocr_data?.product_name;
            if (itemName) {
                const matchedItem = session.invoice_items.find(
                    (item: any) =>
                        item.item_name_hebrew === itemName ||
                        item.item_name_english === itemName
                );
                if (matchedItem) {
                    const itemIndex = matchedItem.item_index;
                    if (session.scanned_items[itemIndex]) {
                        session.scanned_items[itemIndex].scanned_weight += resolved_weight;
                    }
                }
            }
        }

        if (resolved_expiry) {
            entry.resolved_expiry = resolved_expiry;
        }

        // Mark as manually resolved
        entry.ocr_status = 'manual';

        // Save session
        await sessionStorage.set(token, session, { ex: 3600 });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error resolving issue:', error);
        return NextResponse.json(
            { success: false, error: 'Internal server error' },
            { status: 500 }
        );
    }
}
