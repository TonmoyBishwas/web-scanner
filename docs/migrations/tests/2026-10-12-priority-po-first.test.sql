-- Tests for 2026-10-12-priority-po-first.sql (M6). Run with scripts/sql/run_sql_test.py
-- --setup <M6>: everything happens inside BEGIN ... ROLLBACK. Nothing here calls net.*; the
-- fixtures (a manual pick, a config change, a sync call) are rolled back with the migration.
-- Fixture deliveries (read only): 4492bfba = 251068650 M.B. Glatt, linked to PO26000008,
-- codes 101 / 550 / 2283; c3ce105f = 261058197 Glatt drumsticks 1472, no link.

-- T1 helpers
do $$ begin
  if public.wb_norm_sku(' 01135702 ') <> '1135702' then raise exception 'T1 norm_sku zeros'; end if;
  if public.wb_norm_sku('000') <> '0' then raise exception 'T1 norm_sku all zeros'; end if;
  if public.wb_norm_sku('  ') is not null then raise exception 'T1 norm_sku blank'; end if;
  if public.wb_jsonb_clean('{"a":null,"b":"","c":" ","d":0,"e":"x","f":[]}'::jsonb)
     <> '{"d":0,"e":"x","f":[]}'::jsonb then raise exception 'T1 jsonb_clean'; end if;
  if not public.priority_item_method_trusted('po_manual') or public.priority_item_method_trusted('sku')
     or public.priority_item_method_trusted(null) then raise exception 'T1 trusted'; end if;
  raise notice 'T1 helpers: ok';
end $$;

-- T2 no guessing: test rows gone, uni / direct gone
do $$ declare n int; r record; begin
  select count(*) into n from public.sku_crosswalk where source like 'warehouse_bot.test%';
  if n <> 0 then raise exception 'T2 test rows left: %', n; end if;
  -- '101' is mapped for other suppliers (water 715) — never for Glatt
  select * into r from public.wb_resolve_partname('101', '511740094');
  if r.partname is not null then raise exception 'T2 101 resolved for Glatt: %', r.partname; end if;
  -- '2137' is a PARTNAME; a supplier code equal to it is not an item any more ('direct')
  select * into r from public.wb_resolve_partname('2137', '511740094');
  if r.partname is not null then raise exception 'T2 direct still resolves'; end if;
  -- no VAT → nothing (step 3 needs VAT + SKU together)
  select * into r from public.wb_resolve_partname('1482', null);
  if r.partname is not null then raise exception 'T2 resolved without a VAT'; end if;
  select * into r from public.wb_resolve_partname('1482', '511740094');
  if r.partname is distinct from 'G15014' or r.method <> 'bookkeeper' then
    raise exception 'T2 bookkeeper 1482: % %', r.partname, r.method; end if;
  raise notice 'T2 no guessing: ok';
end $$;

-- T3 resolution order on a delivery linked to PO26000008
do $$ declare r record; d uuid := '4492bfba-6db1-4e6e-b9d9-2d9188c0917b'; begin
  select * into r from public.wb_resolve_line(d, '1461', '511740094');
  if r.partname <> 'G15016' or r.method <> 'po_line' or r.ordname <> 'PO26000008' or r.oline <> 1 then
    raise exception 'T3 po_line 1461: %', row_to_json(r); end if;
  select * into r from public.wb_resolve_line(d, '01461', '511740094');
  if r.partname is distinct from 'G15016' then raise exception 'T3 leading zero'; end if;
  select * into r from public.wb_resolve_line(d, '1482', '511740094');   -- not on the PO → bookkeeper
  if r.partname <> 'G15014' or r.method <> 'bookkeeper' or r.ordname is not null then
    raise exception 'T3 bookkeeper 1482: %', row_to_json(r); end if;
  select * into r from public.wb_resolve_line(d, '101', '511740094');
  if r.partname is not null then raise exception 'T3 101 should be unresolved: %', row_to_json(r); end if;
  -- a manual pick from the linked order
  insert into public.delivery_line_po_picks (delivery_id, supplier_sku, po_number, line_no, item_code, picked_by)
  values (d, '101', 'PO26000008', 2, 'G15012', 'test');
  select * into r from public.wb_resolve_line(d, '101', '511740094');
  if r.partname <> 'G15012' or r.method <> 'po_manual' or r.ordname <> 'PO26000008' or r.oline <> 2 then
    raise exception 'T3 po_manual: %', row_to_json(r); end if;
  -- a pick on an order that is not linked is ignored
  insert into public.delivery_line_po_picks (delivery_id, supplier_sku, po_number, line_no, item_code, picked_by)
  values (d, '550', 'PO26000004', 1, 'G15016', 'test');
  select * into r from public.wb_resolve_line(d, '550', '511740094');
  if r.partname is not null then raise exception 'T3 pick on unlinked PO honoured'; end if;
  -- step 1 beats a pick
  insert into public.delivery_line_po_picks (delivery_id, supplier_sku, po_number, line_no, item_code, picked_by)
  values (d, '1461', 'PO26000008', 3, 'G17013', 'test');
  select * into r from public.wb_resolve_line(d, '1461', '511740094');
  if r.method <> 'po_line' then raise exception 'T3 pick beat po_line'; end if;
  raise notice 'T3 resolution order: ok';
