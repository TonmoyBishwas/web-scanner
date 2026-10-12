-- =============================================================================
-- 2026-10-12  priority_po_first   (M6 — the client's MAK-14 + MAK-15, at his request)
-- =============================================================================
--
-- STATUS: NOT APPLIED yet. Applied only after Tonmoy's OK, byte-exact via psycopg in ONE
--         transaction (no BEGIN / COMMIT in this file: scripts/sql/run_sql_test.py runs it
--         inside BEGIN ... ROLLBACK for the tests), and recorded in
--         supabase_migrations.schema_migrations as priority_po_first. Requires M1-M5 live.
--         Test: tests/2026-10-12-priority-po-first.test.sql
--
-- WHY THIS FILE TOUCHES THE CLIENT'S wb_* FUNCTIONS
--   The client (Mevaser) asked for it in writing on 2026-10-12, owner "Tommy (Supabase)":
--   TOMMY_priority_payload_2026-10-12.md (MAK-14) and TOMMY_item_resolution_from_PO_2026-10-12.md
--   (MAK-15). Every claim in them was checked against the live database first; where the
--   documents were wrong this file follows the data, and says so below.
--
-- WHAT IT DOES
--   1. Item resolution, one order for every caller (wb_resolve_line):
--        po_line    the linked purchase order's line whose supplier_sku = the note's code
--                   (leading zeros ignored). PARTNAME = the line's item; ORDNAME + OLINE
--                   only when exactly one line matches (two lines of one item: item only).
--        po_manual  a line the warehouse manager picked by hand from the linked order
--                   (new table delivery_line_po_picks, written by the bot).
--        bookkeeper sku_crosswalk by the supplier's VAT + supplier SKU together, never by
--                   the SKU alone (wb_resolve_partname, now this step only).
--        (none)     unresolved: no PARTNAME; the supplier's code goes as SUPPARTNAME.
--      Removed: 'sku' (a code mapped for ANOTHER supplier: "101" is minced meat at Glatt and
--      water elsewhere) and 'direct' (a supplier code that happens to equal a PARTNAME).
--      They booked GR26000039 as water / red beet / thighs on 2026-10-03.
--   2. priority_payload: wb_gr_priority_body(...) gains one key, the exact JSON body for
--      Priority's deep insert (POST /DOCUMENTS_P with TRANSORDER_P_SUBFORM), built by
--      wb_gr_priority_payload. No null, no "", numbers as numbers, dates YYYY-MM-DD, only the
--      keys the client listed. lines[] is unchanged apart from added keys (SRC_CODE, METHOD,
--      ORDNAME/OLINE from the resolver), so Make's lot creation keeps working.
--   3. A batch/carton body with no cartons (every non-meat receipt: no pallets) now falls back
--      to the invoice lines. Checked 2026-10-12: all 13 closed non-meat receipts gave 0 lines in
--      'batch' mode, so a deep insert would have sent a document with no lines.
--   4. Unresolved cartons of different supplier codes no longer merge into one line.
--   5. OUR gates (priority_push_plan, priority_push_explain) trust po_line / po_manual /
--      bookkeeper (and the old name vat_sku) and resolve per delivery like the builder.
--   6. priority_push_config (ours) gains:
--        placeholder_partname  NULL until Yossi opens the "unidentified item" part in Priority.
--                              Set → an unresolved line goes out under it, with no lot.
--        payload_units         'kg_both' (default; MAK-15): TQUANT = QUANT = kg, no TUNITNAME,
--                              exactly how the client's own POs carry G items (TQUANT = QUANT,
--                              CONV 1). 'legacy': TQUANT + TUNITNAME as lines[] has them.
--   7. wb_sync_bookkeeper_mappings(rows, full): upsert the bookkeeper's approved_mappings
--      (PROINVOCE) into sku_crosswalk; the client's Make (or a cron with a PROINVOCE key) calls it.
--   8. Removes the three test mappings we added on 2026-10-04
--      (source warehouse_bot.test_251068506_2026-10-04: 101→2137, 550→1120, 2283→2138).
--
-- WHERE THE DOCUMENTS WERE WRONG (checked 2026-10-12)
--   * "same split as today (item + expiry + pallet)": batch lines split by item + expiry only.
--     Kept that way; TOPALLETNAME is not sent (no pallet entity exists in Priority for our LPN).
--   * "G17015 is a unit item": catalog_products says ק'ג (kg). Of the G items, 13 are יח'
--     (units), e.g. G15023, G17008 — but the client's own PO26000011 orders G17008 with
--     TQUANT = QUANT = 120 in kg, and we hold no piece count for meat. kg_both sends kg.
--   * approved_mappings has 600 rows, 465 with a supplier SKU; 135 are description-only and
--     cannot match by SKU.
--
-- ROLLBACK: re-create the previous definitions from the 2026-10-12 dump kept with this file's
--   test (tests/2026-10-12-priority-po-first.rollback.sql), drop delivery_line_po_picks, drop
--   the two config columns. The three deleted test mappings are not restored.
-- =============================================================================

-- ── 6. config (ours) ────────────────────────────────────────────────────────
alter table public.priority_push_config
  add column if not exists placeholder_partname text,
  add column if not exists payload_units text not null default 'kg_both';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'priority_push_config_payload_units_chk') then
    alter table public.priority_push_config
      add constraint priority_push_config_payload_units_chk check (payload_units in ('kg_both','legacy'));
  end if;
end $$;
comment on column public.priority_push_config.placeholder_partname is
  'Priority PARTNAME of the "unidentified item - to be matched" part (Yossi opens it). NULL = an unresolved line goes out with no PARTNAME and Priority refuses the document. Set = the line goes out under this part, with no lot (SERIALNAME/EXPDATE).';
comment on column public.priority_push_config.payload_units is
  'How priority_payload carries quantities. kg_both (default): TQUANT = QUANT = received kg, no TUNITNAME (as the client''s POs carry G items). legacy: TQUANT + TUNITNAME as lines[] has them.';

-- ── manual PO-line picks (ours; written by the bot) ─────────────────────────
create table if not exists public.delivery_line_po_picks (
  id           bigserial primary key,
  delivery_id  uuid not null references public.deliveries(id) on delete cascade,
  supplier_sku text not null,
  po_number    text not null,
  line_no      int  not null,
  item_code    text,
  picked_by    text,
  picked_at    timestamptz not null default now(),
  tenant_id    text,
  unique (delivery_id, supplier_sku)
);
alter table public.delivery_line_po_picks enable row level security;
comment on table public.delivery_line_po_picks is
  'A purchase-order line the warehouse manager picked by hand for a note line whose supplier code is not on the linked order (MAK-15 step 2, method po_manual). Honoured only while the order is linked to the delivery. Never copied into the bookkeeper''s mappings.';

-- ── helpers ─────────────────────────────────────────────────────────────────
create or replace function public.wb_norm_sku(p text)
 returns text language sql immutable as $$
  -- '01135702' and '1135702' are the same supplier code; '0' stays '0'
  select case when p is null or btrim(p) = '' then null
              else coalesce(nullif(ltrim(btrim(p), '0'), ''), '0') end
$$;

create or replace function public.wb_jsonb_clean(p jsonb)
 returns jsonb language sql immutable as $$
  -- drop keys whose value is null or an empty / blank string
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    from jsonb_each(coalesce(p, '{}'::jsonb)) as e(k, v)
   where jsonb_typeof(v) <> 'null'
     and not (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '')
$$;

create or replace function public.priority_item_method_trusted(p_method text)
 returns boolean language sql immutable as $$
  -- the resolution methods a push may rely on (MAK-15); vat_sku = the pre-2026-10-12 name
  select coalesce(p_method in ('po_line', 'po_manual', 'bookkeeper', 'vat_sku'), false)
$$;

