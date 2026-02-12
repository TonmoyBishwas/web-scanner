import { NextRequest, NextResponse } from 'next/server';
import { sessionStorage } from '@/lib/redis';
import type { CompleteRequest, CompleteResponse, ScannedItem, ScanEntry } from '@/types';
import { normalizeString } from '@/lib/string-utils';
import { validateMatchWithLLM } from '@/lib/llm-matcher';

/**
 * Multi-layer matching strategy for invoice items
 *
 * Tries progressively more sophisticated matching until a confident match is found
 */
async function findMatchingInvoiceItem(
  productNameHebrew: string | null | undefined,
  productNameEnglish: string | null | undefined,
  invoiceItems: any[]
): Promise<{ match: any | null; confidence: string; reasoning: string }> {
  // Fallback for backwards compatibility
  const hebName = productNameHebrew || '';
  const engName = productNameEnglish || '';

  console.log(`[Matching] Starting multi-layer match for Hebrew="${hebName}", English="${engName}"`);
  console.log(`[Matching] Invoice items count: ${invoiceItems.length}`);

  // Layer 1: Exact Hebrew Match
  console.log('[Matching] Layer 1: Exact Hebrew match...');
  const exactHebrewMatch = invoiceItems.find(item => {
    const match = normalizeString(hebName) === normalizeString(item.item_name_hebrew);
    if (match) {
      console.log(`[Matching] ✅ Layer 1 MATCH: "${hebName}" === "${item.item_name_hebrew}"`);
    }
    return match;
  });
  if (exactHebrewMatch) {
    return {
      match: exactHebrewMatch,
      confidence: 'high',
      reasoning: 'Exact Hebrew name match'
    };
  }

  // Layer 2: Exact English Match
  console.log('[Matching] Layer 2: Exact English match...');
  const exactEnglishMatch = invoiceItems.find(item => {
    const match = normalizeString(engName) === normalizeString(item.item_name_english);
    if (match) {
      console.log(`[Matching] ✅ Layer 2 MATCH: "${engName}" === "${item.item_name_english}"`);
    }
    return match;
  });
  if (exactEnglishMatch) {
    return {
      match: exactEnglishMatch,
      confidence: 'high',
      reasoning: 'Exact English name match'
    };
  }

  // Layer 3: Fuzzy Hebrew Substring Match
  console.log('[Matching] Layer 3: Fuzzy Hebrew substring match...');
  const fuzzyHebrewMatches = invoiceItems.filter(item => {
    const pName = normalizeString(hebName);
    const iName = normalizeString(item.item_name_hebrew);
    return (pName.includes(iName) || iName.includes(pName)) && iName.length > 3;
  });

  console.log(`[Matching] Layer 3 found ${fuzzyHebrewMatches.length} candidates`);

  if (fuzzyHebrewMatches.length === 1) {
    console.log(`[Matching] ✅ Layer 3 MATCH (single candidate): "${hebName}" ~= "${fuzzyHebrewMatches[0].item_name_hebrew}"`);
    return {
      match: fuzzyHebrewMatches[0],
      confidence: 'medium',
      reasoning: 'Fuzzy Hebrew substring match (single candidate)'
    };
  }

  // Layer 4: Fuzzy English Substring Match
  console.log('[Matching] Layer 4: Fuzzy English substring match...');
  const fuzzyEnglishMatches = invoiceItems.filter(item => {
    const pName = normalizeString(engName);
    const iName = normalizeString(item.item_name_english);
    return (pName.includes(iName) || iName.includes(pName)) && iName.length > 3;
  });

  console.log(`[Matching] Layer 4 found ${fuzzyEnglishMatches.length} candidates`);

  if (fuzzyEnglishMatches.length === 1) {
    console.log(`[Matching] ✅ Layer 4 MATCH (single candidate): "${engName}" ~= "${fuzzyEnglishMatches[0].item_name_english}"`);
    return {
      match: fuzzyEnglishMatches[0],
      confidence: 'medium',
      reasoning: 'Fuzzy English substring match (single candidate)'
    };
  }

  // Layer 5: LLM Cross-Validation
  console.log('[Matching] Layer 5: LLM cross-validation...');
  try {
    const llmResult = await validateMatchWithLLM({
      product_name_hebrew: hebName,
      product_name_english: engName,
      invoice_items: invoiceItems.map(item => ({
        item_index: item.item_index,
        item_name_hebrew: item.item_name_hebrew,
        item_name_english: item.item_name_english
      }))
    });

    console.log(`[Matching] LLM result: confidence=${llmResult.confidence}, reasoning="${llmResult.reasoning}"`);

    if (llmResult.confidence !== 'none' && llmResult.matched_index !== null) {
      const match = invoiceItems.find(item => item.item_index === llmResult.matched_index);
      if (match) {
        console.log(`[Matching] ✅ Layer 5 MATCH: Index ${llmResult.matched_index} (${match.item_name_english})`);
        return {
          match,
          confidence: llmResult.confidence,
          reasoning: `LLM validation: ${llmResult.reasoning}`
        };
      }
    }
  } catch (llmError) {
    console.error('[Matching] LLM validation failed:', llmError);
  }

  // No match found
  console.log(`[Matching] ❌ NO MATCH found for Hebrew="${hebName}", English="${engName}"`);
  return {
    match: null,
    confidence: 'none',
    reasoning: 'No matching invoice item found across all layers'
  };
}

