# Documents Archive (מסמכים) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unlock the מסמכים side-drawer screen: a live browser over completed delivery documents (invoice photo, parsed lines, discrepancies, pallets, Type B voice notes), replacing the locked mock.

**Architecture:** Mirrors the pallets browser exactly — a server-only aggregator (`lib/documents.ts`) merges meat `deliveries` and non-meat `non_meat_inventory` sessions into one card shape; two token-guarded API routes serve it; a `DocumentsBrowser` overlay component renders list + detail; pallet rows hand off to the existing `PalletsBrowser` via a new `initialPalletId` prop.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, `@supabase/supabase-js` (service-role, server-side only).

**Spec:** `docs/superpowers/specs/2026-08-05-documents-archive-design.md`

## Global Constraints

- Web-scanner repo only, branch `preview`. **No bot changes, no schema changes, no new dependencies.**
- All Supabase access is server-side via `lib/supabase.ts` (service-role key). Never import it in client components.
- Both API routes MUST be guarded by `isValidSessionToken(token)` from `lib/session-guard.ts`; invalid/expired → HTTP 401 `{ success: false, error: 'Invalid or expired session' }`.
- This repo has NO unit-test framework (deliberate; do not add one). Per-task verification = `npm run lint` and `npm run build` pass. End-to-end verification happens on a Vercel preview deploy against the live DB (Task 7). Local `.env.local` lacks `SUPABASE_*` vars — do NOT try to run `npm run dev` against the DB locally.
- i18n: every user-visible string goes through `useT()` with keys added to BOTH `lib/i18n/en.ts` and `lib/i18n/he.ts` (`TranslationKey` is derived from them — a key present in one but not the other breaks the build).
- UI copy/styling follows the terminal design system already used by `PalletsBrowser.tsx` and `DocsScreenLocked.tsx` (bg-raised cards, `rounded-[14px]`, chip styles, `ScreenOverlay` chrome). Hebrew-first RTL; LTR spans (`dir="ltr"`) for doc numbers and LPNs.
- `discrepancy_status` values in `delivery_items` are `'Short' | 'Over' | 'None' | NULL` — only Short/Over are discrepancies.
- Commit after every task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `lib/documents.ts` — server-only aggregator

**Files:**
- Create: `lib/documents.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase`.
- Produces (used by Task 2 routes and Task 5 component):
  - `DOCS_PAGE_SIZE: number` (= 30)
  - `type DocSource = 'meat' | 'non_meat'`
  - `type CategoryFilter = 'all' | 'meat' | 'non_meat'`
  - `interface DocumentCard { source: DocSource; id: string; document_number: string; supplier_hebrew: string; supplier_english: string; invoice_date: string | null; received_at: string; image_url: string | null; line_count: number; has_voice_note: boolean }`
  - `interface DocumentLine { name_hebrew: string; name_english: string; invoice_qty: number; unit: string; invoice_boxes: number | null; received_qty: number | null; received_boxes: number | null; discrepancy: string | null }`
  - `interface DocumentPalletRef { id: string; lpn: string; pallet_type: string; status: string; box_count: number }`
  - `interface DocumentVoiceNote { transcript: string; pallet_count: number | null; box_count: number | null; solo_count: number | null; other_notes: string | null }`
  - `interface DocumentDetail { card: DocumentCard; lines: DocumentLine[]; pallets: DocumentPalletRef[]; voice_note: DocumentVoiceNote | null }`
  - `listDocuments(params: { q?: string; category?: CategoryFilter; month?: string; page?: number }): Promise<{ documents: DocumentCard[]; months: string[]; hasMore: boolean }>`
  - `getDocumentDetail(source: DocSource, id: string): Promise<DocumentDetail | null>`

- [ ] **Step 1: Write the file**

