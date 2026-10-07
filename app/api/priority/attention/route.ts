import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin } from '@/lib/admin-auth';
import { groupFixLines, type GapLine } from '@/lib/priority-attention';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** More than this many open problems means something else is wrong; the page says so. */
const MAX_ROWS = 200;

/** "Lines to check in Priority": deliveries opened in the last this-many days. */
const FIX_DAYS = 7;
const MAX_FIX_LINES = 300;

/**
 * GET /api/priority/attention?u&exp&sig
 *
 * Everything not in Priority that a person should look at — the rows of our
 * read-only view priority_push_attention_v (failed, unconfirmed, no
 * write-back, held, closed but never queued, leftover deliveries by class).
 * Read-only.
 *
 * Also the lines to check in the Priority draft — delivery_gaps_v (M5, Task
 * 14b): short / over, not counted, a unit risk, an item not linked — for
 * deliveries of the last 7 days, grouped per delivery (`fixes`). M5 ships after
 * this page: until then, or on any read error, `fixes` is [] and
 * `fixes_available` is false; the problem list itself still loads.
 *
 * Access: the signed link from the bot's office alert (lib/admin-link.ts)
 * AND the chat id is an active Admin in `users` (lib/admin-auth.ts).
 * 401 = bad / expired link, 403 = not an active admin.
 *
 * Answers {success, rows, truncated, fixes, fixes_available}.
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const auth = await requireAdmin({ u: p.get('u'), exp: p.get('exp'), sig: p.get('sig') });
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers: NO_STORE });
    }

    const { data, error } = await supabase
      .from('priority_push_attention_v')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS + 1);
    if (error) throw new Error(`priority_push_attention_v read failed: ${error.message}`);

    const rows = data ?? [];

    const since = new Date(Date.now() - FIX_DAYS * 24 * 3600 * 1000).toISOString();
    const gaps = await supabase
      .from('delivery_gaps_v')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_FIX_LINES);
    if (gaps.error) console.warn('[api/priority/attention] delivery_gaps_v not readable:', gaps.error.message);
    const fixes = gaps.error ? [] : groupFixLines((gaps.data ?? []) as GapLine[]);

    return NextResponse.json(
      {
        success: true,
        rows: rows.slice(0, MAX_ROWS),
        truncated: rows.length > MAX_ROWS,
        fixes,
        fixes_available: !gaps.error,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[api/priority/attention] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read the list' },
      { status: 500, headers: NO_STORE },
    );
  }
}
