/**
 * Server-only data access for the משטחים pallets browser.
 *
 * Read-only queries over pallets / pallet_items / box_inventory /
 * non_meat_inventory with the remaining-box arithmetic the bot uses:
 *   - uniform items store only ~2 sample box rows, so remaining is
 *     expected_box_count − issued rows (never the stored-row count);
 *   - non-uniform items count their Available rows;
 *   - boxes with no pallet_item (Loose pallets) count Available directly;
 *   - non-meat pallets read non_meat_inventory.remaining_box_count.
 */
import { supabase } from './supabase';

export const PALLETS_PAGE_SIZE = 30;

// pallet_status enum values (Postgres): In Stock | Partially Issued | Empty | Verified.
// ("Receiving" from the old Airtable lifecycle was never migrated into the enum.)
const ACTIVE_STATUSES = ['In Stock', 'Partially Issued', 'Verified'];

export type StatusFilter = 'active' | 'in_stock' | 'partial' | 'empty' | 'all';

const STATUS_FILTERS: Record<Exclude<StatusFilter, 'all'>, string[]> = {
  active: ACTIVE_STATUSES,
  in_stock: ['In Stock'],
  partial: ['Partially Issued'],
  empty: ['Empty'],
};

interface PalletRow {
  id: string;
  lpn: string;
  status: string | null;
  pallet_type: string | null;
  category: string | null;
  item_name: string | null;
  document_number: string | null;
  box_count: number | null;
  calculated_total_weight_kg: number | null;
  scale_weight_kg: number | null;
  created_at: string;
}

interface PalletItemRow {
  id: string;
  pallet_id: string;
  item_code: string | null;
  item_name_english: string | null;
  item_name_hebrew: string | null;
  expected_box_count: number | null;
  ocr_avg_box_weight_kg: number | null;
  calculated_total_weight_kg: number | null;
  uniform_weight: boolean | null;
}

interface BoxRow {
  pallet_id: string;
  pallet_item_id: string | null;
  status: string | null;
  box_sku: string | null;
  box_weight: number | null;
  box_expiry: string | null;
  inventory_batch_id: string | null;
}

interface NonMeatRow {
  pallet_id: string;
  item_name_hebrew: string | null;
  item_name_english: string | null;
  quantity: number | null;
  remaining_quantity: number | null;
  unit: string | null;
  avg_box_weight: number | null;
  remaining_box_count: number | null;
  box_count: number | null;
}

export interface PalletCard {
  id: string;
  lpn: string;
  status: string;
  pallet_type: string;
  category: string;
  item_name: string;
  document_number: string;
  expected_boxes: number;
  remaining_boxes: number;
  total_weight_kg: number;
  created_at: string;
}

export interface PalletDetailItem {
  name_hebrew: string;
  name_english: string;
  expected_boxes: number;
  remaining_boxes: number;
  issued_boxes: number;
  avg_box_weight_kg: number;
  total_weight_kg: number;
  earliest_expiry: string | null;
  /** non-meat lots: remaining kg/units when box counts are absent */
  remaining_quantity: number | null;
  unit: string | null;
}

export interface PalletDetail {
  card: PalletCard;
  items: PalletDetailItem[];
}

const PALLET_COLUMNS =
  'id, lpn, status, pallet_type, category, item_name, document_number, box_count, calculated_total_weight_kg, scale_weight_kg, created_at';

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

/** Per-item remaining/issued the way the bot computes availability. */
function itemCounts(item: PalletItemRow, boxes: BoxRow[]) {
  const mine = boxes.filter(b => b.pallet_item_id === item.id);
  const issued = mine.filter(b => b.status === 'Issued').length;
  const available = mine.filter(b => b.status === 'Available').length;
  const expected = item.expected_box_count ?? 0;
  const remaining =
    item.uniform_weight && expected > 0 ? Math.max(expected - issued, 0) : available;
  return { expected: expected || mine.length, remaining, issued };
}

/** Boxes not attached to any pallet_item (Loose pallets). */
function orphanBoxes(boxes: BoxRow[], items: PalletItemRow[]): BoxRow[] {
  const itemIds = new Set(items.map(i => i.id));
  return boxes.filter(b => !b.pallet_item_id || !itemIds.has(b.pallet_item_id));
}