```typescript
/**
 * Server-only data access for the מסמכים documents archive.
 *
 * A "document" is a COMPLETED delivery:
 *   - meat: one per `deliveries` row (lines in delivery_items by receipt_id,
 *     pallets by pallets.receipt_id);
 *   - non-meat: one per distinct `non_meat_inventory.session_id` (the rows ARE
 *     the lines; pallets via their pallet_id; Type B voice note via voice_note_id).
 * `invoice_ocr_results` is used ONLY as an invoice-photo fallback for old meat
 * deliveries that predate `deliveries.invoice_image_url`. Abandoned/retried OCR
 * attempts never appear as documents.
 *
 * The whole archive is ~40 documents today, so both sources are fetched per
 * request and search/category/month filtering happens here in JS; the response
 * stays paginated so the contract scales later.
 */
import { supabase } from './supabase';

export const DOCS_PAGE_SIZE = 30;

export type DocSource = 'meat' | 'non_meat';
export type CategoryFilter = 'all' | 'meat' | 'non_meat';

export interface DocumentCard {
  source: DocSource;
  /** deliveries.id (meat) or non_meat_inventory.session_id (non-meat) */
  id: string;
  document_number: string;
  supplier_hebrew: string;
  supplier_english: string;
  /** YYYY-MM-DD; meat deliveries have no invoice-date column → null */
  invoice_date: string | null;
  /** ISO timestamp used for sorting + the month filter */
  received_at: string;
  image_url: string | null;
  line_count: number;
  has_voice_note: boolean;
}

export interface DocumentLine {
  name_hebrew: string;
  name_english: string;
  /** invoice figure: kg for meat, invoice_quantity (fallback quantity) for NM */
  invoice_qty: number;
  /** 'kg' for meat lines; the NM row's unit otherwise */
  unit: string;
  invoice_boxes: number | null;
  /** actually-received figure, only set when the line has a discrepancy */
  received_qty: number | null;
  received_boxes: number | null;
  /** discrepancy note/reason (fallback: the status word); null when clean */
  discrepancy: string | null;
}

export interface DocumentPalletRef {
  id: string;
  lpn: string;
  pallet_type: string;
  status: string;
  box_count: number;
}

export interface DocumentVoiceNote {
  transcript: string;
  pallet_count: number | null;
  box_count: number | null;
  solo_count: number | null;
  other_notes: string | null;
}

export interface DocumentDetail {
  card: DocumentCard;
  lines: DocumentLine[];
  pallets: DocumentPalletRef[];
  voice_note: DocumentVoiceNote | null;
}

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

/** Card + pre-computed lowercase haystack for text search. */
interface DocEntry {
  card: DocumentCard;
  searchText: string;
}

interface DeliveryRow {
  id: string;
  document_number: string | null;
  supplier_hebrew: string | null;
  supplier_english: string | null;
  invoice_image_url: string | null;
  created_at: string;
}

const DELIVERY_COLUMNS =
  'id, document_number, supplier_hebrew, supplier_english, invoice_image_url, created_at';

function buildMeatCard(
  d: DeliveryRow,
  lineNames: { he: string; en: string }[],
  ocrFallbackImage: string | null
): DocEntry {
  const card: DocumentCard = {
    source: 'meat',
    id: d.id,
    document_number: d.document_number ?? '',
    supplier_hebrew: d.supplier_hebrew ?? '',
    supplier_english: d.supplier_english ?? '',
    invoice_date: null,
    received_at: d.created_at,
    image_url: d.invoice_image_url ?? ocrFallbackImage,
    line_count: lineNames.length,
    has_voice_note: false,
  };
  const searchText = [
    card.document_number,
    card.supplier_hebrew,
    card.supplier_english,
    ...lineNames.flatMap(l => [l.he, l.en]),
  ]
    .join(' ')
    .toLowerCase();
  return { card, searchText };
}

async function fetchMeatEntries(): Promise<DocEntry[]> {
  const [deliveriesRes, itemsRes, ocrRes] = await Promise.all([
    supabase.from('deliveries').select(DELIVERY_COLUMNS),
    supabase.from('delivery_items').select('receipt_id, item_name_hebrew, item_name_english'),
    supabase
      .from('invoice_ocr_results')
      .select('delivery_id, invoice_image_url')
      .not('delivery_id', 'is', null)
      .not('invoice_image_url', 'is', null),
  ]);
  if (deliveriesRes.error) fail('deliveries read', deliveriesRes.error.message);
  if (itemsRes.error) fail('delivery_items read', itemsRes.error.message);
  if (ocrRes.error) fail('invoice_ocr_results read', ocrRes.error.message);

  const linesByDelivery = new Map<string, { he: string; en: string }[]>();
  for (const row of itemsRes.data ?? []) {
    if (!row.receipt_id) continue;
    const list = linesByDelivery.get(row.receipt_id) ?? [];
    list.push({ he: row.item_name_hebrew ?? '', en: row.item_name_english ?? '' });
    linesByDelivery.set(row.receipt_id, list);
  }

  const ocrImageByDelivery = new Map<string, string>();
  for (const row of ocrRes.data ?? []) {
    if (row.delivery_id && row.invoice_image_url && !ocrImageByDelivery.has(row.delivery_id)) {
      ocrImageByDelivery.set(row.delivery_id, row.invoice_image_url);
    }
  }

  return ((deliveriesRes.data ?? []) as DeliveryRow[]).map(d =>
    buildMeatCard(d, linesByDelivery.get(d.id) ?? [], ocrImageByDelivery.get(d.id) ?? null)
  );
}

interface NonMeatRow {
  session_id: string | null;
  supplier_hebrew: string | null;
  supplier_english: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_image_url: string | null;
  item_name_hebrew: string | null;
  item_name_english: string | null;
  quantity: number | null;
  invoice_quantity: number | null;
  unit: string | null;
  has_discrepancy: boolean | null;
  discrepancy_reason: string | null;
  pallet_id: string | null;
  voice_note_id: string | null;
  created_at: string;
}

const NM_COLUMNS =
  'session_id, supplier_hebrew, supplier_english, invoice_number, invoice_date, invoice_image_url, ' +
  'item_name_hebrew, item_name_english, quantity, invoice_quantity, unit, has_discrepancy, ' +
  'discrepancy_reason, pallet_id, voice_note_id, created_at';

async function fetchNonMeatRows(sessionId?: string): Promise<NonMeatRow[]> {
  let query = supabase.from('non_meat_inventory').select(NM_COLUMNS);
  if (sessionId) query = query.eq('session_id', sessionId);
  const { data, error } = await query;
  if (error) fail('non_meat_inventory read', error.message);
  return (data ?? []) as NonMeatRow[];
}

function buildNonMeatEntry(sessionId: string, rows: NonMeatRow[]): DocEntry {
  const first = rows[0];
  const receivedAt = rows.map(r => r.created_at).sort()[0];
  const card: DocumentCard = {
    source: 'non_meat',
    id: sessionId,
    document_number: first.invoice_number ?? '',
    supplier_hebrew: first.supplier_hebrew ?? '',
    supplier_english: first.supplier_english ?? '',
    invoice_date: first.invoice_date,
    received_at: receivedAt,
    image_url: rows.map(r => r.invoice_image_url).find(Boolean) ?? null,
    line_count: rows.length,
    has_voice_note: rows.some(r => r.voice_note_id !== null),
  };
  const searchText = [
    card.document_number,
    card.supplier_hebrew,
    card.supplier_english,
    ...rows.flatMap(r => [r.item_name_hebrew ?? '', r.item_name_english ?? '']),
  ]
    .join(' ')
    .toLowerCase();
  return { card, searchText };
}

async function fetchNonMeatEntries(): Promise<DocEntry[]> {
  const rows = await fetchNonMeatRows();
  const bySession = new Map<string, NonMeatRow[]>();
  for (const row of rows) {
    if (!row.session_id) continue;
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }
  return [...bySession.entries()].map(([sid, sessionRows]) => buildNonMeatEntry(sid, sessionRows));
}

export async function listDocuments(params: {
  q?: string;
  category?: CategoryFilter;
  month?: string;
  page?: number;
}): Promise<{ documents: DocumentCard[]; months: string[]; hasMore: boolean }> {
  const [meat, nonMeat] = await Promise.all([fetchMeatEntries(), fetchNonMeatEntries()]);
  const all = [...meat, ...nonMeat].sort((a, b) =>
    b.card.received_at.localeCompare(a.card.received_at)
  );

  // Month picker options come from the FULL archive (already newest-first).
  const months = [...new Set(all.map(e => e.card.received_at.slice(0, 7)))];

  let entries = all;
  const category = params.category ?? 'all';
  if (category !== 'all') entries = entries.filter(e => e.card.source === category);
  if (params.month) entries = entries.filter(e => e.card.received_at.slice(0, 7) === params.month);
  const q = (params.q ?? '').trim().toLowerCase();
  if (q) entries = entries.filter(e => e.searchText.includes(q));

  const page = Math.max(params.page ?? 0, 0);
  const start = page * DOCS_PAGE_SIZE;
  return {
    documents: entries.slice(start, start + DOCS_PAGE_SIZE).map(e => e.card),
    months,
    hasMore: start + DOCS_PAGE_SIZE < entries.length,
  };
}

const PALLET_REF_COLUMNS = 'id, lpn, pallet_type, status, box_count';

interface PalletRefRow {
  id: string;
  lpn: string;
  pallet_type: string | null;
  status: string | null;
  box_count: number | null;
}

function toPalletRef(p: PalletRefRow): DocumentPalletRef {
  return {
    id: p.id,
    lpn: p.lpn,
    pallet_type: p.pallet_type ?? 'Single',
    status: p.status ?? '',
    box_count: p.box_count ?? 0,
  };
}

async function getMeatDetail(id: string): Promise<DocumentDetail | null> {
  const { data: delivery, error } = await supabase
    .from('deliveries')
    .select(DELIVERY_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) fail('deliveries read', error.message);
  if (!delivery) return null;

  const [itemsRes, palletsRes, ocrRes] = await Promise.all([
    supabase
      .from('delivery_items')
      .select(
        'item_name_hebrew, item_name_english, invoice_qty_kg, invoice_box_count, received_qty_kg, received_box_count, discrepancy_status, discrepancy_note'
      )
      .eq('receipt_id', id),
    supabase.from('pallets').select(PALLET_REF_COLUMNS).eq('receipt_id', id),
    supabase
      .from('invoice_ocr_results')
      .select('invoice_image_url')
      .eq('delivery_id', id)
      .not('invoice_image_url', 'is', null)
      .limit(1),
  ]);
  if (itemsRes.error) fail('delivery_items read', itemsRes.error.message);
  if (palletsRes.error) fail('pallets read', palletsRes.error.message);
  if (ocrRes.error) fail('invoice_ocr_results read', ocrRes.error.message);

  const lines: DocumentLine[] = (itemsRes.data ?? []).map(r => {
    const flagged = r.discrepancy_status === 'Short' || r.discrepancy_status === 'Over';
    return {
      name_hebrew: r.item_name_hebrew ?? '',
      name_english: r.item_name_english ?? '',
      invoice_qty: r.invoice_qty_kg ?? 0,
      unit: 'kg',
      invoice_boxes: r.invoice_box_count,
      received_qty: flagged ? r.received_qty_kg : null,
      received_boxes: flagged ? r.received_box_count : null,
      discrepancy: flagged ? r.discrepancy_note || r.discrepancy_status : null,
    };
  });

  const { card } = buildMeatCard(
    delivery as DeliveryRow,
    lines.map(l => ({ he: l.name_hebrew, en: l.name_english })),
    ocrRes.data?.[0]?.invoice_image_url ?? null
  );

  return {
    card,
    lines,
    pallets: ((palletsRes.data ?? []) as PalletRefRow[]).map(toPalletRef),
    voice_note: null,
  };
}

async function getNonMeatDetail(sessionId: string): Promise<DocumentDetail | null> {
  const rows = await fetchNonMeatRows(sessionId);
  if (rows.length === 0) return null;

  const { card } = buildNonMeatEntry(sessionId, rows);

  const palletIds = [...new Set(rows.map(r => r.pallet_id).filter(Boolean))] as string[];
  let pallets: DocumentPalletRef[] = [];
  if (palletIds.length > 0) {
    const { data, error } = await supabase
      .from('pallets')
      .select(PALLET_REF_COLUMNS)
      .in('id', palletIds);
    if (error) fail('pallets read', error.message);
    pallets = ((data ?? []) as PalletRefRow[]).map(toPalletRef);
  }

  const lines: DocumentLine[] = rows.map(r => ({
    name_hebrew: r.item_name_hebrew ?? '',
    name_english: r.item_name_english ?? '',
    invoice_qty: r.invoice_quantity ?? r.quantity ?? 0,
    unit: r.unit ?? '',
    invoice_boxes: null,
    received_qty: r.has_discrepancy ? r.quantity : null,
    received_boxes: null,
    discrepancy: r.has_discrepancy ? r.discrepancy_reason || 'discrepancy' : null,
  }));

  let voice_note: DocumentVoiceNote | null = null;
  const voiceId = rows.map(r => r.voice_note_id).find(Boolean);
  if (voiceId) {
    const { data, error } = await supabase
      .from('nonmeat_delivery_notes')
      .select('raw_transcript, pallet_count, box_count, solo_count, other_notes')
      .eq('id', voiceId)
      .maybeSingle();
    if (error) fail('nonmeat_delivery_notes read', error.message);
    if (data) {
      voice_note = {
        transcript: data.raw_transcript ?? '',
        pallet_count: data.pallet_count,
        box_count: data.box_count,
        solo_count: data.solo_count,
        other_notes: data.other_notes,
      };
    }
  }

  return { card, lines, pallets, voice_note };
}

export async function getDocumentDetail(
  source: DocSource,
  id: string
): Promise<DocumentDetail | null> {
  return source === 'meat' ? getMeatDetail(id) : getNonMeatDetail(id);
}
```

