import { NextRequest, NextResponse } from 'next/server';
import { verifyReceiptFormLink } from '@/lib/receipt-form-link';
import { loadFormRow } from '@/lib/receipt-form-server';
import { readV3Status } from '@/lib/receive-v3-server';

/**
 * GET /api/receipt-form/{id}/status?exp&sig
 *
 * The receive form v3's status screen (flag receive_form_v3, 06/11): where
 * a saved form stands — {ok, erp, form_status, outcome, docno, office_lines,
 * submitted_at}, outcome ∈ pending | success | partial | timeout | failed
 * (lib/receive-v3-status.ts). Polled every 3 s after a save, and read once
 * when a done form is reopened.
 *
 * Read-only: SELECTs on receipt_forms, deliveries, tenants, users,
 * priority_push_outbox, priority_push_config (its URL never leaves the
 * server) and the client's priority_goods_receipts / delivery_po_links,
 * plus priority_push_explain for a queued row — the reads of
 * GET /api/priority-status, keyed by the form's delivery. Nothing is sent,
 * queued or written.
 *
 * The signed link is checked first (401 link_invalid), then the row
 * (404 not_found). Not gated by the flag: a page opened while it was on can
 * still finish after it is switched off.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const sp = request.nextUrl.searchParams;
    if (!verifyReceiptFormLink(id, sp.get('exp') ?? '', sp.get('sig') ?? '')) {
      return reply(401, { ok: false, error: 'link_invalid' });
    }
    const row = await loadFormRow(id);
    if (!row) return reply(404, { ok: false, error: 'not_found' });
    const status = await readV3Status(row);
    return reply(200, { ...status });
  } catch (error) {
    console.error('[api/receipt-form/status] GET error:', id, error instanceof Error ? error.message : error);
    return reply(500, { ok: false, error: 'server_error' });
  }
}