function buildCard(
  pallet: PalletRow,
  items: PalletItemRow[],
  boxes: BoxRow[],
  nonMeat: NonMeatRow[]
): PalletCard {
  let expected = pallet.box_count ?? 0;
  let remaining = 0;

  if (pallet.category === 'non_meat' && nonMeat.length > 0) {
    remaining = nonMeat.reduce((sum, r) => sum + (r.remaining_box_count ?? 0), 0);
    if (!expected) expected = nonMeat.reduce((sum, r) => sum + (r.box_count ?? 0), 0);
  } else {
    const myItems = items.filter(i => i.pallet_id === pallet.id);
    const myBoxes = boxes.filter(b => b.pallet_id === pallet.id);
    for (const item of myItems) remaining += itemCounts(item, myBoxes).remaining;
    remaining += orphanBoxes(myBoxes, myItems).filter(b => b.status === 'Available').length;
    if (!expected) {
      expected = myItems.reduce((sum, i) => sum + (i.expected_box_count ?? 0), 0) || myBoxes.length;
    }
  }

  return {
    id: pallet.id,
    lpn: pallet.lpn,
    status: pallet.status ?? 'Unknown',
    pallet_type: pallet.pallet_type ?? 'Single',
    category: pallet.category ?? 'meat',
    item_name: pallet.item_name ?? '',
    document_number: pallet.document_number ?? '',
    expected_boxes: expected,
    remaining_boxes: remaining,
    total_weight_kg: pallet.calculated_total_weight_kg || pallet.scale_weight_kg || 0,
    created_at: pallet.created_at,
  };
}

async function fetchAggregates(palletIds: string[]) {
  if (palletIds.length === 0) {
    return { items: [] as PalletItemRow[], boxes: [] as BoxRow[], nonMeat: [] as NonMeatRow[] };
  }

  const [itemsRes, boxesRes, nonMeatRes] = await Promise.all([
    supabase
      .from('pallet_items')
      .select(
        'id, pallet_id, item_code, item_name_english, item_name_hebrew, expected_box_count, ocr_avg_box_weight_kg, calculated_total_weight_kg, uniform_weight'
      )
      .in('pallet_id', palletIds),
    supabase
      .from('box_inventory')
      .select('pallet_id, pallet_item_id, status, box_sku, box_weight, box_expiry, inventory_batch_id')
      .in('pallet_id', palletIds),
    supabase
      .from('non_meat_inventory')
      .select(
        'pallet_id, item_name_hebrew, item_name_english, quantity, remaining_quantity, unit, avg_box_weight, remaining_box_count, box_count'
      )
      .in('pallet_id', palletIds),
  ]);

  if (itemsRes.error) fail('pallet_items read', itemsRes.error.message);
  if (boxesRes.error) fail('box_inventory read', boxesRes.error.message);
  if (nonMeatRes.error) fail('non_meat_inventory read', nonMeatRes.error.message);

  return {
    items: (itemsRes.data ?? []) as PalletItemRow[],
    boxes: (boxesRes.data ?? []) as BoxRow[],
    nonMeat: (nonMeatRes.data ?? []) as NonMeatRow[],
  };
}

/** Strip characters that would break a PostgREST .or() filter expression. */
function sanitizeSearch(q: string): string {
  return q.replace(/[,()%]/g, ' ').trim();
}

export async function listPallets(params: {
  q?: string;
  status?: StatusFilter;
  page?: number;
}): Promise<{ pallets: PalletCard[]; hasMore: boolean }> {
  const page = Math.max(params.page ?? 0, 0);
  const start = page * PALLETS_PAGE_SIZE;

  let query = supabase
    .from('pallets')
    .select(PALLET_COLUMNS)
    .order('created_at', { ascending: false })
    .range(start, start + PALLETS_PAGE_SIZE); // one extra row → hasMore

  const statusFilter = params.status ?? 'active';
  if (statusFilter !== 'all') {
    query = query.in('status', STATUS_FILTERS[statusFilter]);
  }

  const q = sanitizeSearch(params.q ?? '');
  if (q) {
    query = query.or(`lpn.ilike.%${q}%,item_name.ilike.%${q}%,document_number.ilike.%${q}%`);
  }

  const { data, error } = await query;
  if (error) fail('pallets read', error.message);

  const rows = (data ?? []) as PalletRow[];
  const hasMore = rows.length > PALLETS_PAGE_SIZE;
  const pageRows = rows.slice(0, PALLETS_PAGE_SIZE);

  const { items, boxes, nonMeat } = await fetchAggregates(pageRows.map(p => p.id));
  const pallets = pageRows.map(p =>
    buildCard(
      p,
      items,
      boxes,
      nonMeat.filter(r => r.pallet_id === p.id)
    )
  );

  return { pallets, hasMore };
}