end $$;

-- T4 payload of 251068650 with the pick on 101 (still in this transaction)
do $$ declare b jsonb; p jsonb; l jsonb; n int; begin
  b := public.wb_gr_priority_body('4492bfba-6db1-4e6e-b9d9-2d9188c0917b', 'batch');
  p := b -> 'priority_payload';
  if p ->> 'ORDNAME' <> 'PO26000008' then raise exception 'T4 header ORDNAME: %', p ->> 'ORDNAME'; end if;
  if p ->> 'STATDES' <> 'טיוטא' or p ->> 'BOOKNUM' <> '251068650' or p ->> 'SUPNAME' is null then
    raise exception 'T4 header: %', p - 'TRANSORDER_P_SUBFORM'; end if;
  if jsonb_array_length(p -> 'TRANSORDER_P_SUBFORM') <> jsonb_array_length(b -> 'lines') then
    raise exception 'T4 line count'; end if;
  select l2 into l from jsonb_array_elements(p -> 'TRANSORDER_P_SUBFORM') l2 where l2 ->> 'SUPPARTNAME' = '101';
  if l ->> 'PARTNAME' <> 'G15012' or l ->> 'ORDNAME' <> 'PO26000008' or (l -> 'OLINE') <> '2'::jsonb
     or l ->> 'SERIALNAME' <> 'G15012-20261130' or l ->> 'EXPDATE' <> '2026-11-30'
     or jsonb_typeof(l -> 'TQUANT') <> 'number' or (l -> 'QUANT') <> (l -> 'TQUANT') or l ? 'TUNITNAME'
     or l ->> 'BOOKNUM' <> '251068650' then
    raise exception 'T4 picked line: %', l; end if;
  -- the two unpicked lines are unresolved: no PARTNAME, no lot, the supplier code goes
  select count(*) into n from jsonb_array_elements(p -> 'TRANSORDER_P_SUBFORM') l2
   where not l2 ? 'PARTNAME' and not l2 ? 'SERIALNAME' and not l2 ? 'EXPDATE' and l2 ? 'SUPPARTNAME';
  if n <> 2 then raise exception 'T4 unresolved lines: %', n; end if;
  raise notice 'T4 payload 251068650: %', p;
end $$;

