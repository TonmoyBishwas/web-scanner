/**
 * POST /api/consolidate-items
 *
 * Asks Gemini "are any of these scanned-item groups actually the same
 * physical product?" — a safety net for OCR name drift. The scanner
 * already groups by normalized Hebrew name (see `lib/group-key.ts`), so
 * this endpoint only catches near-duplicate names that survive
 * normalization: minor spelling variants, missing/extra letters,
 * different formatting of the same product.
 *
 * The endpoint NEVER auto-merges. It returns suggestions; the worker
 * confirms or dismisses in the UI (see pallet-verify/[token]/page.tsx).
 *
 * Conservative-by-default: when in doubt, DO NOT suggest a merge. False
 * positives (merging two genuinely-different products) are far worse
 * than false negatives (leaving two OCR-variant cards visible) because
 * they corrupt the Airtable Pallet Items rows downstream.
 */
import { NextRequest, NextResponse } from 'next/server';

// Same OpenRouter fallback chain the bot uses for OCR.
const MODELS = [
  'google/gemini-2.5-flash-lite',
  'google/gemini-3-flash-preview',
  'anthropic/claude-haiku-4.5',
  'x-ai/grok-4.1-fast',
];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface IncomingGroup {
  key: string;
  name_he?: string;
  name_en?: string;
  box_count: number;
  sample_weights_kg: number[];
}

interface SuggestedMerge {
  from_keys: string[];
  to_key: string;
  reason_he: string;
  reason_en: string;
}

function buildPrompt(groups: IncomingGroup[]): string {
  const listing = groups
    .map((g, i) => {
      const heb = g.name_he?.trim() || '(no Hebrew name)';
      const eng = g.name_en?.trim() || '(no English name)';
      const ws = g.sample_weights_kg.slice(0, 5).join(', ');
      return `${i + 1}. key="${g.key}" | he="${heb}" | en="${eng}" | boxes=${g.box_count} | sample_weights_kg=[${ws}]`;
    })
    .join('\n');

  return `You are inspecting the item groups currently on ONE warehouse pallet
that a worker is scanning right now. Each "group" is a set of physical
boxes the scanner has clustered together by the OCR'd Hebrew name.

Your task: identify pairs (or larger sets) of groups that are clearly
THE SAME physical product, where OCR variance produced slightly different
names. Return STRICT JSON only — no markdown, no prose, no fences:

{
  "suggested_merges": [
    {
      "from_keys": ["<key1>", "<key2>"],
      "to_key": "<the key you'd keep as canonical>",
      "reason_he": "<short Hebrew sentence>",
      "reason_en": "<short English sentence>"
    }
  ]
}

Rules — read carefully:

1. MERGE candidates (suggest a merge):
   - Same Hebrew product name with minor OCR mistakes (missing/extra
     letter, transposed letters, different whitespace, different unicode
     normalisation).
   - Same name with trivial formatting variance ("1.5 ק\"ג" vs "1.5 קג",
     "120 גרם" vs "120ג'").
   - Same item, weight samples in roughly the same range (within ~10%).

2. DO NOT MERGE:
   - Different package sizes ("120 גרם" vs "1.5 ק\"ג", "טרי" 200g vs
     "טרי" 500g). Different package sizes ARE different products.
   - Different forms / preparations ("טרי" fresh vs "קפוא" frozen,
     "מאורז" packaged vs "תפזורת" loose pack).
   - Different qualifiers that change the SKU
     ("עם רוטב" vs "ללא רוטב", "אורגני" vs not).
   - Weights in radically different ranges (e.g. one group ~12kg, another
     ~175kg — these are different products even with similar base names).
   - Anything you're not sure about. Conservative wins.

3. If no merges are warranted, return {"suggested_merges": []}. This is
   the most common correct answer.

4. Use the EXACT key strings from the input in from_keys / to_key —
   don't invent new identifiers.

Input groups (${groups.length}):
${listing}

Return the JSON now.`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { groups } = body as { groups: IncomingGroup[]; language?: string };

    if (!Array.isArray(groups) || groups.length < 2) {
      // Nothing to merge against itself.
      return NextResponse.json({ suggested_merges: [] });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.warn('[consolidate-items] OPENROUTER_API_KEY unset; skipping');
      return NextResponse.json({ suggested_merges: [] });
    }

    const prompt = buildPrompt(groups);
    const validKeys = new Set(groups.map((g) => g.key));

    for (const model of MODELS) {
      try {
        const resp = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://web-scanner.warehouse.local',
            'X-Title': 'Hebrew Warehouse Scanner',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
          }),
          // 12s budget per model — this is a background call and the worker
          // is still scanning. If every model times out, banner just won't
          // appear; Layer A grouping still works.
          signal: AbortSignal.timeout(12_000),
        });

        if (!resp.ok) {
          console.warn(`[consolidate-items] model ${model} HTTP ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        let content = (data.choices?.[0]?.message?.content ?? '').trim();
        // Models occasionally wrap JSON in ```json fences despite the prompt.
        if (content.startsWith('```')) {
          content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
        }
        const parsed = JSON.parse(content);
        const rawMerges = Array.isArray(parsed.suggested_merges) ? parsed.suggested_merges : [];

        // Sanitise: every from_key + to_key must be a real input key.
        const cleanMerges: SuggestedMerge[] = [];
        for (const m of rawMerges) {
          if (!m || !Array.isArray(m.from_keys) || typeof m.to_key !== 'string') continue;
          const fromKeys: string[] = m.from_keys.filter((k: unknown) => typeof k === 'string' && validKeys.has(k));
          if (fromKeys.length < 2) continue;          // need at least a pair
          if (!validKeys.has(m.to_key)) continue;
          if (!fromKeys.includes(m.to_key)) continue; // to_key must be one of the merged keys
          cleanMerges.push({
            from_keys: fromKeys,
            to_key: m.to_key,
            reason_he: typeof m.reason_he === 'string' ? m.reason_he : '',
            reason_en: typeof m.reason_en === 'string' ? m.reason_en : '',
          });
        }

        console.log(
          `[consolidate-items] model=${model} suggested ${cleanMerges.length} merges from ${groups.length} groups`,
        );
        return NextResponse.json({ suggested_merges: cleanMerges });
      } catch (err) {
        console.warn(`[consolidate-items] model ${model} failed:`, err);
        continue;
      }
    }

    // Every model exhausted — return empty (banner just doesn't show).
    return NextResponse.json({ suggested_merges: [] });
  } catch (err) {
    console.error('[consolidate-items] POST error:', err);
    return NextResponse.json({ suggested_merges: [] });
  }
}