/** Scan-to-find: box barcode → owning pallet's card (or null). */
export async function findPalletByBoxBarcode(barcode: string): Promise<PalletCard | null> {
  const digits = barcode.trim();
  if (!digits) return null;

  const { data, error } = await supabase
    .from('box_inventory')
    .select('pallet_id')
    .or(`barcode.eq.${digits},box_sku.eq.${digits}`)
    .not('pallet_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) fail('box_inventory lookup', error.message);
  if (!data?.pallet_id) return null;

  const detail = await getPalletDetail({ id: data.pallet_id as string });
  return detail?.card ?? null;
}

export async function getPalletDetail(params: {
  id?: string;
  lpn?: string;
}): Promise<PalletDetail | null> {
  let query = supabase.from('pallets').select(PALLET_COLUMNS).limit(1);
  if (params.id) query = query.eq('id', params.id);
  else if (params.lpn) query = query.eq('lpn', params.lpn);
  else return null;

  const { data, error } = await query.maybeSingle();
  if (error) fail('pallet read', error.message);
  if (!data) return null;

  const pallet = data as PalletRow;
  const { items, boxes, nonMeat } = await fetchAggregates([pallet.id]);
  const card = buildCard(pallet, items, boxes, nonMeat);

  if (pallet.category === 'non_meat' && nonMeat.length > 0) {
    return {
      card,
      items: nonMeat.map(r => ({
        name_hebrew: r.item_name_hebrew ?? '',
        name_english: r.item_name_english ?? '',
        expected_boxes: r.box_count ?? 0,
        remaining_boxes: r.remaining_box_count ?? 0,
        issued_boxes: Math.max((r.box_count ?? 0) - (r.remaining_box_count ?? 0), 0),
        avg_box_weight_kg: r.avg_box_weight ?? 0,
        total_weight_kg: 0,
        earliest_expiry: null,
        remaining_quantity: r.remaining_quantity,
        unit: r.unit,
      })),
    };
  }

  const detailItems: PalletDetailItem[] = items.map(item => {
    const counts = itemCounts(item, boxes);
    const myAvailable = boxes.filter(
      b => b.pallet_item_id === item.id && b.status === 'Available' && b.box_expiry
    );
    const earliest = myAvailable.map(b => b.box_expiry as string).sort()[0] ?? null;
    return {
      name_hebrew: item.item_name_hebrew ?? '',
      name_english: item.item_name_english ?? '',
      expected_boxes: counts.expected,
      remaining_boxes: counts.remaining,
      issued_boxes: counts.issued,
      avg_box_weight_kg: item.ocr_avg_box_weight_kg ?? 0,
      total_weight_kg: item.calculated_total_weight_kg ?? 0,
      earliest_expiry: earliest,
      remaining_quantity: null,
      unit: null,
    };
  });

  // Loose pallets: boxes with no pallet_item, grouped by batch (fallback: SKU).
  const orphans = orphanBoxes(boxes, items);
  if (orphans.length > 0) {
    const batchIds = [...new Set(orphans.map(b => b.inventory_batch_id).filter(Boolean))] as string[];
    const batchNames = new Map<string, { he: string; en: string }>();
    if (batchIds.length > 0) {
      const { data: batchData, error: batchErr } = await supabase
        .from('stock_batches')
        .select('id, item_name_hebrew, item_name_english')
        .in('id', batchIds);
      if (batchErr) fail('stock_batches read', batchErr.message);
      for (const b of batchData ?? []) {
        batchNames.set(b.id, { he: b.item_name_hebrew ?? '', en: b.item_name_english ?? '' });
      }
    }

    const groups = new Map<string, { name_he: string; name_en: string; boxes: BoxRow[] }>();
    for (const box of orphans) {
      const named = box.inventory_batch_id ? batchNames.get(box.inventory_batch_id) : undefined;
      const key = named ? `batch:${box.inventory_batch_id}` : `sku:${box.box_sku ?? '?'}`;
      const group = groups.get(key) ?? {
        name_he: named?.he ?? '',
        name_en: named?.en ?? box.box_sku ?? '',
        boxes: [],
      };
      group.boxes.push(box);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const available = group.boxes.filter(b => b.status === 'Available');
      const expiry =
        available
          .map(b => b.box_expiry)
          .filter(Boolean)
          .sort()[0] ?? null;
      detailItems.push({
        name_hebrew: group.name_he,
        name_english: group.name_en,
        expected_boxes: group.boxes.length,
        remaining_boxes: available.length,
        issued_boxes: group.boxes.filter(b => b.status === 'Issued').length,
        avg_box_weight_kg: 0,
        total_weight_kg: group.boxes.reduce((sum, b) => sum + (b.box_weight ?? 0), 0),
        earliest_expiry: expiry as string | null,
        remaining_quantity: null,
        unit: null,
      });
    }
  }

  return { card, items: detailItems };
}
