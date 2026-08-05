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

/**
 * Page through a read 1000 rows at a time — PostgREST silently caps a single
 * request at max-rows (default 1000), which would truncate the archive as
 * delivery_items / invoice_ocr_results grow.
 */
const FETCH_CHUNK = 1000;

async function fetchAllRows<T>(
  context: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await build(from, from + FETCH_CHUNK - 1);
    if (error) fail(context, error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < FETCH_CHUNK) return all;
  }
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
  const [deliveryRows, itemRows, ocrRows] = await Promise.all([
    fetchAllRows<DeliveryRow>('deliveries read', (from, to) =>
      supabase.from('deliveries').select(DELIVERY_COLUMNS).order('id').range(from, to)
    ),
    fetchAllRows<{ receipt_id: string | null; item_name_hebrew: string | null; item_name_english: string | null }>(
      'delivery_items read',
      (from, to) =>
        supabase
          .from('delivery_items')
          .select('receipt_id, item_name_hebrew, item_name_english')
          .order('id')
          .range(from, to)
    ),
    fetchAllRows<{ delivery_id: string | null; invoice_image_url: string | null }>(
      'invoice_ocr_results read',
      (from, to) =>
        supabase
          .from('invoice_ocr_results')
          .select('delivery_id, invoice_image_url')
          .not('delivery_id', 'is', null)
          .not('invoice_image_url', 'is', null)
          .order('id')
          .range(from, to)
    ),
  ]);

  const linesByDelivery = new Map<string, { he: string; en: string }[]>();
  for (const row of itemRows) {
    if (!row.receipt_id) continue;
    const list = linesByDelivery.get(row.receipt_id) ?? [];
    list.push({ he: row.item_name_hebrew ?? '', en: row.item_name_english ?? '' });
    linesByDelivery.set(row.receipt_id, list);
  }

  const ocrImageByDelivery = new Map<string, string>();
  for (const row of ocrRows) {
    if (row.delivery_id && row.invoice_image_url && !ocrImageByDelivery.has(row.delivery_id)) {
      ocrImageByDelivery.set(row.delivery_id, row.invoice_image_url);
    }
  }

  return deliveryRows.map(d =>
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
  'session_id, supplier_hebrew, supplier_english, invoice_number, invoice_date, invoice_image_url, item_name_hebrew, item_name_english, quantity, invoice_quantity, unit, has_discrepancy, discrepancy_reason, pallet_id, voice_note_id, created_at';

async function fetchNonMeatRows(sessionId?: string): Promise<NonMeatRow[]> {
  return fetchAllRows<NonMeatRow>('non_meat_inventory read', (from, to) => {
    let query = supabase.from('non_meat_inventory').select(NM_COLUMNS);
    if (sessionId) query = query.eq('session_id', sessionId);
    return query.order('id').range(from, to);
  });
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