- [ ] **Step 2: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: both succeed (the file compiles standalone; nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add lib/documents.ts
git commit -m "feat: documents archive server aggregator (lib/documents.ts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: API routes — `/api/documents` + `/api/documents/detail`

**Files:**
- Create: `app/api/documents/route.ts`
- Create: `app/api/documents/detail/route.ts`

**Interfaces:**
- Consumes: `listDocuments`, `getDocumentDetail`, `CategoryFilter`, `DocSource` from `@/lib/documents` (Task 1); `isValidSessionToken` from `@/lib/session-guard`.
- Produces (consumed by Task 5 component):
  - `GET /api/documents?token&q&category&month&page` → `{ success: true, documents: DocumentCard[], months: string[], hasMore: boolean }`; 401 `{ success: false, error }` on bad token; 500 on failure.
  - `GET /api/documents/detail?token&source&id` → `{ success: true, ...DocumentDetail }` (i.e. `card`, `lines`, `pallets`, `voice_note` at the top level); 400 on bad `source`/missing `id`; 404 `{ success: false, error: 'Document not found' }`; 401/500 as above.

- [ ] **Step 1: Write `app/api/documents/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { isValidSessionToken } from '@/lib/session-guard';
import { listDocuments, type CategoryFilter } from '@/lib/documents';

const CATEGORY_VALUES: CategoryFilter[] = ['all', 'meat', 'non_meat'];

/**
 * GET /api/documents?token&q&category&month&page
 *
 * Documents-archive list (completed deliveries only). Requires a live
 * scan-session token. `q` matches document number / supplier / item names;
 * `category` = all|meat|non_meat; `month` = YYYY-MM.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const token = searchParams.get('token');

    if (!(await isValidSessionToken(token))) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired session' },
        { status: 401 }
      );
    }

    const rawCategory = searchParams.get('category') as CategoryFilter | null;
    const category =
      rawCategory && CATEGORY_VALUES.includes(rawCategory) ? rawCategory : 'all';
    const rawMonth = searchParams.get('month') ?? '';
    const month = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : undefined;
    const page = Math.max(parseInt(searchParams.get('page') ?? '0', 10) || 0, 0);
    const q = searchParams.get('q') ?? '';

    const result = await listDocuments({ q, category, month, page });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[api/documents] error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load documents' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Write `app/api/documents/detail/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { isValidSessionToken } from '@/lib/session-guard';
import { getDocumentDetail, type DocSource } from '@/lib/documents';

/**
 * GET /api/documents/detail?token&source&id
 *
 * Full document view: card + invoice lines (with discrepancies) + pallets
 * created + Type B voice note. `source` = meat|non_meat; `id` = delivery uuid
 * (meat) or non_meat_inventory.session_id (non-meat).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const token = searchParams.get('token');

    if (!(await isValidSessionToken(token))) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired session' },
        { status: 401 }
      );
    }

    const source = searchParams.get('source') as DocSource | null;
    const id = searchParams.get('id');
    if ((source !== 'meat' && source !== 'non_meat') || !id) {
      return NextResponse.json(
        { success: false, error: 'source and id are required' },
        { status: 400 }
      );
    }

    const detail = await getDocumentDetail(source, id);
    if (!detail) {
      return NextResponse.json(
        { success: false, error: 'Document not found' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, ...detail });
  } catch (error) {
    console.error('[api/documents/detail] error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load document' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: both succeed; build output lists `/api/documents` and `/api/documents/detail` as routes.

- [ ] **Step 4: Commit**

```bash
git add app/api/documents
git commit -m "feat: documents archive API routes (list + detail, token-guarded)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: i18n keys (additions only)

**Files:**
- Modify: `lib/i18n/en.ts` (docs block is around lines 616–623)
- Modify: `lib/i18n/he.ts` (docs block is around lines 620–627)

**Interfaces:**
- Produces: the `terminal.docs*` keys below, consumed by Task 5. Existing keys `terminal.docsTitle`, `terminal.docsSearch`, `terminal.docsAll`, `terminal.docsLines` are KEPT and reused. Do NOT remove any key in this task (`DocsScreenLocked` still uses the old ones until Task 6).

- [ ] **Step 1: Add to `lib/i18n/en.ts`, directly after the existing `'terminal.docsLines'` line**

```typescript
  'terminal.docsMeat': 'Meat',
  'terminal.docsNonMeat': 'Non-meat',
  'terminal.docsLoading': 'Loading…',
  'terminal.docsError': 'Failed to load documents',
  'terminal.docsSessionExpired': 'Session expired — open a fresh scanner link',
  'terminal.docsEmpty': 'No documents found',
  'terminal.docsLoadMore': 'Load more',
  'terminal.docsMonthAll': 'All months',
  'terminal.docsDetailTitle': 'Document',
  'terminal.docsInvoiceDate': 'Invoice date',
  'terminal.docsReceived': 'Received',
  'terminal.docsItemsHeader': 'Invoice lines',
  'terminal.docsPalletsHeader': 'Pallets created',
  'terminal.docsVoiceHeader': 'Delivery voice note',
  'terminal.docsGap': 'Discrepancy',
  'terminal.docsInvoiceQty': 'Invoice: {qty}',
  'terminal.docsReceivedQty': 'Received: {qty}',
  'terminal.docsBoxes': '{count} boxes',
  'terminal.docsOpenImage': 'Open full size',
  'terminal.docsVoiceCounts': 'Pallets: {pallets} · Boxes: {boxes} · Solo: {solo}',
```

- [ ] **Step 2: Add to `lib/i18n/he.ts`, directly after the existing `'terminal.docsLines'` line**

```typescript
  'terminal.docsMeat': 'בשר',
  'terminal.docsNonMeat': 'לא-בשר',
  'terminal.docsLoading': 'טוען…',
  'terminal.docsError': 'שגיאה בטעינת המסמכים',
  'terminal.docsSessionExpired': 'פג תוקף החיבור — פתחו קישור סריקה חדש',
  'terminal.docsEmpty': 'לא נמצאו מסמכים',
  'terminal.docsLoadMore': 'טען עוד',
  'terminal.docsMonthAll': 'כל החודשים',
  'terminal.docsDetailTitle': 'מסמך',
  'terminal.docsInvoiceDate': 'תאריך חשבונית',
  'terminal.docsReceived': 'התקבל',
  'terminal.docsItemsHeader': 'שורות החשבונית',
  'terminal.docsPalletsHeader': 'משטחים שנוצרו',
  'terminal.docsVoiceHeader': 'הקלטת משלוח',
  'terminal.docsGap': 'פער',
  'terminal.docsInvoiceQty': 'חשבונית: {qty}',
  'terminal.docsReceivedQty': 'התקבל: {qty}',
  'terminal.docsBoxes': '{count} קרטונים',
  'terminal.docsOpenImage': 'פתח בגודל מלא',
  'terminal.docsVoiceCounts': 'משטחים: {pallets} · קרטונים: {boxes} · בודדים: {solo}',
```

- [ ] **Step 3: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: both succeed (keys exist in both files → `TranslationKey` stays consistent).

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/en.ts lib/i18n/he.ts
git commit -m "feat: i18n keys for the documents archive

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `PalletsBrowser` — optional `initialPalletId` prop

**Files:**
- Modify: `components/terminal/PalletsBrowser.tsx` (props interface ~line 97, component body ~line 102)

**Interfaces:**
- Produces: `PalletsBrowser` accepts optional `initialPalletId?: string`. When set, the browser opens straight into that pallet's detail on mount (list still loads behind it; closing the detail reveals the list as usual). Existing call sites (3 pages) are untouched — the prop is optional.

- [ ] **Step 1: Extend the props interface**

Change:

```typescript
interface PalletsBrowserProps {
  token: string;
  onBack: () => void;
}

export function PalletsBrowser({ token, onBack }: PalletsBrowserProps) {
```

to:

```typescript
interface PalletsBrowserProps {
  token: string;
  onBack: () => void;
  /** Open straight into this pallet's detail (documents-archive hand-off). */
  initialPalletId?: string;
}