-- ── 1. resolution ───────────────────────────────────────────────────────────
-- step 3 only: the bookkeeper's mapping for THIS supplier
create or replace function public.wb_resolve_partname(p_raw text, p_vat text)
 returns table(partname text, method text)
 language sql stable as $function$
  select xw.internal_sku, 'bookkeeper'::text
    from public.sku_crosswalk xw
    join public.catalog_products cp on cp.partname = xw.internal_sku
   where public.wb_norm_vat(p_vat) is not null
     and public.wb_norm_sku(p_raw) is not null
     and public.wb_norm_vat(xw.supplier_vat) = public.wb_norm_vat(p_vat)
     and public.wb_norm_sku(xw.supplier_sku) = public.wb_norm_sku(p_raw)
     and coalesce(xw.source, '') <> 'warehouse_manual'
     and coalesce(xw.source, '') not like 'warehouse_bot.test%'
   order by (xw.supplier_sku = btrim(p_raw)) desc, xw.synced_at desc nulls last, xw.internal_sku
   limit 1
$function$;

create or replace function public.wb_resolve_line(p_delivery_id uuid, p_raw text, p_vat text)
 returns table(partname text, method text, ordname text, oline int)
 language plpgsql stable as $function$
declare
  v_pos   text[] := public.wb_delivery_po_numbers(p_delivery_id);
  v_n     int; v_items int; v_po text; v_line int; v_item text;
begin
  if public.wb_norm_sku(p_raw) is null then return; end if;

  -- 1. po_line: the linked order's line carrying this supplier code
  if cardinality(v_pos) > 0 then
    select count(*), count(distinct l.item_code), min(l.po_number),
           min(case when l.raw ->> 'KLINE' ~ '^[0-9]+$' then (l.raw ->> 'KLINE')::int else l.line_no end),
           min(l.item_code)
      into v_n, v_items, v_po, v_line, v_item
      from public.open_purchase_order_lines l
     where l.po_number = any (v_pos)
       and l.item_code is not null
       and public.wb_norm_sku(l.supplier_sku) = public.wb_norm_sku(p_raw);
    if v_items = 1 then
      return query select v_item, 'po_line'::text,
                          case when v_n = 1 then v_po end,
                          case when v_n = 1 then v_line end;
      return;
    end if;

    -- 2. po_manual: picked by hand from the linked order's lines
    select l.item_code, l.po_number,
           case when l.raw ->> 'KLINE' ~ '^[0-9]+$' then (l.raw ->> 'KLINE')::int else l.line_no end
      into v_item, v_po, v_line
      from public.delivery_line_po_picks pk
      join public.open_purchase_order_lines l
        on l.po_number = pk.po_number and l.line_no = pk.line_no
     where pk.delivery_id = p_delivery_id
       and public.wb_norm_sku(pk.supplier_sku) = public.wb_norm_sku(p_raw)
       and pk.po_number = any (v_pos)
       and l.item_code is not null
     order by pk.picked_at desc
     limit 1;
    if v_item is not null then
      return query select v_item, 'po_manual'::text, v_po, v_line;
      return;
    end if;
  end if;

  -- 3. bookkeeper (VAT + supplier SKU)
  return query select r.partname, r.method, null::text, null::int
                 from public.wb_resolve_partname(p_raw, p_vat) r;
end $function$;

comment on function public.wb_resolve_line(uuid, text, text) is
  'MAK-15 item resolution for one note line of one delivery: po_line, then po_manual, then bookkeeper (VAT + SKU). No row = unresolved. Used by wb_build_priority_gr_full, wb_gr_cartons, wb_gr_po_balance and our priority_push_explain.';

-- ── 8. the 2026-10-04 test mappings ─────────────────────────────────────────
delete from public.sku_crosswalk where source = 'warehouse_bot.test_251068506_2026-10-04';


