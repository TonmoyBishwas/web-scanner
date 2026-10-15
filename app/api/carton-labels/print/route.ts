import { NextRequest, NextResponse } from 'next/server';
import { getSessionContext } from '@/lib/session-guard';
import {
  getCartonLabelsByBatches,
  getCartonLabelsByIds,
  markCartonBatchesPrinted,
  markCartonLabelsPrinted,
  LABEL_SIZES,
  type LabelScope,
  type LabelSize,
} from '@/lib/carton-labels';
import { verifyLabelsLink } from '@/lib/label-link';

const splitCsv = (v: string | null) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

const unauthorized = () =>
  NextResponse.json({ success: false, error: 'Invalid or expired session' }, { status: 401 });

/**
 * Who is asking, and which labels that lets them reach:
 *   token (a live scanner session) → that session's labels; with
 *     `scope=all` (the Labels screen's "all jobs" reprint, whose list
 *     GET /api/carton-labels?scope=all already shows) → unscoped;
 *   doc + sig (the signed pending-labels page, lib/label-link.ts) → that
 *     delivery note's labels, no session needed.
 * Null = refused.
 */
async function resolveScope(
  token: string | null,
  doc: string | null,
  sig: string | null,
  wantAll: boolean,
): Promise<LabelScope | null> {
  if (doc && sig) return verifyLabelsLink(doc, sig) ? { documentNumber: doc } : null;
  const context = await getSessionContext(token);
  if (!context || !token) return null;
  return wantAll ? {} : { sessionToken: token };
}

/**
 * GET /api/carton-labels/print?(token[&scope=all] | doc&sig)&batches|ids
 *
 * Feeds the print sheet. Selection on the Labels screen is per batch, so the
 * sheet is normally addressed by `batches` — a URL carrying 200 individual
 * label ids would blow past what some browsers accept. Scoped (2026-10-15):
 * a session's token reaches only its own batches unless the Labels screen
 * is on "all jobs"; a signed link reaches only its delivery note.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const scope = await resolveScope(
      searchParams.get('token'),
      searchParams.get('doc'),
      searchParams.get('sig'),
      searchParams.get('scope') === 'all',
    );
    if (!scope) return unauthorized();

    const batches = splitCsv(searchParams.get('batches'));
    const labels = batches.length
      ? await getCartonLabelsByBatches(batches, scope)
      : await getCartonLabelsByIds(splitCsv(searchParams.get('ids')), scope);
    return NextResponse.json({ success: true, labels });
  } catch (error) {
    console.error('[api/carton-labels/print] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load labels' }, { status: 500 });
  }
}

/**
 * POST /api/carton-labels/print
 *
 * Marks labels as sent to the printer. Two callers, named by `via`:
 *   'sheet'  — the print sheet, for exactly the labels it rendered, just
 *              before it opens the print dialog (the opener no longer marks
 *              anything: "the tab opened" is not "the labels printed");
 *   'manual' — "Mark as printed" on the Labels screen, for a sheet printed
 *              elsewhere or a tab killed before it could report.
 * The browser's print dialog never tells us whether paper came out, so this
 * records the hand-off; reprinting simply increments the print count. `via`
 * is not stored (no column for it) — it is in the request, so the scanner
 * trace and the server log carry it.
 *
 * `batch_ids` are marked by batch, `ids` by id — either way in bounded
 * slices with one UPDATE per print count (see markCartonLabelsPrinted): this
 * is what lifts the print gate, so a 500-label batch must mark in one go.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // A signed pending-labels page marks only its own delivery's labels; a
    // session token keeps the old unscoped mark (the "all jobs" reprint
    // marks labels of earlier sessions too).
    const doc = typeof body.doc === 'string' ? body.doc : null;
    const sig = typeof body.sig === 'string' ? body.sig : null;
    let scope: LabelScope | undefined;
    if (doc && sig) {
      if (!verifyLabelsLink(doc, sig)) return unauthorized();
      scope = { documentNumber: doc };
    } else {
      const context = await getSessionContext(body.token ?? null);
      if (!context) return unauthorized();
    }

    const asStrings = (v: unknown) => (Array.isArray(v) ? v.filter((i): i is string => typeof i === 'string') : []);
    const batchIds = asStrings(body.batch_ids);
    const ids = asStrings(body.ids);
    if (!batchIds.length && !ids.length) {
      return NextResponse.json({ success: false, error: 'ids or batch_ids is required' }, { status: 400 });
    }

    const labelSize: LabelSize | undefined = LABEL_SIZES.includes(body.label_size)
      ? body.label_size
      : undefined;

    const via = body.via === 'sheet' || body.via === 'manual' ? body.via : 'unknown';
    // By batch only for a session (Labels' "Mark as printed"); a signed page
    // always marks the exact ids it rendered.
    const updated = batchIds.length && !scope
      ? await markCartonBatchesPrinted(batchIds, labelSize)
      : await markCartonLabelsPrinted(ids, labelSize, scope);
    console.log(`[api/carton-labels/print] marked ${updated} printed via=${via}`);
    return NextResponse.json({ success: true, updated, via });
  } catch (error) {
    console.error('[api/carton-labels/print] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update labels' }, { status: 500 });
  }
}