export function PalletsBrowser({ token, onBack, initialPalletId }: PalletsBrowserProps) {
```

- [ ] **Step 2: Open the detail once on mount**

Directly after the existing `useEffect(() => { fetchPage(0, false); }, [fetchPage]);` (~line 167), add:

```typescript
  // Documents-archive hand-off: open straight into a pallet's detail.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (initialPalletId && !openedInitial.current) {
      openedInitial.current = true;
      openDetail(initialPalletId);
    }
  }, [initialPalletId, openDetail]);
```

(`useRef` is already imported in this file.)

- [ ] **Step 3: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add components/terminal/PalletsBrowser.tsx
git commit -m "feat: PalletsBrowser initialPalletId prop for direct detail open

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `DocumentsBrowser` component

**Files:**
- Create: `components/terminal/DocumentsBrowser.tsx`

**Interfaces:**
- Consumes: `GET /api/documents` and `GET /api/documents/detail` (Task 2 shapes), `PalletsBrowser` with `initialPalletId` (Task 4), i18n keys (Task 3), `ScreenOverlay`, `MI`, `Toast`/`useToast`.
- Produces: `export function DocumentsBrowser({ token, onBack }: { token: string; onBack: () => void })` — consumed by Task 6's `DrawerHost`.

- [ ] **Step 1: Write the component**

```tsx
'use client';