-- ── the builder: invoice lines resolved per delivery ────────────────────────
CREATE OR REPLACE FUNCTION public.wb_build_priority_gr_full(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  d deliveries; v_norm text; v_supname text; v_supdes text; v_vatnum text;
  v_doc bigint; v_docno text; v_lines_json jsonb;
  v_line_count int; v_unresolved int; v_totquant numeric;
BEGIN
  SELECT * INTO d FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery % not found', p_delivery_id; END IF;

  v_norm := regexp_replace(coalesce(d.supplier_hebrew,''), '[^0-9א-ת]', '', 'g');
  SELECT supname, supdes, vatnum INTO v_supname, v_supdes, v_vatnum
  FROM priority_suppliers
  WHERE regexp_replace(coalesce(supdes,''), '[^0-9א-ת]', '', 'g') = v_norm
  ORDER BY (statdes = 'פעיל') DESC LIMIT 1;

  SELECT doc, docno INTO v_doc, v_docno
  FROM priority_goods_receipts WHERE delivery_id = p_delivery_id LIMIT 1;
  IF v_docno IS NULL THEN
    v_doc   := -(1 + (abs(hashtextextended(p_delivery_id::text, 0)) % 9000000000));
    v_docno := 'GRL' || to_char(coalesce(d.created_at, now()), 'YY')
               || lpad(((abs(hashtextextended(p_delivery_id::text, 42)) % 900000) + 1)::text, 6, '0');
  END IF;

  SELECT jsonb_agg(x.line ORDER BY x.item_code),
         count(*), count(*) FILTER (WHERE x.partname IS NULL),
         coalesce(sum(x.qty),0)
  INTO v_lines_json, v_line_count, v_unresolved, v_totquant
  FROM (
    SELECT di.item_code, di.received_qty_kg AS qty, r.partname,
           jsonb_build_object(
             'PARTNAME', r.partname,
             'TQUANT',   round(di.received_qty_kg,3),
             'SRC_CODE', di.item_code,
             'METHOD',   r.method,
             'ORDNAME',  r.ordname,
             'OLINE',    r.oline,
             'PARTDES',  cpp.partdes,
             'UNITNAME', cpp.unitname,
             'SUPPARTNAME', CASE WHEN EXISTS (
                 SELECT 1 FROM sku_crosswalk xw
                 WHERE xw.supplier_vat = v_vatnum AND xw.supplier_sku = di.item_code)
               THEN di.item_code END,
             'RESOLVED', (r.partname IS NOT NULL)
           ) AS line
    FROM delivery_items di
    LEFT JOIN LATERAL public.wb_resolve_line(p_delivery_id, di.item_code, v_vatnum) r ON TRUE
    LEFT JOIN catalog_products cpp ON cpp.partname = r.partname
    WHERE di.receipt_id = p_delivery_id
  ) x;

  RETURN jsonb_build_object(
    'DOC', v_doc, 'DOCNO', v_docno, 'TYPE', 'P',
    'SUPNAME', v_supname, 'BOOKNUM', d.document_number,
    'CURDATE', d.created_at, 'STATDES', 'טיוטא', 'FLAG', 'Y', 'IVALL', 'N',
    'TOTQUANT', round(coalesce(v_totquant,0),3), 'CODE', 'ILS', 'TAXCODE', '002',
    'DETAILS', v_line_count || ' שורות · נקלט ' || round(coalesce(v_totquant,0),2) || ' ק"ג',
    'TRANSORDER_P', coalesce(v_lines_json,'[]'::jsonb),
    '_meta', jsonb_build_object(
      'supplier_resolved', (v_supname IS NOT NULL),
      'supplier_vat', v_vatnum, 'supplier_matched_des', v_supdes,
      'line_count', v_line_count, 'lines_unresolved', v_unresolved,
      'ready_to_push', (v_supname IS NOT NULL AND v_unresolved = 0
                        AND coalesce(v_line_count,0) > 0 AND coalesce(v_totquant,0) > 0)
    )
  );
END $function$;

-- ── cartons: + src_code, method, ordname, oline (return type changes → drop) ─
DROP FUNCTION IF EXISTS public.wb_gr_cartons(uuid);
CREATE FUNCTION public.wb_gr_cartons(p_delivery_id uuid)
 RETURNS TABLE(partname text, suppartname text, box_weight numeric, box_expiry date, production_date text,
               supplier_batch text, packaging_type text, barcode text, box_id uuid, location_code text,
               numpack integer, sampled boolean,
               src_code text, method text, ordname text, oline integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE d deliveries; v_vat text;
BEGIN
  SELECT * INTO d FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT s.vatnum INTO v_vat FROM priority_suppliers s
  WHERE regexp_replace(coalesce(s.supdes,''),'[^0-9א-ת]','','g')
      = regexp_replace(coalesce(d.supplier_hebrew,''),'[^0-9א-ת]','','g')
  ORDER BY (s.statdes='פעיל') DESC LIMIT 1;

  RETURN QUERY
  WITH boxes AS (
    SELECT bi.id AS c_box_id, bi.barcode AS c_barcode, bi.box_weight AS c_w,
           bi.box_expiry AS c_exp, bi.supplier_batch AS c_batch,
           bi.production_date AS c_prod, p.location_code AS c_loc,
           pi.item_code AS c_raw, pi.packaging_type AS c_pack,
           1::int AS c_numpack, false AS c_sampled
    FROM box_inventory bi
    JOIN pallets p ON p.id = bi.pallet_id AND p.receipt_id = p_delivery_id
    LEFT JOIN pallet_items pi ON pi.id = bi.pallet_item_id
  ),
  gaps AS (
    SELECT NULL::uuid, NULL::text,
           (coalesce(pi.calculated_total_weight_kg,0) - coalesce(sum(bi.box_weight),0))::numeric,
           max(bi.box_expiry), max(bi.supplier_batch), max(bi.production_date),
           p.location_code, pi.item_code, pi.packaging_type,
           (pi.expected_box_count - count(bi.id))::int, true
    FROM pallet_items pi
    JOIN pallets p ON p.id = pi.pallet_id AND p.receipt_id = p_delivery_id
    LEFT JOIN box_inventory bi ON bi.pallet_item_id = pi.id
    GROUP BY p.location_code, pi.item_code, pi.packaging_type,
             pi.expected_box_count, pi.calculated_total_weight_kg
    HAVING pi.expected_box_count > count(bi.id)
  ),
  u AS (SELECT * FROM boxes UNION ALL SELECT * FROM gaps),
  codes AS (SELECT DISTINCT u.c_raw FROM u),
  res AS (   -- one resolution per supplier code, not one per carton
    SELECT k.c_raw, r.partname, r.method, r.ordname, r.oline
    FROM codes k LEFT JOIN LATERAL public.wb_resolve_line(p_delivery_id, k.c_raw, v_vat) r ON TRUE
  )
  SELECT r.partname,
         CASE WHEN EXISTS (SELECT 1 FROM sku_crosswalk xw
                           WHERE xw.supplier_vat=v_vat AND xw.supplier_sku=u.c_raw)
              THEN u.c_raw END,
         u.c_w, u.c_exp, u.c_prod, u.c_batch, u.c_pack,
         u.c_barcode, u.c_box_id, u.c_loc, u.c_numpack, u.c_sampled,
         u.c_raw, r.method, r.ordname, r.oline
  FROM u LEFT JOIN res r ON r.c_raw IS NOT DISTINCT FROM u.c_raw;
END $function$;

CREATE OR REPLACE FUNCTION public.wb_gr_lines_by_batch(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce(jsonb_agg(l ORDER BY l->>'PARTNAME', l->>'SRC_CODE', l->>'EXPDATE'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'PARTNAME',       c.partname,
      'TQUANT',         round(sum(c.box_weight),3),
      'NUMPACK',        sum(c.numpack)::int,
      'EXPDATE',        c.box_expiry,
      'OPDATE',         nullif(max(c.production_date),''),
      'LOTNAME',        CASE WHEN c.partname IS NOT NULL AND c.box_expiry IS NOT NULL
                             THEN c.partname||'-'||to_char(c.box_expiry,'YYYYMMDD') END,
      'SUPPARTNAME',    max(c.suppartname),
      'SRC_CODE',       max(c.src_code),
      'METHOD',         max(c.method),
      -- an order line only when every carton of the line points at the same one
      'ORDNAME',        CASE WHEN count(DISTINCT (c.ordname, c.oline)) = 1
                              AND bool_and(c.ordname IS NOT NULL) THEN max(c.ordname) END,
      'OLINE',          CASE WHEN count(DISTINCT (c.ordname, c.oline)) = 1
                              AND bool_and(c.ordname IS NOT NULL) THEN max(c.oline) END,
      'PACKCODE',       max(c.packaging_type),
      'SUPPLIER_BATCH', max(c.supplier_batch),
      'LOCATION',       max(c.location_code),
      'SAMPLED',        bool_or(c.sampled),
      'RESOLVED',       (c.partname IS NOT NULL)
    ) AS l
    FROM public.wb_gr_cartons(p_delivery_id) c
    -- unresolved cartons stay apart per supplier code (they used to merge into one line)
    GROUP BY c.partname, CASE WHEN c.partname IS NULL THEN c.src_code END, c.box_expiry
  ) q;
$function$;

CREATE OR REPLACE FUNCTION public.wb_gr_lines_per_carton(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'PARTNAME',       c.partname,
    'TQUANT',         round(c.box_weight,3),
    'NUMPACK',        c.numpack,
    'EXPDATE',        c.box_expiry,
    'OPDATE',         nullif(c.production_date,''),
    'LOTNAME',        CASE WHEN c.partname IS NOT NULL AND c.box_expiry IS NOT NULL
                           THEN c.partname||'-'||to_char(c.box_expiry,'YYYYMMDD') END,
    'SUPPARTNAME',    c.suppartname,
    'SRC_CODE',       c.src_code,
    'METHOD',         c.method,
    'ORDNAME',        c.ordname,
    'OLINE',          c.oline,
    'PACKCODE',       c.packaging_type,
    'SUPPLIER_BATCH', c.supplier_batch,
    'BOX_BARCODE',    c.barcode,
    'BOX_ID',         c.box_id,
    'LOCATION',       c.location_code,
    'SAMPLED',        c.sampled,
    'RESOLVED',       (c.partname IS NOT NULL)
  ) ORDER BY c.partname, c.box_expiry, c.barcode NULLS LAST), '[]'::jsonb)
  FROM public.wb_gr_cartons(p_delivery_id) c;
$function$;

-- ── 2. priority_payload ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wb_gr_payload_line(p_line jsonb, p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  d deliveries; cfg priority_push_config;
  v_part text; v_placeholder boolean; v_qty numeric; v_exp date; v_lot text;
  v_ord text; v_oline int; v_out jsonb;
BEGIN
  SELECT * INTO d FROM deliveries WHERE id = p_delivery_id;
  SELECT * INTO cfg FROM priority_push_config WHERE id = 1;

  v_part := nullif(btrim(p_line->>'PARTNAME'), '');
  v_placeholder := v_part IS NULL AND nullif(btrim(cfg.placeholder_partname), '') IS NOT NULL;
  IF v_placeholder THEN v_part := btrim(cfg.placeholder_partname); END IF;

  v_qty := round((p_line->>'TQUANT')::numeric, 3);

  -- a lot only for a real item; EXPDATE and SERIALNAME always travel together
  IF NOT v_placeholder AND v_part IS NOT NULL
     AND nullif(p_line->>'EXPDATE', '') IS NOT NULL THEN
    v_exp := (p_line->>'EXPDATE')::date;
    v_lot := coalesce(nullif(btrim(p_line->>'LOTNAME'), ''), v_part || '-' || to_char(v_exp, 'YYYYMMDD'));
  END IF;

  -- ORDNAME + OLINE only together, and only for a real order line
  v_ord := nullif(btrim(p_line->>'ORDNAME'), '');
  IF v_ord IS NOT NULL AND (p_line->>'OLINE') ~ '^[0-9]+$' AND NOT v_placeholder THEN
    v_oline := (p_line->>'OLINE')::int;
  ELSE
    v_ord := NULL;
  END IF;

  v_out := jsonb_build_object(
    'PARTNAME',     v_part,
    'TQUANT',       v_qty,
    'SERIALNAME',   v_lot,
    'EXPDATE',      CASE WHEN v_lot IS NOT NULL THEN to_char(v_exp, 'YYYY-MM-DD') END,
    'SUPPARTNAME',  coalesce(nullif(btrim(p_line->>'SUPPARTNAME'), ''), nullif(btrim(p_line->>'SRC_CODE'), '')),
    'ORDNAME',      v_ord,
    'OLINE',        v_oline,
    'SUPNO',        nullif(btrim(coalesce(p_line->>'SUPNO', p_line->>'SUPPLIER_BATCH')), ''),
    'BOOKNUM',      nullif(btrim(d.document_number), ''),
    'IVDATE',       to_char(d.invoice_date, 'YYYY-MM-DD'));

  IF coalesce(cfg.payload_units, 'kg_both') = 'legacy' THEN
    v_out := v_out || jsonb_build_object('TUNITNAME', nullif(btrim(p_line->>'TUNITNAME'), ''));
  ELSE
    v_out := v_out || jsonb_build_object('QUANT', v_qty);
  END IF;

  RETURN public.wb_jsonb_clean(v_out);
END $function$;

CREATE OR REPLACE FUNCTION public.wb_gr_priority_payload(p_delivery_id uuid, p_header jsonb, p_lines jsonb, p_pos text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE v_lines jsonb; v_packs int; v_details text;
BEGIN
  SELECT coalesce(jsonb_agg(public.wb_gr_payload_line(l, p_delivery_id) ORDER BY ord), '[]'::jsonb),
         sum(CASE WHEN (l->>'NUMPACK') ~ '^[0-9]+$' THEN (l->>'NUMPACK')::int END)
    INTO v_lines, v_packs
    FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) WITH ORDINALITY AS t(l, ord);

  -- cartons have no quantity field until Priority has a PACKCODE: they go in DETAILS
  v_details := nullif(btrim(p_header->>'DETAILS'), '');
  IF coalesce(v_packs, 0) > 0 THEN
    v_details := concat_ws(' · ', v_details, v_packs || ' קרטונים');   -- English: N cartons
  END IF;

  RETURN public.wb_jsonb_clean(jsonb_build_object(
      'SUPNAME',     p_header->>'SUPNAME',
      'BOOKNUM',     p_header->>'BOOKNUM',
      'CURDATE',     p_header->>'CURDATE',
      'STATDES',     'טיוטא',                                          -- English: draft
      'DETAILS',     v_details,
      'ORDNAME',     CASE WHEN cardinality(p_pos) = 1 THEN p_pos[1] END, -- a linked order only
      'TOWARHSNAME', p_header->>'TOWARHSNAME',
      'TOLOCNAME',   p_header->>'TOLOCNAME'))
    || jsonb_build_object('TRANSORDER_P_SUBFORM', v_lines);
END $function$;

comment on function public.wb_gr_priority_payload(uuid, jsonb, jsonb, text[]) is
  'MAK-14: the exact JSON body for Priority''s deep insert of a goods receipt (DOCUMENTS_P + TRANSORDER_P_SUBFORM). No null, no empty string, numbers as numbers, dates YYYY-MM-DD, only the client''s listed keys. One object per lines[] entry.';

CREATE OR REPLACE FUNCTION public.wb_gr_priority_body(p_delivery_id uuid, p_mode text DEFAULT 'invoice'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE g jsonb; d deliveries; v_lines jsonb; v_file jsonb;
        v_tot numeric; v_unres int; v_n int; v_ready boolean;
        v_reason text; v_missing jsonb; v_nolot int;
        v_pos text[]; v_hdr_ord text; v_amb int; v_unlinked int;
        v_header jsonb; v_wh jsonb; v_lines_mode text;
BEGIN
  g := wb_build_priority_gr_full(p_delivery_id);
  SELECT * INTO d FROM deliveries WHERE id = p_delivery_id;

  v_lines := CASE p_mode
    WHEN 'carton' THEN wb_gr_lines_per_carton(p_delivery_id)
    WHEN 'batch'  THEN wb_gr_lines_by_batch(p_delivery_id)
  END;
  v_lines_mode := p_mode;
  -- no cartons (every non-meat receipt has no pallets): the invoice lines are the receipt
  IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
    IF p_mode IN ('carton', 'batch') THEN v_lines_mode := 'invoice'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
              'PARTNAME', l->>'PARTNAME','TQUANT',(l->>'TQUANT')::numeric,
              'SRC_CODE', l->>'SRC_CODE','SUPPARTNAME', l->>'SUPPARTNAME',
              'METHOD', l->>'METHOD','ORDNAME', l->>'ORDNAME','OLINE', l->'OLINE',
              'RESOLVED', (l->>'RESOLVED')::boolean)),'[]'::jsonb)
      INTO v_lines
      FROM jsonb_array_elements(g->'TRANSORDER_P') l;
  END IF;

  -- Yossi §13 wants יח' מפעל on every line; it lives on the item card
  v_lines := public.wb_gr_enrich_lines(v_lines);

  v_pos := public.wb_delivery_po_numbers(p_delivery_id);
  IF array_length(v_pos,1) > 0 THEN
    -- the resolver's order line wins; otherwise match the item on the linked order(s)
    SELECT coalesce(jsonb_agg(
             CASE WHEN nullif(l->>'ORDNAME','') IS NOT NULL
                  THEN l || jsonb_build_object('match','exact')
                  ELSE l || public.wb_gr_po_match(p_delivery_id, l->>'PARTNAME') END
             ORDER BY ord), '[]'::jsonb)
      INTO v_lines
    FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(l, ord);
  END IF;

  v_hdr_ord := CASE WHEN array_length(v_pos,1) = 1 THEN v_pos[1]
                    ELSE d.purchase_order_number END;

  SELECT coalesce(sum((l->>'TQUANT')::numeric),0),
         count(*) FILTER (WHERE NOT coalesce((l->>'RESOLVED')::boolean,false)),
         count(*),
         count(*) FILTER (WHERE l->>'match' = 'ambiguous'),
         count(*) FILTER (WHERE l->>'match' = 'none'),
         count(*) FILTER (WHERE l->>'EXPDATE' IS NULL AND v_lines_mode <> 'invoice')
    INTO v_tot, v_unres, v_n, v_amb, v_unlinked, v_nolot
  FROM jsonb_array_elements(v_lines) l;

  v_ready := (g->'_meta'->>'supplier_resolved')::boolean
             AND v_unres = 0 AND v_n > 0 AND v_tot > 0;

  v_reason := CASE
    WHEN NOT (g->'_meta'->>'supplier_resolved')::boolean THEN 'supplier_unmatched'
    WHEN v_n = 0 OR v_tot <= 0                           THEN 'nothing_received'
    WHEN v_unres > 0                                     THEN 'items_unmapped'
  END;

  IF v_unres > 0 THEN
    SELECT jsonb_agg(DISTINCT l->>'SRC_CODE') INTO v_missing
    FROM jsonb_array_elements(g->'TRANSORDER_P') l
    WHERE NOT coalesce((l->>'RESOLVED')::boolean,false);
  END IF;

  v_file := public.wb_gr_file(p_delivery_id);
  v_wh   := public.wb_gr_warehouse(p_delivery_id);

  v_header := jsonb_build_object(
      'DOCNO',g->>'DOCNO','TYPE','P','SUPNAME',g->>'SUPNAME',
      'BOOKNUM',g->>'BOOKNUM','CURDATE',g->>'CURDATE','STATDES','טיוטא','FLAG','Y',
      'IVALL','N','CODE','ILS','TAXCODE',g->>'TAXCODE',
      'DETAILS', v_n || ' שורות · נקלט ' || round(v_tot,2) || ' ק"ג',
      'ORDNAME',     v_hdr_ord,
      'TOWARHSNAME', v_wh->>'TOWARHSNAME',
      'TOLOCNAME',   v_wh->>'TOLOCNAME');

  RETURN jsonb_build_object(
    'ready', v_ready, 'mode', p_mode, 'lines_mode', v_lines_mode, 'docno', g->>'DOCNO',
    'not_ready_reason', v_reason,
    'unmapped_codes',   coalesce(v_missing,'[]'::jsonb),
    'has_file',  v_file->'has_file',
    'file_url',  v_file->>'file_url',
    'file_name', v_file->>'file_name',
    'file_ext',  v_file->>'file_ext',
    'header', v_header,
    'lines', v_lines,
    'priority_payload', public.wb_gr_priority_payload(p_delivery_id, v_header, v_lines, v_pos),
    'po', jsonb_build_object(
      'linked',          coalesce(to_jsonb(v_pos), '[]'::jsonb),
      'header_ordname',  v_hdr_ord,
      'lines_linked',    v_n - coalesce(v_amb,0) - coalesce(v_unlinked,0),
      'lines_ambiguous', coalesce(v_amb,0),
      'lines_unlinked',  coalesce(v_unlinked,0)),
    '_capture_gaps', jsonb_build_object(
      'po',(array_length(v_pos,1) > 0),
      'warehouse_source', v_wh->>'source',
      'warehouse',(d.warehouse_code IS NOT NULL),
      'location',(d.location_code IS NOT NULL),
      'lines_without_expiry', coalesce(v_nolot,0),
      'totquant', v_tot, 'unresolved', v_unres, 'line_count', v_n)
  );