-- T5 payload invariants on every closed / in-progress delivery of the last 60 days, both modes
do $$ declare rw record; b jsonb; p jsonb; bad text; n int := 0; m text; begin
  for rw in select id, document_number from public.deliveries where created_at > now() - interval '60 days' loop
    foreach m in array array['batch', 'invoice', 'carton'] loop
      b := public.wb_gr_priority_body(rw.id, m);
      p := b -> 'priority_payload';
      -- no null and no "" anywhere
      select string_agg(path, ', ') into bad from (
        with recursive t(path, v) as (
          select '$', p
          union all
          select t.path || '.' || coalesce(e.k, '[' || e.i || ']'), e.v
            from t, lateral (
              select k, null::bigint as i, v2 as v from jsonb_each(case when jsonb_typeof(t.v) = 'object' then t.v end) x(k, v2)
              union all
              select null, i - 1, v2 from jsonb_array_elements(case when jsonb_typeof(t.v) = 'array' then t.v end) with ordinality y(v2, i)) e)
        select path from t where jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '')) z;
      if bad is not null then raise exception 'T5 % % empty values at %', rw.document_number, m, bad; end if;
      if jsonb_array_length(p -> 'TRANSORDER_P_SUBFORM') <> jsonb_array_length(b -> 'lines') then
        raise exception 'T5 % % line count', rw.document_number, m; end if;
      -- only the client's keys
      select string_agg(distinct k, ',') into bad from jsonb_object_keys(p) k
       where k not in ('SUPNAME','BOOKNUM','CURDATE','STATDES','DETAILS','ORDNAME','TOWARHSNAME','TOLOCNAME','TRANSORDER_P_SUBFORM');
      if bad is not null then raise exception 'T5 % header keys %', rw.document_number, bad; end if;
      select string_agg(distinct k, ',') into bad
        from jsonb_array_elements(p -> 'TRANSORDER_P_SUBFORM') l, jsonb_object_keys(l) k
       where k not in ('PARTNAME','TQUANT','TUNITNAME','QUANT','SERIALNAME','EXPDATE','SUPPARTNAME','ORDNAME','OLINE',
                       'SUPNO','TOPALLETNAME','TOWARHSNAME','TOLOCNAME','BOOKNUM','IVDATE');
      if bad is not null then raise exception 'T5 % line keys %', rw.document_number, bad; end if;
      -- EXPDATE ⇔ SERIALNAME; ORDNAME ⇔ OLINE; numbers; dates
      select count(*) into n from jsonb_array_elements(p -> 'TRANSORDER_P_SUBFORM') l
       where (l ? 'EXPDATE') <> (l ? 'SERIALNAME') or (l ? 'ORDNAME') <> (l ? 'OLINE')
          or jsonb_typeof(l -> 'TQUANT') <> 'number'
          or (l ? 'OLINE' and jsonb_typeof(l -> 'OLINE') <> 'number')
          or (l ? 'EXPDATE' and l ->> 'EXPDATE' !~ '^\d{4}-\d{2}-\d{2}$')
          or (l ? 'IVDATE' and l ->> 'IVDATE' !~ '^\d{4}-\d{2}-\d{2}$');
      if n > 0 then raise exception 'T5 % % % bad lines', rw.document_number, m, n; end if;
    end loop;
  end loop;
  raise notice 'T5 payload invariants: ok over the last 60 days';
end $$;

-- T6 non-meat: batch falls back to the invoice lines
do $$ declare rw record; b jsonb; n int := 0; begin
  for rw in select d.id, d.document_number from public.deliveries d
             where public.priority_push_delivery_category(d.id) = 'non_meat'
               and d.status in ('Complete', 'Has Discrepancy') loop
    b := public.wb_gr_priority_body(rw.id, 'batch');
    if jsonb_array_length(b -> 'lines') = 0
       and jsonb_array_length(public.wb_gr_priority_body(rw.id, 'invoice') -> 'lines') > 0 then
      raise exception 'T6 % batch still empty', rw.document_number; end if;
    if b ->> 'lines_mode' <> 'invoice' then raise exception 'T6 % lines_mode %', rw.document_number, b ->> 'lines_mode'; end if;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'T6 no non-meat delivery found'; end if;
  raise notice 'T6 non-meat batch fallback: ok on % deliveries', n;
end $$;