/**
 * מסמכים — documents archive (completed deliveries).
 *
 * Full-screen overlay opened from the side drawer: paged document list with
 * category chips (All/Meat/Non-meat), text search over doc number / supplier /
 * item names, a month picker, and a read-only detail view (invoice photo,
 * lines with discrepancy flags, pallets created, Type B voice note).
 *
 * Data comes from GET /api/documents and /api/documents/detail, both guarded
 * by the page's live session token. Pallet rows hand off to PalletsBrowser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { Toast, useToast } from './Toast';
import { PalletsBrowser } from './PalletsBrowser';
import { useT } from '@/lib/i18n';

interface DocumentCard {
  source: 'meat' | 'non_meat';
  id: string;
  document_number: string;
  supplier_hebrew: string;
  supplier_english: string;
  invoice_date: string | null;
  received_at: string;
  image_url: string | null;
  line_count: number;
  has_voice_note: boolean;
}

interface DocumentLine {
  name_hebrew: string;
  name_english: string;
  invoice_qty: number;
  unit: string;
  invoice_boxes: number | null;
  received_qty: number | null;
  received_boxes: number | null;
  discrepancy: string | null;
}

interface DocumentPalletRef {
  id: string;
  lpn: string;
  pallet_type: string;
  status: string;
  box_count: number;
}

interface DocumentVoiceNote {
  transcript: string;
  pallet_count: number | null;
  box_count: number | null;
  solo_count: number | null;
  other_notes: string | null;
}

interface DocumentDetail {
  card: DocumentCard;
  lines: DocumentLine[];
  pallets: DocumentPalletRef[];
  voice_note: DocumentVoiceNote | null;
}

type CategoryFilter = 'all' | 'meat' | 'non_meat';

const FILTERS: { id: CategoryFilter; key: string }[] = [
  { id: 'all', key: 'terminal.docsAll' },
  { id: 'meat', key: 'terminal.docsMeat' },
  { id: 'non_meat', key: 'terminal.docsNonMeat' },
];

const BADGE_STYLE: Record<'meat' | 'non_meat', { bg: string; color: string; key: string }> = {
  meat: { bg: 'rgba(19,164,236,.18)', color: '#7cc9f2', key: 'terminal.docsMeat' },
  non_meat: { bg: 'rgba(34,197,94,.16)', color: '#86efac', key: 'terminal.docsNonMeat' },
};

// Cream mini invoice thumbnail (46×58) — fallback when no photo exists.
// (Moved from the deleted DocsScreenLocked mock.)
function DocThumb() {
  return (
    <div className="flex-none w-[46px] h-[58px] rounded-[6px] bg-paper shadow-[0_3px_8px_rgba(0,0,0,.4)] relative overflow-hidden">
      <div className="absolute top-[6px] left-[5px] w-5 h-1 bg-[#b8b0a0] rounded-[1px]" />
      <div className="absolute top-[15px] left-[5px] right-[14px] h-[3px] bg-paper-line" />
      <div className="absolute top-[22px] left-[5px] right-[9px] h-[3px] bg-paper-line" />
      <div className="absolute top-[29px] left-[5px] right-[18px] h-[3px] bg-paper-line" />
      <div
        className="absolute bottom-[6px] left-[5px] right-[5px] h-[9px]"
        style={{ background: 'repeating-linear-gradient(90deg,#111 0 1.5px,transparent 1.5px 3px)' }}
      />
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** 'YYYY-MM' → 'MM/YYYY' for the month-picker rows. */
function formatMonth(ym: string): string {
  return `${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
}

function formatQty(qty: number, unit: string): string {
  const n = (Math.round(qty * 10) / 10).toLocaleString();
  return unit ? `${n} ${unit}` : n;
}

interface DocumentsBrowserProps {
  token: string;
  onBack: () => void;
}

export function DocumentsBrowser({ token, onBack }: DocumentsBrowserProps) {
  const tr = useT();
  const { toast, showToast } = useToast();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [month, setMonth] = useState<string | null>(null);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [documents, setDocuments] = useState<DocumentCard[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<'terminal.docsError' | 'terminal.docsSessionExpired' | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [palletId, setPalletId] = useState<string | null>(null);

  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      const seq = ++requestSeq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({ token, category, page: String(pageNum) });
        if (debouncedQuery) params.set('q', debouncedQuery);
        if (month) params.set('month', month);
        const res = await fetch(`/api/documents?${params}`);
        if (seq !== requestSeq.current) return;
        if (res.status === 401) {
          setErrorKey('terminal.docsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'load failed');
        setErrorKey(null);
        setDocuments(prev => (append ? [...prev, ...data.documents] : data.documents));
        setMonths(data.months);
        setHasMore(Boolean(data.hasMore));
        setPage(pageNum);
      } catch {
        if (seq === requestSeq.current) setErrorKey('terminal.docsError');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [token, category, month, debouncedQuery]
  );

  useEffect(() => {
    fetchPage(0, false);
  }, [fetchPage]);

  const openDetail = useCallback(
    async (card: DocumentCard) => {
      setDetailLoading(true);
      try {
        const params = new URLSearchParams({ token, source: card.source, id: card.id });
        const res = await fetch(`/api/documents/detail?${params}`);
        if (res.status === 401) {
          setErrorKey('terminal.docsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'load failed');
        setDetail({ card: data.card, lines: data.lines, pallets: data.pallets, voice_note: data.voice_note });
      } catch {
        showToast(tr('terminal.docsError'), 'error', '#ef8a8a');
      } finally {
        setDetailLoading(false);
      }
    },
    [token, showToast, tr]
  );

  const categoryBadge = (source: 'meat' | 'non_meat') => {
    const style = BADGE_STYLE[source];
    return (
      <span
        className="px-2 py-[2px] rounded-full text-[9px] font-extrabold"
        style={{ background: style.bg, color: style.color }}
      >
        {tr(style.key as Parameters<typeof tr>[0])}
      </span>
    );
  };

  return (
    <ScreenOverlay title={tr('terminal.docsTitle')} onBack={onBack}>
      {/* Search + month + category chips */}
      <div className="flex-none px-3 pt-3 pb-[10px] border-b border-[#101821] bg-header flex flex-col gap-[9px]">
        <div className="flex gap-2 items-center">
          <div className="flex-1 flex items-center gap-2 bg-search-bg border border-search-border rounded-[11px] px-3 h-[42px]">
            <MI name="search" size={19} className="text-search-ink" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={tr('terminal.docsSearch')}
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] font-bold text-ink-inverse placeholder:text-search-ink"
            />
            {query && (
              <button onClick={() => setQuery('')} className="flex text-search-ink" aria-label="clear">
                <MI name="close" size={17} />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowMonthPicker(true)}
            className="w-[42px] h-[42px] rounded-[11px] border flex items-center justify-center"
            style={
              month
                ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
            }
            aria-label="month"
          >
            <MI name="calendar_month" size={20} />
          </button>
        </div>
        <div className="flex gap-[7px] overflow-x-auto no-scrollbar">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setCategory(f.id)}
              className="flex-none px-3 py-[6px] rounded-full text-[11px] font-extrabold border"
              style={
                category === f.id
                  ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                  : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
              }
            >
              {tr(f.key as Parameters<typeof tr>[0])}
            </button>
          ))}
          {month && (
            <button
              onClick={() => setMonth(null)}
              className="flex-none px-3 py-[6px] rounded-full text-[11px] font-extrabold border flex items-center gap-1"
              style={{ background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }}
            >
              {formatMonth(month)}
              <MI name="close" size={13} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-[10px]">
        {errorKey ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <MI name={errorKey === 'terminal.docsSessionExpired' ? 'schedule' : 'error'} size={34} className="text-ink-muted" />
            <div className="text-[13px] font-bold text-ink-muted">{tr(errorKey)}</div>
            {errorKey === 'terminal.docsError' && (
              <button
                onClick={() => fetchPage(0, false)}
                className="px-4 py-2 rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse"
              >
                {tr('terminal.docsLoadMore')}
              </button>
            )}
          </div>
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-[13px] font-bold text-ink-muted">
            {tr('terminal.docsLoading')}
          </div>
        ) : documents.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <MI name="description" size={34} className="text-ink-muted" />
            <div className="text-[13px] font-bold text-ink-muted">{tr('terminal.docsEmpty')}</div>
          </div>
        ) : (
          <>
            {documents.map(card => (
              <button
                key={`${card.source}:${card.id}`}
                onClick={() => openDetail(card)}
                className="flex items-center gap-3 bg-raised border border-line rounded-[14px] p-[11px] text-start"
              >
                {card.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={card.image_url}
                    alt=""
                    className="flex-none w-[46px] h-[58px] rounded-[6px] object-cover bg-tile"
                  />
                ) : (
                  <DocThumb />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[6px] mb-[3px] flex-wrap">
                    {categoryBadge(card.source)}
                    {card.document_number && (
                      <span className="font-mono text-[10px] font-semibold text-[#cbd5e1]" dir="ltr">
                        {card.document_number}
                      </span>
                    )}
                    {card.has_voice_note && <MI name="mic" size={13} className="text-[#7cc9f2]" />}
                  </div>
                  <div className="text-[14px] font-extrabold text-[#e8eef2] whitespace-nowrap overflow-hidden text-ellipsis">
                    {card.supplier_hebrew || card.supplier_english || card.document_number}
                  </div>
                  <div className="flex items-center gap-2 mt-[3px] flex-wrap">
                    <span className="text-[11px] font-semibold text-[#e8eef2]">{formatDate(card.received_at)}</span>
                    <span className="text-[11px] font-semibold text-[#e8eef2]">
                      · {tr('terminal.docsLines', { count: card.line_count })}
                    </span>
                  </div>
                </div>
                <MI name="chevron_left" size={20} className="flex-none text-[#cbd5e1]" />
              </button>
            ))}
            {hasMore && (
              <button
                onClick={() => fetchPage(page + 1, true)}
                disabled={loadingMore}
                className="mt-1 mb-2 px-4 py-[10px] rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse disabled:opacity-50"
              >
                {loadingMore ? tr('terminal.docsLoading') : tr('terminal.docsLoadMore')}
              </button>
            )}
          </>
        )}
      </div>

      {/* Month picker */}
      {showMonthPicker && (
        <div
          className="absolute inset-0 z-20 bg-black/60 flex items-end"
          onClick={() => setShowMonthPicker(false)}
        >
          <div
            className="w-full max-h-[60%] overflow-y-auto bg-canvas border-t border-line rounded-t-[16px] p-3 flex flex-col gap-2"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setMonth(null);
                setShowMonthPicker(false);
              }}
              className="px-4 py-[11px] rounded-[11px] border text-[13px] font-extrabold text-start"
              style={
                month === null
                  ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                  : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
              }
            >
              {tr('terminal.docsMonthAll')}
            </button>
            {months.map(m => (
              <button
                key={m}
                onClick={() => {
                  setMonth(m);
                  setShowMonthPicker(false);
                }}
                className="px-4 py-[11px] rounded-[11px] border text-[13px] font-extrabold text-start"
                style={
                  month === m
                    ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                    : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
                }
                dir="ltr"
              >
                {formatMonth(m)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Detail overlay */}
      {(detail || detailLoading) && (
        <div className="absolute inset-0 z-30 bg-canvas flex flex-col">
          <div className="h-14 flex-none flex items-center gap-2 px-2 border-b border-[#101821] bg-header">
            <button onClick={() => setDetail(null)} className="p-2 flex text-[#e8eef2]" aria-label="back">
              <MI name="arrow_forward_ios" size={22} />
            </button>
            <h2 className="flex-1 text-[15px] font-extrabold text-ink-inverse m-0">
              {tr('terminal.docsDetailTitle')}
            </h2>
          </div>
          {detailLoading || !detail ? (
            <div className="flex-1 flex items-center justify-center text-[13px] font-bold text-ink-muted">
              {tr('terminal.docsLoading')}
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
              {/* Header card */}
              <div className="bg-raised border border-line rounded-[14px] p-[13px] flex flex-col gap-[6px]">
                <div className="flex items-center gap-[6px] flex-wrap">
                  {categoryBadge(detail.card.source)}
                  {detail.card.document_number && (
                    <span className="font-mono text-[12px] font-semibold text-[#cbd5e1]" dir="ltr">
                      {detail.card.document_number}
                    </span>
                  )}
                </div>
                <div className="text-[16px] font-extrabold text-ink-inverse">
                  {detail.card.supplier_hebrew || detail.card.supplier_english}
                </div>
                <div className="flex flex-col gap-[2px] text-[12px] font-semibold text-ink-muted">
                  {detail.card.invoice_date && (
                    <span>
                      {tr('terminal.docsInvoiceDate')}: {formatDate(detail.card.invoice_date)}
                    </span>
                  )}
                  <span>
                    {tr('terminal.docsReceived')}: {formatDate(detail.card.received_at)}
                  </span>
                </div>
              </div>

              {/* Invoice photo */}
              {detail.card.image_url && (
                <button
                  onClick={() => window.open(detail.card.image_url as string, '_blank')}
                  className="relative bg-raised border border-line rounded-[14px] overflow-hidden"
                  aria-label={tr('terminal.docsOpenImage')}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={detail.card.image_url} alt="" className="w-full max-h-[320px] object-contain bg-black/30" />
                  <span className="absolute bottom-2 end-2 flex items-center gap-1 px-2 py-[3px] rounded-full bg-black/60 text-[10px] font-extrabold text-white">
                    <MI name="open_in_new" size={13} />
                    {tr('terminal.docsOpenImage')}
                  </span>
                </button>
              )}

              {/* Lines */}
              <div className="text-[12px] font-extrabold text-ink-muted px-1">{tr('terminal.docsItemsHeader')}</div>
              {detail.lines.map((line, i) => (
                <div key={i} className="bg-raised border border-line rounded-[14px] p-[12px] flex flex-col gap-[4px]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[14px] font-extrabold text-[#e8eef2]">
                      {line.name_hebrew || line.name_english}
                    </span>
                    {line.discrepancy && (
                      <span
                        className="px-2 py-[2px] rounded-full text-[9px] font-extrabold"
                        style={{ background: 'rgba(245,158,11,.18)', color: '#fbbf5c' }}
                      >
                        {tr('terminal.docsGap')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold text-ink-muted">
                    <span className="font-bold text-[#e8eef2]">
                      {tr('terminal.docsInvoiceQty', { qty: formatQty(line.invoice_qty, line.unit) })}
                    </span>
                    {line.invoice_boxes !== null && line.invoice_boxes > 0 && (
                      <span>· {tr('terminal.docsBoxes', { count: line.invoice_boxes })}</span>
                    )}
                  </div>
                  {line.discrepancy && (
                    <div className="flex flex-col gap-[2px] text-[11px] font-semibold" style={{ color: '#fbbf5c' }}>
                      {line.received_qty !== null && (
                        <span>
                          {tr('terminal.docsReceivedQty', { qty: formatQty(line.received_qty, line.unit) })}
                          {line.received_boxes !== null && line.received_boxes > 0 &&
                            ` · ${tr('terminal.docsBoxes', { count: line.received_boxes })}`}
                        </span>
                      )}
                      <span>{line.discrepancy}</span>
                    </div>
                  )}
                </div>
              ))}

              {/* Pallets created */}
              {detail.pallets.length > 0 && (
                <>
                  <div className="text-[12px] font-extrabold text-ink-muted px-1">
                    {tr('terminal.docsPalletsHeader')}
                  </div>
                  {detail.pallets.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setPalletId(p.id)}
                      className="flex items-center gap-3 bg-raised border border-line rounded-[14px] p-[12px] text-start"
                    >
                      <MI name="pallet" size={20} className="flex-none text-[#7cc9f2]" />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[12px] font-bold text-ink-inverse" dir="ltr">
                          {p.lpn}
                        </div>
                        <div className="text-[11px] font-semibold text-ink-muted">
                          {p.pallet_type}
                          {p.box_count > 0 && ` · ${tr('terminal.docsBoxes', { count: p.box_count })}`}
                        </div>
                      </div>
                      <MI name="chevron_left" size={20} className="flex-none text-[#cbd5e1]" />
                    </button>
                  ))}
                </>
              )}

              {/* Voice note (Type B non-meat) */}
              {detail.voice_note && (
                <>
                  <div className="text-[12px] font-extrabold text-ink-muted px-1 flex items-center gap-1">
                    <MI name="mic" size={14} />
                    {tr('terminal.docsVoiceHeader')}
                  </div>
                  <div className="bg-raised border border-line rounded-[14px] p-[12px] flex flex-col gap-[6px] mb-3">
                    <div className="text-[11px] font-bold text-[#e8eef2]">
                      {tr('terminal.docsVoiceCounts', {
                        pallets: detail.voice_note.pallet_count ?? 0,
                        boxes: detail.voice_note.box_count ?? 0,
                        solo: detail.voice_note.solo_count ?? 0,
                      })}
                    </div>
                    {detail.voice_note.transcript && (
                      <div className="text-[12px] font-semibold text-ink-muted whitespace-pre-wrap">
                        {detail.voice_note.transcript}
                      </div>
                    )}
                    {detail.voice_note.other_notes && (
                      <div className="text-[11px] font-semibold text-ink-muted">{detail.voice_note.other_notes}</div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pallet hand-off */}
      {palletId && (
        <PalletsBrowser token={token} initialPalletId={palletId} onBack={() => setPalletId(null)} />
      )}

      <Toast toast={toast} />
    </ScreenOverlay>
  );
}
```

- [ ] **Step 2: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: both succeed (component compiles; nothing renders it yet).

- [ ] **Step 3: Commit**

```bash
git add components/terminal/DocumentsBrowser.tsx
git commit -m "feat: DocumentsBrowser overlay — list, month picker, detail, pallet hand-off

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire into DrawerHost, delete the locked mock, prune dead i18n keys

**Files:**
- Modify: `components/terminal/DrawerHost.tsx` (import ~line 7, `useDrawerHost` signature ~line 92, `DrawerHostView` props + docs branch ~lines 54–84)
- Modify: `app/scan/[token]/page.tsx:96` (useDrawerHost call)
- Modify: `app/pallet-verify/[token]/page.tsx:296` (useDrawerHost call)
- Modify: `app/issue/[token]/page.tsx:378` (useDrawerHost call)
- Delete: `components/terminal/DocsScreenLocked.tsx`
- Modify: `lib/i18n/en.ts` + `lib/i18n/he.ts` (remove 4 dead keys)

**Interfaces:**
- Consumes: `DocumentsBrowser` (Task 5).
- Produces: `useDrawerHost(token: string, footer?: ReactNode): { open: () => void; node: ReactNode }` — the signature gains a REQUIRED leading `token` param; all 3 call sites updated in this task.

- [ ] **Step 1: Rewire `DrawerHost.tsx`**

Replace the `DocsScreenLocked` import with `DocumentsBrowser`:

```typescript
import { DocumentsBrowser } from './DocumentsBrowser';
```

Thread `token` through the view — change the `DrawerHostView` signature to:

```typescript
function DrawerHostView({
  token, drawerOpen, screen, onCloseDrawer, onGo, onCloseScreen, footer,
}: {
  token: string;
  drawerOpen: boolean;
  screen: Screen;
  onCloseDrawer: () => void;
  onGo: (s: Screen) => void;
  onCloseScreen: () => void;
  footer?: ReactNode;
}) {
```

and the docs branch to:

```typescript
      {screen === 'docs' && <DocumentsBrowser token={token} onBack={onCloseScreen} />}
```

Change the hook to accept the token (keep the doc comment, update it):

```typescript
/**
 * Hosts the side drawer + its nav destinations for the scanner pages:
 * מסמכים (documents archive), מחסנים (locked stub), הגדרות (real toggles).
 * Usage: const drawer = useDrawerHost(token, footer?); render {drawer.node}
 * INSIDE the page's LanguageContext.Provider; open with drawer.open().
 */
export function useDrawerHost(token: string, footer?: ReactNode): { open: () => void; node: ReactNode } {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>(null);

  const node = (
    <DrawerHostView
      token={token}
      drawerOpen={drawerOpen}
      screen={screen}
      onCloseDrawer={() => setDrawerOpen(false)}
      onGo={(s) => { setDrawerOpen(false); setScreen(s); }}
      onCloseScreen={() => setScreen(null)}
      footer={footer}
    />
  );

  return { open: () => setDrawerOpen(true), node };
}
```

Also update the file-top comment mention of "מסמכים (locked, dimmed sample)" if present.

- [ ] **Step 2: Update the 3 call sites**

`app/scan/[token]/page.tsx` (~line 96) — add `token` as first arg:

```typescript
  const drawer = useDrawerHost(
    token,
    session?.created_at ? <SessionTimer createdAt={session.created_at} /> : undefined,
  );
```

`app/pallet-verify/[token]/page.tsx` (~line 296):

```typescript
  const drawer = useDrawerHost(token);
```

`app/issue/[token]/page.tsx` (~line 378):

```typescript
  const drawer = useDrawerHost(token);
```

(In each file `token` is already in scope — the pages pass it to `<PalletsBrowser token={token}>` further down. If TypeScript complains about `token` being possibly undefined at the hook call, pass `token ?? ''` — the guard route returns 401 for an empty token, which the UI already handles.)

- [ ] **Step 3: Delete the locked mock**

```bash
git rm components/terminal/DocsScreenLocked.tsx
```

- [ ] **Step 4: Prune the 4 now-dead i18n keys**

Remove these lines from BOTH `lib/i18n/en.ts` and `lib/i18n/he.ts` (they were only used by `DocsScreenLocked`):

- `'terminal.docsInvoices'`
- `'terminal.docsDeliveryNotes'`
- `'terminal.docsInvoiceBadge'`
- `'terminal.docsDeliveryBadge'`

Then confirm nothing references them:

Run: `grep -rn "docsInvoices\|docsDeliveryNotes\|docsInvoiceBadge\|docsDeliveryBadge" app components lib`
Expected: no matches.

- [ ] **Step 5: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: both succeed. The build compiling proves every `useDrawerHost` call site was updated (missing `token` is a type error).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: unlock מסמכים — documents archive replaces locked mock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Push, preview deploy, end-to-end verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything above, deployed to a Vercel PREVIEW (pushing `preview` never touches production — prod deploys only from `main`).

- [ ] **Step 1: Push `preview`**

```bash
git push origin preview
```

Expected: push succeeds; Vercel starts a preview deployment automatically.

- [ ] **Step 2: Wait for the preview deployment and get its URL**

Use the Vercel MCP (`list_deployments` for the web-scanner project) until the newest deployment for branch `preview` shows state READY, then note its URL. Preview deployments are cookie-protected: mint a share link for THAT deployment (Vercel MCP `get_access_to_vercel_url` with the deployment URL) — the bypass cookie is deployment-scoped, so a link from an older deployment will NOT work.

- [ ] **Step 3: Seed a live session token**

Insert a `scan_sessions` row via the Supabase MCP (the recipe proven during the pallets-browser verification — the jsonb must be ScanSession-shaped and `data.language` must be `'Hebrew'` to exercise RTL):

```sql
INSERT INTO scan_sessions (token, kind, data, expires_at)
VALUES (
  'docs-verify-0805',
  'carton',
  '{"token": "docs-verify-0805", "type": "RECEIVE", "status": "active", "language": "Hebrew", "invoice_data": {"items": []}, "scanned_boxes": [], "created_at": "2026-08-05T08:00:00Z"}'::jsonb,
  now() + interval '2 hours'
)
ON CONFLICT (token) DO UPDATE SET expires_at = now() + interval '2 hours';
```

- [ ] **Step 4: API smoke checks against the preview URL**

With `$PREVIEW` = share-link URL base and the token above:

```bash
curl -s "$PREVIEW/api/documents?token=docs-verify-0805" | head -c 600
```
Expected: `{"success":true,"documents":[...` with ~30 cards, a `months` array, `hasMore`.

```bash
curl -s "$PREVIEW/api/documents?token=nope"
```
Expected: HTTP 401 `{"success":false,"error":"Invalid or expired session"}`.

Then take one meat card's `id` and one non-meat card's `id` from the list response and fetch both details:

```bash
curl -s "$PREVIEW/api/documents/detail?token=docs-verify-0805&source=meat&id=<uuid>" | head -c 800
curl -s "$PREVIEW/api/documents/detail?token=docs-verify-0805&source=non_meat&id=<session_id>" | head -c 800
```
Expected: `success:true` with `card`, `lines` (non-empty), `pallets`, `voice_note` (null for meat; object for a Type B non-meat doc — pick one whose card shows `has_voice_note: true` if available).

- [ ] **Step 5: UI verification via chrome-devtools MCP**

Open `$PREVIEW/scan/docs-verify-0805` (share link!), then:
1. Open the side drawer (menu button) → tap מסמכים → screenshot: list renders with real cards, photo thumbnails, category badges, Hebrew RTL.
2. Tap the בשר chip → list filters to meat only; tap לא-בשר → non-meat only.
3. Type a supplier fragment in search → list narrows; clear it.
4. Tap the calendar button → month sheet appears; pick a month → chip appears with the month; clear it via the chip's ×.
5. Tap a meat card → detail: photo block, invoice lines, pallets section → tap a pallet → PalletsBrowser detail opens → back returns to the document.
6. Tap a non-meat card (with 🎤 if present) → voice-note section shows transcript + counts.
7. Screenshot each major state for the session record.

Expected: all of the above work; no console errors in chrome-devtools `list_console_messages` beyond pre-existing noise.

- [ ] **Step 6: Clean up the seeded token**

```sql
DELETE FROM scan_sessions WHERE token = 'docs-verify-0805';
```

- [ ] **Step 7: Report**

Summarize verification results to the user. Do NOT merge to `main` / ship to production — that is a separate explicit user decision (graph-mirror merge deploys Vercel prod).