END $function$;

-- ── 7. the bookkeeper's mappings → sku_crosswalk ────────────────────────────
CREATE OR REPLACE FUNCTION public.wb_sync_bookkeeper_mappings(p_rows jsonb, p_full boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
-- p_rows: [{supplier_vat, supplier_sku, internal_sku, supplier_name?}, ...] read from PROINVOCE
-- approved_mappings (rows with a supplier SKU). The bookkeeper's mapping wins over any other
-- row for the same VAT + SKU (a PO-harvested one, a warehouse suggestion). p_full = the rows
-- are ALL of her mappings: a proinvoce row no longer in them is removed.
DECLARE v_in int; v_ins int; v_upd int; v_same int; v_del int := 0; v_skip int; v_over jsonb;
BEGIN
  DROP TABLE IF EXISTS pg_temp._bk;
  CREATE TEMP TABLE _bk ON COMMIT DROP AS
  SELECT DISTINCT ON (vat, sku) vat, sku, internal, name
    FROM (SELECT public.wb_norm_vat(r->>'supplier_vat') AS vat,
                 nullif(btrim(r->>'supplier_sku'), '')  AS sku,
                 nullif(btrim(r->>'internal_sku'), '')  AS internal,
                 nullif(btrim(r->>'supplier_name'), '') AS name
            FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r) x
   WHERE vat IS NOT NULL AND sku IS NOT NULL AND internal IS NOT NULL
   ORDER BY vat, sku, internal;

  SELECT jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) INTO v_in;
  SELECT v_in - count(*) INTO v_skip FROM _bk;

  SELECT count(*) INTO v_same FROM _bk b JOIN sku_crosswalk x
    ON coalesce(x.supplier_vat,'') = b.vat AND x.supplier_sku = b.sku
   WHERE x.internal_sku = b.internal AND x.source = 'proinvoce.approved_mappings';

  SELECT coalesce(jsonb_agg(jsonb_build_object('supplier_vat', b.vat, 'supplier_sku', b.sku,
           'was', x.internal_sku, 'was_source', x.source, 'now', b.internal)), '[]'::jsonb)
    INTO v_over
    FROM _bk b JOIN sku_crosswalk x
      ON coalesce(x.supplier_vat,'') = b.vat AND x.supplier_sku = b.sku
   WHERE x.internal_sku <> b.internal OR x.source IS DISTINCT FROM 'proinvoce.approved_mappings';

  WITH up AS (
    INSERT INTO sku_crosswalk (supplier_vat, supplier_sku, internal_sku, supplier_name, source, synced_at)
    SELECT vat, sku, internal, name, 'proinvoce.approved_mappings', now() FROM _bk
    ON CONFLICT (coalesce(supplier_vat,''), supplier_sku) DO UPDATE
       SET internal_sku = excluded.internal_sku,
           supplier_name = coalesce(excluded.supplier_name, sku_crosswalk.supplier_name),
           source = excluded.source, synced_at = excluded.synced_at
     WHERE sku_crosswalk.internal_sku IS DISTINCT FROM excluded.internal_sku
        OR sku_crosswalk.source IS DISTINCT FROM excluded.source
    RETURNING (xmax = 0) AS inserted)
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_ins, v_upd FROM up;

  IF p_full THEN
    WITH gone AS (
      DELETE FROM sku_crosswalk x
       WHERE x.source = 'proinvoce.approved_mappings'
         AND NOT EXISTS (SELECT 1 FROM _bk b
                          WHERE b.vat = coalesce(x.supplier_vat,'') AND b.sku = x.supplier_sku)
      RETURNING 1)
    SELECT count(*) INTO v_del FROM gone;
  END IF;

  RETURN jsonb_build_object('ok', true, 'received', v_in, 'skipped', v_skip,
    'inserted', v_ins, 'updated', v_upd, 'unchanged', v_same, 'removed', v_del,
    'overridden', v_over);