-- T7 placeholder + legacy units (config rolled back)
do $$ declare p jsonb; l jsonb; begin
  update public.priority_push_config set placeholder_partname = 'TEST-PH', payload_units = 'legacy' where id = 1;
  p := public.wb_gr_priority_body('c3ce105f-6f8c-4ca3-bbca-1736b2730e52', 'batch') -> 'priority_payload';
  for l in select * from jsonb_array_elements(p -> 'TRANSORDER_P_SUBFORM') loop
    if l ->> 'PARTNAME' <> 'TEST-PH' or l ? 'SERIALNAME' or l ? 'EXPDATE' or l ? 'QUANT'
       or l ->> 'SUPPARTNAME' <> '1472' then
      raise exception 'T7 placeholder line: %', l; end if;
  end loop;
  if not (p -> 'TRANSORDER_P_SUBFORM' -> 0) ? 'TUNITNAME' then raise exception 'T7 legacy TUNITNAME missing'; end if;
  if p ? 'ORDNAME' then raise exception 'T7 header ORDNAME without a link'; end if;
  update public.priority_push_config set placeholder_partname = null, payload_units = 'kg_both' where id = 1;
  raise notice 'T7 placeholder + legacy units: ok (% lines)', jsonb_array_length(p -> 'TRANSORDER_P_SUBFORM');
end $$;

-- T8 our gates: explain trusts the pick, the unresolved stay unmapped; plan runs
do $$ declare x jsonb; n int; rw record; begin
  x := public.priority_push_explain('4492bfba-6db1-4e6e-b9d9-2d9188c0917b');
  select count(*) into n from jsonb_array_elements(x -> 'lines') l where l ->> 'source' = 'po_manual';
  if n <> 1 then raise exception 'T8 explain po_manual lines: % / %', n, x -> 'lines'; end if;
  if coalesce((x ->> 'ready')::boolean, false) then raise exception 'T8 ready with 2 unresolved lines'; end if;
  for rw in select id from public.deliveries where created_at > now() - interval '30 days' loop
    perform public.priority_push_explain(rw.id);
    perform public.wb_gr_po_balance(rw.id);
  end loop;
  perform * from public.priority_push_plan();
  raise notice 'T8 gates: ok';
end $$;

-- T9 the bookkeeper sync
do $$ declare j jsonb; r record; others int; begin
  j := public.wb_sync_bookkeeper_mappings(
         '[{"supplier_vat":"511740094","supplier_sku":"1471","internal_sku":"G15036","supplier_name":"Glatt"},
           {"supplier_vat":"511740094","supplier_sku":"1482","internal_sku":"G15014"},
           {"supplier_vat":"","supplier_sku":"9","internal_sku":"G1"}]'::jsonb);
  if (j ->> 'inserted')::int <> 1 or (j ->> 'skipped')::int <> 1 then raise exception 'T9 sync: %', j; end if;
  select * into r from public.wb_resolve_line('c3ce105f-6f8c-4ca3-bbca-1736b2730e52', '1471', '511740094');
  if r.partname is distinct from 'G15036' then raise exception 'T9 synced mapping not used'; end if;
  -- idempotent
  j := public.wb_sync_bookkeeper_mappings('[{"supplier_vat":"511740094","supplier_sku":"1471","internal_sku":"G15036"}]'::jsonb);
  if (j ->> 'inserted')::int <> 0 or (j ->> 'updated')::int <> 0 then raise exception 'T9 not idempotent: %', j; end if;
  -- full: every other proinvoce row goes
  select count(*) into others from public.sku_crosswalk where source = 'proinvoce.approved_mappings'
     and not (supplier_vat = '511740094' and supplier_sku in ('1471', '1482'));
  j := public.wb_sync_bookkeeper_mappings('[{"supplier_vat":"511740094","supplier_sku":"1471","internal_sku":"G15036"},
                                             {"supplier_vat":"511740094","supplier_sku":"1482","internal_sku":"G15014"}]'::jsonb, true);
  if (j ->> 'removed')::int <> others then raise exception 'T9 full removed % expected %', j ->> 'removed', others; end if;
  raise notice 'T9 bookkeeper sync: ok (full would remove %)', others;
end $$;

-- T10 unresolved cartons of different codes stay apart; 261058197 lines carry its code
do $$ declare n int; begin
  select count(*) into n from jsonb_array_elements(public.wb_gr_lines_by_batch('c3ce105f-6f8c-4ca3-bbca-1736b2730e52')) l
   where l ->> 'SRC_CODE' is distinct from '1472';
  if n > 0 then raise exception 'T10 lines without SRC_CODE 1472: %', n; end if;
  raise notice 'T10 batch lines carry SRC_CODE: ok';
end $$;