/**
 * POST /api/complete
 * Mark session as complete and send webhook to bot
 */
export async function POST(request: NextRequest) {
  try {
    const body: CompleteRequest = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Missing token' },
        { status: 400 }
      );
    }

    let response: CompleteResponse | null = null;
    let errorResponse: NextResponse | null = null;

    try {
      await sessionStorage.withLock(token, async () => {
        // Get session inside lock
        const session = await sessionStorage.get(token);
        console.log(`[API/complete] Completing session ${token}. Scanned barcodes: ${session?.scanned_barcodes?.length}, Scanned items keys: ${Object.keys(session?.scanned_items || {}).join(',')}`);

        if (!session) {
          errorResponse = NextResponse.json(
            { success: false, error: 'Session not found' },
            { status: 404 }
          );
          return;
        }

        // Check if already completed AND webhook sent
        if (session.status === 'COMPLETED' && session.webhook_sent) {
          console.log(`[API/complete] Session ${token} already completed and webhook sent.`);
          response = {
            success: true,
            summary: session.scanned_items,
            scanned_barcodes: session.scanned_barcodes
          };
          return;
        }

        // Re-calculate summary from scratch to ensure accuracy (fix for missing items)
        // We do not trust session.scanned_items as it might have missed unmatched items during incremental updates
        interface AggregatedItem {
          item_index: number;
          item_name: string;
          scanned_count: number;
          scanned_weight: number;
          expected_weight: number;
          expected_boxes: number;
        }

        const freshSummary: Record<string, AggregatedItem> = {};

        // 1. Initialize with invoice items (optional, but good for completeness if we want to show 0/X)
        // We will just add them as we find them in scans to match current behavior

        // 2. Iterate through all scanned barcodes
        const validScans = session.scanned_barcodes.filter((b: ScanEntry) =>
          b.ocr_status === 'complete' || b.ocr_status === 'manual'
        );

        let totalWeightScanned = 0;

        for (const scan of validScans) {
          // Determine the product name and weight for this scan
          // Determine final product names (priority: manual > resolved > ocr)
          // Support both old (single product_name) and new (dual-language) formats
          let productNameHebrew = null;
          let productNameEnglish = null;

          if (scan.manual_entry?.item_name) {
            // Manual entry uses single name field (could be either language)
            productNameHebrew = scan.manual_entry.item_name;
            productNameEnglish = scan.manual_entry.item_name;
          } else if (scan.resolved_item_name) {
            productNameHebrew = scan.resolved_item_name;
            productNameEnglish = scan.resolved_item_name;
          } else if (scan.ocr_data) {
            // New format: dual-language
            productNameHebrew = scan.ocr_data.product_name_hebrew || scan.ocr_data.product_name;
            productNameEnglish = scan.ocr_data.product_name_english || scan.ocr_data.product_name;
          }

          // Determine final weight (priority: manual > resolved > ocr)
          let weight = 0;
          if (scan.manual_entry?.weight) weight = scan.manual_entry.weight;
          else if (scan.resolved_weight !== undefined && scan.resolved_weight !== null) weight = scan.resolved_weight;
          else if (scan.ocr_data?.weight_kg) weight = scan.ocr_data.weight_kg;

          if (!productNameHebrew && !productNameEnglish) {
            // Should not happen for completed/manual scans, but safe fallback
            productNameHebrew = "Unknown Item";
            productNameEnglish = "Unknown Item";
          }

          totalWeightScanned += weight;

          // 3. Try to match to an invoice item using multi-layer matching
          const matchResult = await findMatchingInvoiceItem(
            productNameHebrew,
            productNameEnglish,
            session.invoice_items
          );

          const matchedItem = matchResult.match;

          console.log(`[API/complete] Match result for Hebrew="${productNameHebrew}", English="${productNameEnglish}": ` +
            `${matchedItem ? `MATCHED (${matchResult.confidence})` : 'UNMATCHED'} - ${matchResult.reasoning}`);

          // 4. Update the fresh summary
          if (matchedItem) {
            const index = matchedItem.item_index;
            if (!freshSummary[index]) {
              freshSummary[index] = {
                item_index: index,
                item_name: matchedItem.item_name_english || matchedItem.item_name_hebrew,
                scanned_count: 0,
                scanned_weight: 0,
                expected_weight: matchedItem.quantity_kg,
                expected_boxes: matchedItem.expected_boxes
              };
            }
            freshSummary[index].scanned_count += 1;
            freshSummary[index].scanned_weight += weight;
          } else {
            // UNMATCHED ITEM - Create a special entry
            // Use a key that won't collide with numeric item_index
            const displayName = productNameHebrew || productNameEnglish || 'Unknown';
            const unmatchedKey = `unmatched_${displayName.replace(/\s+/g, '_')}`;
            if (!freshSummary[unmatchedKey]) {
              freshSummary[unmatchedKey] = {
                item_index: -1, // -1 indicates unmatched
                item_name: `[Unmatched] ${displayName}`,
                scanned_count: 0,
                scanned_weight: 0,
                expected_weight: 0,
                expected_boxes: 0
              };
            }
            freshSummary[unmatchedKey].scanned_count += 1;
            freshSummary[unmatchedKey].scanned_weight += weight;
          }
        }

        console.log(`[API/complete] Re-aggregated summary. Total weight: ${totalWeightScanned}`);

        const webhookPayload = {
          chat_id: session.chat_id,
          token: token,
          document_number: session.document_number,
          operation_type: session.operation_type,
          summary: {
            total_items: Object.keys(freshSummary).length,
            total_scans: validScans.length,
            total_weight_scanned: totalWeightScanned,
            scanned_items: freshSummary // Use the fresh summary
          },
          scanned_barcodes: session.scanned_barcodes
        };

        // Send webhook to Telegram bot
        const webhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
        if (!webhookUrl) {
          throw new Error('TELEGRAM_BOT_WEBHOOK_URL not configured');
        }

        console.log(`[API/complete] Sending webhook to ${webhookUrl}/webhook/scan-complete`);

        // Note: We are holding the lock while calling the webhook. 
        // This is necessary to prevent double-sends.
        const webhookRes = await fetch(`${webhookUrl}/webhook/scan-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload)
        });

        if (!webhookRes.ok) {
          const errorText = await webhookRes.text();
          console.error(`[API/complete] Webhook failed: ${webhookRes.status} ${webhookRes.statusText} - ${errorText}`);
          throw new Error(`Bot webhook failed: ${webhookRes.status}`);
        }

        console.log('[API/complete] Webhook sent successfully');

        // Mark session as COMPLETED (only after successful webhook)
        session.status = 'COMPLETED';
        session.webhook_sent = true;
        session.completed_at = new Date().toISOString();

        // Save with extended expiry (24 hours)
        await sessionStorage.set(token, session, { ex: 86400 });

        response = {
          success: true,
          summary: session.scanned_items || {},
          scanned_barcodes: session.scanned_barcodes
        };
      });
    } catch (lockError) {
      console.error('[API/complete] Error or Lock failed:', lockError);
      return NextResponse.json(
        { success: false, error: 'Failed to notify bot. Please try again.' },
        { status: 500 }
      );
    }

    if (errorResponse) {
      return errorResponse;
    }

    return NextResponse.json(response!);

  } catch (error) {
    console.error('[API/complete] Error completing session:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to notify bot. Please try again.' },
      { status: 500 }
    );
  }
}
