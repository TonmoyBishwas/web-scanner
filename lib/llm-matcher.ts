/**
 * LLM-based cross-validation for invoice item matching
 *
 * Uses Gemini 2.5 Flash to intelligently match scanned product names
 * (from box OCR) against invoice items when string matching is ambiguous.
 *
 * This provides a semantic understanding of product name variations,
 * especially useful for Hebrew text where OCR can produce different
 * spellings, punctuation, or word order.
 */

interface MatchCandidate {
  item_index: number;
  item_name_hebrew: string;
  item_name_english: string;
  confidence?: number;
}

interface MatchRequest {
  product_name_hebrew?: string;
  product_name_english?: string;
  invoice_items: MatchCandidate[];
}

export interface MatchResult {
  matched_index: number | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reasoning: string;
}

/**
 * Validate a match using LLM semantic understanding
 *
 * @param request - Product names and candidate invoice items
 * @returns Best match with confidence score and reasoning
 */
export async function validateMatchWithLLM(
  request: MatchRequest
): Promise<MatchResult> {
  const { product_name_hebrew, product_name_english, invoice_items } = request;

  // Prepare the prompt for Gemini
  const prompt = buildMatchingPrompt(product_name_hebrew, product_name_english, invoice_items);

  try {
    // Call OpenRouter API with Gemini 2.5 Flash
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://scanner.vercel.app',
        'X-Title': 'Warehouse Scanner - Invoice Matching'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1, // Low temperature for consistent results
      })
    });

    if (!response.ok) {
      console.error('[LLM Matcher] API call failed:', response.statusText);
      return {
        matched_index: null,
        confidence: 'none',
        reasoning: `LLM API call failed: ${response.statusText}`
      };
    }

    const result = await response.json();
    const content = result.choices[0].message.content;

    // Parse the JSON response
    const matchResult = parseMatchResponse(content);

    console.log('[LLM Matcher] Result:', matchResult);
    return matchResult;

  } catch (error) {
    console.error('[LLM Matcher] Error:', error);
    return {
      matched_index: null,
      confidence: 'none',
      reasoning: `LLM matching failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Build the matching prompt for the LLM
 */
function buildMatchingPrompt(
  productNameHebrew?: string,
  productNameEnglish?: string,
  invoiceItems: MatchCandidate[] = []
): string {
  const itemsList = invoiceItems.map((item, idx) =>
    `${idx + 1}. Index ${item.item_index}: Hebrew="${item.item_name_hebrew}", English="${item.item_name_english}"`
  ).join('\n');

  return `You are an expert at matching product names for warehouse inventory management.

**TASK**: Determine which invoice item (if any) matches the scanned box product.

**Scanned Product**:
- Hebrew: ${productNameHebrew || 'N/A'}
- English: ${productNameEnglish || 'N/A'}

**Invoice Items**:
${itemsList}

**MATCHING RULES**:
1. Hebrew and English names should semantically refer to the same product
2. OCR variations are common (punctuation, spacing, word order)
3. Exact match is HIGH confidence
4. Semantic equivalence is MEDIUM confidence
5. Partial/unclear match is LOW confidence
6. No match is NONE confidence

**RESPONSE FORMAT** (return ONLY valid JSON, no markdown):
{
  "matched_index": <number or null>,
  "confidence": "high" | "medium" | "low" | "none",
  "reasoning": "Brief explanation of the match decision"
}

If no item matches, return matched_index: null and confidence: "none".`;
}

/**
 * Parse the LLM response into a MatchResult
 */
function parseMatchResponse(content: string): MatchResult {
  try {
    // Clean markdown code blocks if present
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    return {
      matched_index: parsed.matched_index ?? null,
      confidence: parsed.confidence || 'none',
      reasoning: parsed.reasoning || 'No reasoning provided'
    };
  } catch (error) {
    console.error('[LLM Matcher] Failed to parse response:', content);
    return {
      matched_index: null,
      confidence: 'none',
      reasoning: `Failed to parse LLM response: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}
