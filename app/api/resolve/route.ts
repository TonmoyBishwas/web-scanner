import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { ScanEntry } from '@/types';
import { normalizeString } from '@/lib/string-utils';

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

        // Use locking to prevent race conditions
        await sessionStorage.withLock(token, async () => {
            // Re-fetch session inside lock
            const session = await sessionStorage.get(token);
            if (!session || session.status !== 'ACTIVE') {
                // return inside lock? returning directly sends 200 with void body if not careful.
                // Better to throw or handle response outside.
                // For simplicity in this tool, we'll update local session variable and checks.
                throw new Error('Invalid or expired session');
            }

            // Find scan entry
            const entry = session.scanned_barcodes.find(
                (b: ScanEntry) => b.barcode === barcode
            );

            if (!entry) throw new Error('Barcode not found in session');

            // Update with resolved values
            let changesMade = false;

            if (resolved_item_name) {
                entry.resolved_item_name = resolved_item_name;
                changesMade = true;

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
                changesMade = true;

                // Update weight in scanned_items
                const itemName = resolved_item_name || entry.ocr_data?.product_name || entry.resolved_item_name;
                if (itemName) {
                    const matchedItem = session.invoice_items.find(
                        (item: any) => {
                            const pName = normalizeString(itemName);
                            return normalizeString(item.item_name_hebrew) === pName ||
                                normalizeString(item.item_name_english) === pName;
                        }
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
                changesMade = true;
            }

            // Mark as manually resolved
            entry.ocr_status = 'manual';
            changesMade = true;

            // Save session
            if (changesMade) {
                await sessionStorage.set(token, session, { ex: 3600 });
                console.log(`[API/resolve] Resolved barcode ${barcode} in session ${token}`);
            }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        // ... error handling
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Invalid') || msg.includes('found')) {
            return NextResponse.json({ success: false, error: msg }, { status: 400 });
        }
        console.error('[API/resolve] Error:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