END $function$;

comment on function public.wb_sync_bookkeeper_mappings(jsonb, boolean) is
  'MAK-15: copy the bookkeeper''s approved_mappings (PROINVOCE, rows with a supplier SKU) into sku_crosswalk, source proinvoce.approved_mappings. Her mapping wins for the same VAT + SKU. Call it regularly (Make or cron) with all her rows and p_full = true.';

-- ── 5. OUR gates trust the MAK-15 methods; per-delivery resolution ─────────

CREATE OR REPLACE FUNCTION public.priority_push_plan()
 RETURNS TABLE(outbox_id bigint, delivery_id uuid, decision text, reason text, codes text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  cfg         public.priority_push_config%rowtype;
  rw          record;
  v_gr        text;
  v_draft     text;
  v_cat       text;
  v_cat_since timestamptz;
  v_body      jsonb;
  v_ready     boolean;
  v_reason    text;
  v_codes     text[];
  v_guessed   text[];
  v_failed    text;
  v_doc       text;
  v_dup       text;
  v_evaluated integer := 0;
  c_batch     constant integer := 20;   -- readiness checks (= max sends) per run
begin
  select * into cfg from public.priority_push_config c where c.id = 1;
  if not found then
    return;
  end if;

  for rw in
    select o.id, o.delivery_id, o.category, o.queued_at, o.released_at,
           o.target,                                                          -- M1
           d.status::text as delivery_status_now,
           nullif(btrim(coalesce(d.document_number, o.document_number)), '') as doc,
           d.created_at as delivery_created_at
      from public.priority_push_outbox o
      left join public.deliveries d on d.id = o.delivery_id
     where o.status in ('queued', 'waiting')
       and (o.next_check_at is null or o.next_check_at <= now())
     order by o.queued_at, o.id
  loop
    outbox_id   := rw.id;
    delivery_id := rw.delivery_id;
    decision    := null;
    reason      := null;
    codes       := null;
    v_gr        := null;
    v_draft     := null;
    v_doc       := rw.doc;
    v_dup       := null;

    select g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?') || ')'
      into v_gr
      from public.priority_goods_receipts g
     where g.delivery_id = rw.delivery_id
       and g.origin <> 'warehouse_bot'
     order by g.synced_at desc
     limit 1;
    if v_gr is not null then
      decision := 'already_in_priority';
      reason   := 'Priority already has GR ' || v_gr;
      return next;
      continue;
    end if;

    select g.docno
      into v_draft
      from public.priority_goods_receipts g
     where g.delivery_id = rw.delivery_id
       and g.origin = 'warehouse_bot'
     limit 1;
    if v_draft is not null then
      decision := 'hold_local_draft';
      reason   := 'priority_goods_receipts has a local warehouse_bot row ' || v_draft
                  || '; held until it is synced (origin priority_push) or removed';
      return next;
      continue;
    end if;

    if rw.delivery_status_now is null
       or rw.delivery_status_now not in ('Complete', 'Has Discrepancy') then
      decision := 'hold_not_closed';
      reason   := 'delivery status is now ' || coalesce(rw.delivery_status_now, 'missing')
                  || '; sent only while Complete / Has Discrepancy';
      return next;
      continue;
    end if;

    if v_doc is not null and rw.released_at is null then
      select 'outbox row ' || o2.id || ' (delivery ' || o2.delivery_id || ', status ' || o2.status || ')'
        into v_dup
        from public.priority_push_outbox o2
        join public.deliveries d2 on d2.id = o2.delivery_id
       where o2.id <> rw.id
         and o2.delivery_id <> rw.delivery_id
         and o2.target = rw.target   -- M1: a test row never holds a real one, nor the reverse
         and btrim(coalesce(d2.document_number, o2.document_number)) = v_doc
         and d2.created_at between rw.delivery_created_at - interval '90 days'
                               and rw.delivery_created_at + interval '90 days'
         and (o2.status in ('sent', 'unconfirmed', 'delivered', 'already_in_priority')
              or (o2.status in ('queued', 'waiting')
                  and (o2.queued_at, o2.id) < (rw.queued_at, rw.id)))
       order by o2.queued_at, o2.id
       limit 1;
      if v_dup is null and rw.target = 'make' then   -- M1: test rows never reach Priority
        select 'GR ' || g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?')
               || ', delivery ' || coalesce(g.delivery_id::text, 'none') || ')'
          into v_dup
          from public.priority_goods_receipts g
         where btrim(g.booknum) = v_doc
           and g.origin <> 'warehouse_bot'
           and g.delivery_id is distinct from rw.delivery_id
           and coalesce(g.curdate, g.synced_at) >= rw.delivery_created_at - interval '90 days'
         order by g.synced_at desc
         limit 1;
      end if;
      if v_dup is not null then
        decision := 'hold_same_invoice';
        reason   := 'supplier note ' || v_doc || ' is already in Priority or on its way under '
                    || v_dup || '; a second draft for the same BOOKNUM is never sent by itself.'
                    || ' Only if this is genuinely a second delivery of goods under the same note: '
                    || 'update public.priority_push_outbox set released_at = now() where id = ' || rw.id;
        return next;
        continue;
      end if;
    end if;

    if rw.released_at is null
       and (cfg.enabled_since is null or rw.queued_at < cfg.enabled_since) then
      decision := 'hold_pre_enable';
      reason   := 'queued ' || to_char(rw.queued_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
                  || ' (Israel) before the push was enabled ('
                  || coalesce(to_char(cfg.enabled_since at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI'),
                              'it is not enabled')
                  || '). To send it on purpose: update public.priority_push_outbox set released_at = now() where id = '
                  || rw.id;
      return next;
      continue;
    end if;

    v_cat := coalesce(rw.category, public.priority_push_delivery_category(rw.delivery_id));
    if v_cat is null or not (v_cat = any (cfg.categories)) then
      decision := 'hold_category';
      reason   := 'category ' || coalesce(v_cat, 'unknown') || ' is not in priority_push_config.categories '
                  || cfg.categories::text;
      return next;
      continue;
    end if;

    v_cat_since := (cfg.category_since ->> v_cat)::timestamptz;
    if rw.released_at is null
       and (v_cat_since is null or rw.queued_at < v_cat_since) then
      decision := 'hold_pre_category';
      reason   := 'queued ' || to_char(rw.queued_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
                  || ' (Israel) before category ' || v_cat || ' was switched on ('
                  || coalesce(to_char(v_cat_since at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI'),
                              'no switch-on time recorded')
                  || '). To send it on purpose: update public.priority_push_outbox set released_at = now() where id = '
                  || rw.id;
      return next;
      continue;
    end if;

    if not exists (select 1 from public.delivery_po_links l where l.delivery_id = rw.delivery_id)
       and rw.queued_at > now() - make_interval(mins => cfg.po_grace_minutes) then
      decision := 'wait_po';
      reason   := 'no purchase-order answer yet (no delivery_po_links row); waiting until '
                  || to_char((rw.queued_at + make_interval(mins => cfg.po_grace_minutes)) at time zone 'Asia/Jerusalem',
                             'HH24:MI') || ' (Israel)';
      return next;
      continue;
    end if;

    if v_evaluated >= c_batch then
      continue;
    end if;
    v_evaluated := v_evaluated + 1;

    v_failed  := null;
    v_ready   := false;
    v_reason  := null;
    v_codes   := null;
    v_guessed := null;
    begin
      v_body  := public.wb_gr_priority_body(rw.delivery_id);
      v_ready := coalesce((v_body ->> 'ready')::boolean, false);
      if not v_ready then
        v_reason := coalesce(v_body ->> 'not_ready_reason', 'not ready (no not_ready_reason given)');
        if jsonb_typeof(v_body -> 'unmapped_codes') = 'array' then
          v_codes := array(select jsonb_array_elements_text(v_body -> 'unmapped_codes'));
        end if;
      end if;

      -- 2026-10-04: only a mapping made for THIS supplier is trusted. 2026-10-12
      -- (M6): the resolver no longer guesses at all; the trusted methods are the
      -- linked order's line (po_line / po_manual) and the bookkeeper's mapping.
      select array_agg(distinct coalesce(l ->> 'SRC_CODE', '?'))
        into v_guessed
        from jsonb_array_elements(
               coalesce(public.wb_build_priority_gr_full(rw.delivery_id) -> 'TRANSORDER_P', '[]'::jsonb)) l
       where not public.priority_item_method_trusted(l ->> 'METHOD');
      if coalesce(cardinality(v_guessed), 0) > 0 then
        v_codes := array(select distinct c from unnest(coalesce(v_codes, '{}'::text[]) || v_guessed) c order by c);
        if v_ready then
          v_ready  := false;
          v_reason := 'items_unmapped';
        end if;
      end if;
    exception when others then
      v_failed := left(sqlerrm, 500);
    end;

    if v_failed is null and not v_ready and cfg.send_unready then
      -- 2026-10-05: the client asked for every receipt to reach his Make
      -- scenario; he fixes an unknown supplier / unmapped item in Priority.
      decision := 'send';
      reason   := 'sent although not ready (priority_push_config.send_unready): '
                  || coalesce(v_reason, '?')
                  || coalesce(' [' || array_to_string(v_codes, ', ') || ']', '');
      codes    := v_codes;
    elsif (v_failed is not null or not v_ready)
       and greatest(rw.queued_at, rw.released_at) < now() - make_interval(days => cfg.max_wait_days) then
      decision := 'expired';
      reason   := 'still not ready after ' || cfg.max_wait_days || ' days: '
                  || coalesce('error: ' || v_failed, v_reason);
      codes    := v_codes;
    elsif v_failed is not null then
      decision := 'error';
      reason   := v_failed;
    elsif not v_ready then
      decision := 'not_ready';
      reason   := v_reason;
      codes    := v_codes;
    else
      decision := 'send';
      reason   := 'ready (category ' || v_cat || ', every line mapped for this supplier)';
    end if;
    return next;
  end loop;
end
$function$;

CREATE OR REPLACE FUNCTION public.priority_push_explain(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  cfg           public.priority_push_config%rowtype;
  v_cfg_found   boolean;
  v_d_found     boolean;
  v_d_status    text;
  v_d_doc       text;
  v_d_created   timestamptz;
  v_d_chat      bigint;
  v_oid         bigint;
  v_ostatus     text;
  v_otarget     text;
  v_oqueued     timestamptz;
  v_oreleased   timestamptz;
  v_ocategory   text;
  v_odoc        text;
  v_oerror      text;
  v_queued_at   timestamptz;
  v_ref         text;
  v_env         text;
  v_is_test     boolean;
  v_target      text;
  v_test_url    text;
  v_gr          text;
  v_draft       text;
  v_doc         text;
  v_dup         text;
  v_cat         text;
  v_cat_since   timestamptz;
  v_full        jsonb;
  v_body        jsonb;
  v_ready       boolean := false;
  v_reason      text;
  v_codes       text[];
  v_guessed     text[];
  v_failed      text;
  v_supres      boolean := false;
  v_supname     text;
  v_vat         text;
  v_lines       jsonb := '[]'::jsonb;
  v_risk        jsonb := '[]'::jsonb;
  v_lines_err   text;                    -- set only when resolving the lines raised
  v_decision    text;
  v_hold        text;
  c_test_no_url constant text := 'skipped: test row not sent - priority_push_config.test_url is not set';  -- M1's dispatch text
begin
  select * into cfg from public.priority_push_config c where c.id = 1;
  v_cfg_found := found;
  v_test_url  := nullif(btrim(cfg.test_url), '');

  select dd.status::text, dd.document_number, dd.created_at, dd.received_by_chat_id
    into v_d_status, v_d_doc, v_d_created, v_d_chat
    from public.deliveries dd
   where dd.id = p_delivery_id;
  v_d_found := found;

  select o.id, o.status, o.target, o.queued_at, o.released_at, o.category,
         o.document_number, o.response_error
    into v_oid, v_ostatus, v_otarget, v_oqueued, v_oreleased, v_ocategory,
         v_odoc, v_oerror
    from public.priority_push_outbox o
   where o.delivery_id = p_delivery_id;

  v_queued_at := coalesce(v_oqueued, now());          -- no row yet: as if enqueued now
  v_ref       := coalesce(v_oid::text, '?');
  select u.env::text into v_env from public.users u where u.chat_id = v_d_chat;
  -- the row's target; no row yet: what M1's enqueue would give it
  v_target    := coalesce(v_otarget,
                          case when coalesce(v_env, 'Prod') = 'Test' and v_test_url is not null
                               then 'test' else 'make' end);
  v_is_test   := coalesce(v_env, 'Prod') = 'Test' or v_target = 'test';
  v_doc       := nullif(btrim(coalesce(v_d_doc, v_odoc)), '');

  -- readiness, exactly as plan() computes it (body first, then the builder)
  if v_d_found then
    begin
      v_body  := public.wb_gr_priority_body(p_delivery_id, 'invoice');
      v_ready := coalesce((v_body ->> 'ready')::boolean, false);
      if not v_ready then
        v_reason := coalesce(v_body ->> 'not_ready_reason', 'not ready (no not_ready_reason given)');
        if jsonb_typeof(v_body -> 'unmapped_codes') = 'array' then
          v_codes := array(select jsonb_array_elements_text(v_body -> 'unmapped_codes'));
        end if;
      end if;
      v_full := public.wb_build_priority_gr_full(p_delivery_id);
      -- plan()'s 2026-10-04 rule: only a mapping made for THIS supplier is trusted
      select array_agg(distinct coalesce(l ->> 'SRC_CODE', '?'))
        into v_guessed
        from jsonb_array_elements(coalesce(v_full -> 'TRANSORDER_P', '[]'::jsonb)) l
       where not public.priority_item_method_trusted(l ->> 'METHOD');
      if coalesce(cardinality(v_guessed), 0) > 0 then
        v_codes := array(select distinct c from unnest(coalesce(v_codes, '{}'::text[]) || v_guessed) c order by c);
        if v_ready then
          v_ready  := false;
          v_reason := 'items_unmapped';
        end if;
      end if;
    exception when others then
      v_failed := left(sqlerrm, 500);
    end;
  end if;

  -- supplier and per-line facts, from the client's own builder and resolver
  if v_full is not null then
    v_supres  := coalesce((v_full -> '_meta' ->> 'supplier_resolved')::boolean, false);
    v_supname := v_full ->> 'SUPNAME';
    v_vat     := v_full -> '_meta' ->> 'supplier_vat';
    v_cat     := coalesce(v_ocategory, public.priority_push_delivery_category(p_delivery_id));
    begin
      with li as (
        select di.id, di.item_code,
               coalesce(nullif(btrim(di.item_name_hebrew), ''), di.item_name_english) as name,
               r.partname, r.method, cp.unitname as item_unit,
               coalesce(nullif(lower(btrim(di.unit)), ''),
                        case when v_cat = 'meat' then 'kg' end) as our_unit,
               round(di.received_qty_kg, 3) as received,
               di.created_at
          from public.delivery_items di
          left join lateral public.wb_resolve_line(p_delivery_id, di.item_code, v_vat) r on true
          left join public.catalog_products cp on cp.partname = r.partname
         where di.receipt_id = p_delivery_id
      ), lr as (
        select li.*,
               -- English: item_unit ק'ג = kg; יח / יח' = units (the client's catalog unit names).
               case
                 when li.partname is null then 'no_item_defaults_kg'
                 when li.our_unit = 'unknown' then 'unit_unknown'
                 when li.our_unit is not null and li.our_unit <> 'kg'
                      and li.item_unit = 'ק''ג'                    then 'count_to_kg_item'
                 when li.our_unit = 'kg'
                      and li.item_unit in ('יח', 'יח''')          then 'kg_to_unit_item'
                 when li.our_unit in ('cartons', 'boxes', 'packs') then 'packs_not_units'
               end as unit_risk
          from li
      ), lj as (
        select lr.item_code, lr.created_at, lr.id, lr.unit_risk,
               jsonb_build_object(
                 'code', lr.item_code, 'name', lr.name, 'partname', lr.partname,
                 'source', lr.method, 'our_unit', lr.our_unit, 'item_unit', lr.item_unit,
                 'received', lr.received, 'unit_risk', lr.unit_risk) as line
          from lr
      )
      select coalesce(jsonb_agg(lj.line order by lj.item_code nulls last, lj.created_at, lj.id), '[]'::jsonb),
             coalesce(jsonb_agg(lj.line order by lj.item_code nulls last, lj.created_at, lj.id)
                        filter (where lj.unit_risk is not null), '[]'::jsonb)
        into v_lines, v_risk
        from lj;
    exception when others then
      -- unknown, not "nothing at risk": lines stays [], unit_risk_lines becomes JSON null and
      -- lines_error says why (a caller that needs the risk list must check lines_error)
      v_lines     := '[]'::jsonb;
      v_risk      := null;
      v_lines_err := left(sqlerrm, 500);
    end;
  end if;

  -- the decision: plan()'s order, plus the answers plan() cannot give
  select g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?') || ')'
    into v_gr
    from public.priority_goods_receipts g
   where g.delivery_id = p_delivery_id
     and g.origin <> 'warehouse_bot'
   order by g.synced_at desc
   limit 1;
  select g.docno
    into v_draft
    from public.priority_goods_receipts g
   where g.delivery_id = p_delivery_id
     and g.origin = 'warehouse_bot'
   limit 1;

  if v_gr is not null then
    v_decision := 'already_in_priority';
    v_hold     := 'Priority already has GR ' || v_gr;
  elsif v_draft is not null then
    v_decision := 'hold_local_draft';
    v_hold     := 'priority_goods_receipts has a local warehouse_bot row ' || v_draft
                  || '; held until it is synced (origin priority_push) or removed';
  elsif v_d_status is null or v_d_status not in ('Complete', 'Has Discrepancy') then
    v_decision := 'hold_not_closed';
    v_hold     := 'delivery status is now ' || coalesce(v_d_status, 'missing')
                  || '; sent only while Complete / Has Discrepancy';
  elsif (v_ostatus = 'skipped'
         and (v_oerror like 'skipped: Test user%' or v_oerror like 'skipped: test row not sent%'))
     or (v_oid is null and coalesce(v_env, 'Prod') = 'Test' and v_test_url is null) then
    v_decision := 'skipped_test';
    v_hold     := coalesce(case when v_ostatus = 'skipped' then v_oerror end,
                           'skipped: Test user ' || coalesce(v_d_chat::text, '?'));
  elsif not coalesce(v_cfg_found, false) or not cfg.enabled or nullif(btrim(cfg.url), '') is null then
    v_decision := 'disabled';
    v_hold     := 'the Priority push is switched off (priority_push_config.enabled is false or its url is empty); nothing is sent';
  end if;

  if v_decision is null and v_doc is not null and v_oreleased is null then
    select 'outbox row ' || o2.id || ' (delivery ' || o2.delivery_id || ', status ' || o2.status || ')'
      into v_dup
      from public.priority_push_outbox o2
      join public.deliveries d2 on d2.id = o2.delivery_id
     where o2.id is distinct from v_oid
       and o2.delivery_id <> p_delivery_id
       and o2.target = v_target   -- as M1's plan(): a test row never holds a real one, nor the reverse
       and btrim(coalesce(d2.document_number, o2.document_number)) = v_doc
       and d2.created_at between v_d_created - interval '90 days'
                             and v_d_created + interval '90 days'
       and (o2.status in ('sent', 'unconfirmed', 'delivered', 'already_in_priority')
            or (o2.status in ('queued', 'waiting')
                -- no row yet: a new row would sort after every existing one
                and (o2.queued_at, o2.id) < (v_queued_at, coalesce(v_oid, 9223372036854775807))))
     order by o2.queued_at, o2.id
     limit 1;
    if v_dup is null and v_target = 'make' then   -- as M1's plan(): test rows never reach Priority
      select 'GR ' || g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?')
             || ', delivery ' || coalesce(g.delivery_id::text, 'none') || ')'
        into v_dup
        from public.priority_goods_receipts g
       where btrim(g.booknum) = v_doc
         and g.origin <> 'warehouse_bot'
         and g.delivery_id is distinct from p_delivery_id
         and coalesce(g.curdate, g.synced_at) >= v_d_created - interval '90 days'
       order by g.synced_at desc
       limit 1;
    end if;
    if v_dup is not null then
      v_decision := 'hold_same_invoice';
      v_hold     := 'supplier note ' || v_doc || ' is already in Priority or on its way under '
                    || v_dup || '; a second draft for the same BOOKNUM is never sent by itself.'
                    || ' Only if this is genuinely a second delivery of goods under the same note: '
                    || 'update public.priority_push_outbox set released_at = now() where id = ' || v_ref;
    end if;
  end if;

  if v_decision is null and v_oreleased is null
     and (cfg.enabled_since is null or v_queued_at < cfg.enabled_since) then
    v_decision := 'hold_pre_enable';
    v_hold     := 'queued ' || to_char(v_queued_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
                  || ' (Israel) before the push was enabled ('
                  || coalesce(to_char(cfg.enabled_since at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI'),
                              'it is not enabled')
                  || '). To send it on purpose: update public.priority_push_outbox set released_at = now() where id = '
                  || v_ref;
  end if;

  if v_decision is null then
    v_cat := coalesce(v_ocategory, public.priority_push_delivery_category(p_delivery_id));
    if v_cat is null or not (v_cat = any (cfg.categories)) then
      v_decision := 'hold_category';
      v_hold     := 'category ' || coalesce(v_cat, 'unknown') || ' is not in priority_push_config.categories '
                    || cfg.categories::text;
    end if;
  end if;

  if v_decision is null then
    v_cat_since := (cfg.category_since ->> v_cat)::timestamptz;
    if v_oreleased is null and (v_cat_since is null or v_queued_at < v_cat_since) then
      v_decision := 'hold_pre_category';
      v_hold     := 'queued ' || to_char(v_queued_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
                    || ' (Israel) before category ' || v_cat || ' was switched on ('
                    || coalesce(to_char(v_cat_since at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI'),
                                'no switch-on time recorded')
                    || '). To send it on purpose: update public.priority_push_outbox set released_at = now() where id = '
                    || v_ref;
    end if;
  end if;

  if v_decision is null
     and not exists (select 1 from public.delivery_po_links l where l.delivery_id = p_delivery_id)
     and v_queued_at > now() - make_interval(mins => cfg.po_grace_minutes) then
    v_decision := 'wait_po';
    v_hold     := 'no purchase-order answer yet (no delivery_po_links row); waiting until '
                  || to_char((v_queued_at + make_interval(mins => cfg.po_grace_minutes)) at time zone 'Asia/Jerusalem',
                             'HH24:MI') || ' (Israel)';
  end if;

  if v_decision is null then
    if v_failed is null and not v_ready and cfg.send_unready then
      v_decision := 'send_unready';                   -- plan(): 'send', reason 'sent although not ready ...'
    elsif (v_failed is not null or not v_ready)
       and greatest(v_queued_at, v_oreleased) < now() - make_interval(days => cfg.max_wait_days) then
      v_decision := 'expired';
      v_hold     := 'still not ready after ' || cfg.max_wait_days || ' days: '
                    || coalesce('error: ' || v_failed, v_reason);
    elsif v_failed is not null then
      v_decision := 'error';
      v_hold     := 'error: ' || v_failed;
    elsif not v_ready then
      v_decision := 'not_ready';
      v_hold     := v_reason;
    else
      v_decision := 'send';
    end if;
  end if;

  -- M1's dispatch marks a target 'test' row skipped instead of sending it
  -- while test_url is not set.
  if v_decision in ('send', 'send_unready') and v_target = 'test' and v_test_url is null then
    v_decision := 'skipped_test';
    v_hold     := c_test_no_url;
  end if;

  return jsonb_build_object(
    'decision',          v_decision,
    'hold_reason',       left(v_hold, 1000),
    'ready',             (v_failed is null and v_ready),
    'supplier_resolved', v_supres,
    'supplier_supname',  v_supname,
    'lines',             v_lines,
    'unit_risk_lines',   v_risk,
    'lines_error',       v_lines_err,
    'unmapped_codes',    to_jsonb(coalesce(v_codes, '{}'::text[])),
    'not_ready_reason',  case when v_failed is not null then 'error: ' || v_failed else v_reason end,
    'is_test',           v_is_test,
    'outbox_id',         v_oid,
    'outbox_status',     v_ostatus);
end
$function$;

CREATE OR REPLACE FUNCTION public.wb_gr_po_balance(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  WITH pos AS (SELECT unnest(public.wb_delivery_po_numbers(p_delivery_id)) po),
  recv AS (
    SELECT (SELECT partname FROM public.wb_resolve_line(p_delivery_id, di.item_code,
              (SELECT s.vatnum FROM public.priority_suppliers s
               WHERE s.supname = public.wb_delivery_supname(p_delivery_id)))) partname,
           sum(coalesce(di.received_qty_kg,0)) received,
           sum(coalesce(di.invoice_qty_kg,0))  on_note
    FROM public.delivery_items di WHERE di.receipt_id = p_delivery_id
    GROUP BY 1
  ), j AS (
    SELECT l.po_number, l.line_no, l.item_code, l.description,
           l.ordered_qty, l.unit,
           coalesce(r.received,0) received,
           coalesce(r.on_note,0)  on_note,
           round(l.ordered_qty - coalesce(r.received,0), 3) remaining
    FROM public.open_purchase_order_lines l
    JOIN pos ON pos.po = l.po_number
    LEFT JOIN recv r ON r.partname = l.item_code
  )
  SELECT jsonb_build_object(
    'delivery_id', p_delivery_id,
    'needs_decision', (SELECT count(*) FROM j
                        WHERE remaining > 0
                          AND NOT public.wb_within_tolerance(ordered_qty, received)),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'po_number', po_number, 'line_no', line_no,
        'item_code', item_code, 'description', description,
        'ordered', ordered_qty, 'on_note', on_note, 'received', received,
        'remaining', remaining, 'unit', unit,
        'state', CASE
          WHEN received = 0                                       THEN 'nothing_received'
          WHEN public.wb_within_tolerance(ordered_qty, received)   THEN 'complete'
          WHEN remaining > 0                                       THEN 'short'
          ELSE 'over' END,
        -- the only question worth asking, and only when it is short
        'ask', CASE WHEN remaining > 0
                      AND NOT public.wb_within_tolerance(ordered_qty, received)
                    THEN 'יגיע בהמשך או לא יגיע?' END,
        'priority_line_status', CASE
          WHEN public.wb_within_tolerance(ordered_qty, received) THEN 'סופקה במלואה'
          WHEN remaining < 0                                      THEN 'סופקה בעודף'
          WHEN remaining > 0                                      THEN 'סופקה בחוסר'
          END)
      ORDER BY line_no) FROM j), '[]'::jsonb));
$function$;
