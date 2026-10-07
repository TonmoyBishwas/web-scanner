-- =============================================================================
-- Tests for 2026-10-08-priority-push-05-units-shortage.sql (M5)
-- =============================================================================
-- Run by telegram-warehouse-bot/scripts/sql/run_sql_test.py, which wraps this
-- file (and the --setup migration) in BEGIN ... ROLLBACK. Nothing is committed.
--
--   before M5 is applied:  run_sql_test.py <this file> --setup <M5 file>
--   after  M5 is applied:  run_sql_test.py <this file>
--
-- Fixtures (all rolled back): one delivery_items row labelled 'M5TEST', with
-- no receipt. Nothing here calls net.* or touches a client object.
-- =============================================================================

-- T0 schema ---------------------------------------------------------------------
do $t$
declare
  c record;
begin
  for c in
    select * from (values
      ('delivery_items', 'pack_count',     'numeric', 'YES'),
      ('delivery_items', 'units_per_pack', 'numeric', 'YES'),
      ('delivery_items', 'count_source',   'text',    'NO'),
      ('delivery_items', 'gap_reason',     'text',    'YES'),
      ('delivery_items', 'gap_note',       'text',    'YES'),
      ('delivery_items', 'rest_expected',  'text',    'YES'),
      ('deliveries',     'invoice_date',   'date',    'YES')
    ) v(tbl, col, typ, nullable)
  loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = c.tbl
                      and column_name = c.col and data_type = c.typ
                      and is_nullable = c.nullable) then
      raise exception 'FAIL T0: %.% (% , nullable %) is missing or has the wrong type (M5 not applied?)',
        c.tbl, c.col, c.typ, c.nullable;
    end if;
  end loop;
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'delivery_items'
         and column_name = 'count_source') is distinct from '''counted''::text' then
    raise exception 'FAIL T0: delivery_items.count_source default is not ''counted''';
  end if;
  raise notice 'PASS T0 schema';
end
$t$;

-- T1 constraints and default ------------------------------------------------------
do $t$
declare
  v_id uuid;
  v_src text;
begin
  insert into public.delivery_items (label, item_name_hebrew, invoice_qty_kg, unit)
  values ('M5TEST', 'M5TEST', 1, 'units')
  returning id, count_source into v_id, v_src;
  if v_src is distinct from 'counted' then
    raise exception 'FAIL T1: a new line defaults to count_source %, expected counted', v_src;
  end if;

  update public.delivery_items
     set count_source = 'invoice_assumed', rest_expected = 'will_come',
         pack_count = 8, units_per_pack = 10, gap_reason = 'supplier_short', gap_note = 'free text'
   where id = v_id;

  begin
    update public.delivery_items set count_source = 'guessed' where id = v_id;
    raise exception 'FAIL T1: count_source accepted guessed';
  exception when check_violation then null;
  end;
  begin
    update public.delivery_items set rest_expected = 'maybe' where id = v_id;
    raise exception 'FAIL T1: rest_expected accepted maybe';
  exception when check_violation then null;
  end;
  begin
    update public.delivery_items set units_per_pack = 0 where id = v_id;
    raise exception 'FAIL T1: units_per_pack accepted 0';
  exception when check_violation then null;
  end;
  begin
    update public.delivery_items set pack_count = -1 where id = v_id;
    raise exception 'FAIL T1: pack_count accepted -1';
  exception when check_violation then null;
  end;
  begin
    update public.delivery_items set count_source = null where id = v_id;
    raise exception 'FAIL T1: count_source accepted NULL';
  exception when not_null_violation then null;
  end;
  raise notice 'PASS T1 constraints and default';
end
$t$;

-- T2 invoice_date: never outside the plausible window ------------------------------
do $t$
declare
  n int;
begin
  select count(*) into n
    from public.deliveries
   where invoice_date is not null
     and invoice_date not between created_at::date - 60 and created_at::date + 1;
  if n > 0 then
    raise exception 'FAIL T2: % delivery(ies) carry an invoice_date outside [created-60d, created+1d]', n;
  end if;
  raise notice 'PASS T2 no implausible invoice_date';
end
$t$;

-- T3 invoice_date: every plausible OCR date was backfilled (rows before 2026-10-07 12:00 UTC) --
do $t$
declare
  r record;
  d date;
  n_ok int := 0;
begin
  for r in
    select dl.id, dl.document_number, dl.invoice_date, dl.created_at, o.s
      from public.deliveries dl
      join lateral (
             select x.raw_ocr ->> 'invoice_date' as s
               from public.invoice_ocr_results x
              where x.delivery_id = dl.id
              order by x.created_at desc
              limit 1
           ) o on true
     where dl.created_at < '2026-10-07 12:00+00'
       and o.s ~ '^\d{4}-\d{2}-\d{2}$'
  loop
    begin
      d := r.s::date;
    exception when others then
      continue;                              -- not a real date: stays NULL
    end;
    continue when d not between r.created_at::date - 60 and r.created_at::date + 1;
    if r.invoice_date is distinct from d then
      raise exception 'FAIL T3: delivery % (%) has invoice_date %, OCR says %',
        r.id, r.document_number, r.invoice_date, d;
    end if;
    n_ok := n_ok + 1;
  end loop;
  -- 26 on the 2026-10-07 data; fewer once orphan deliveries are deleted.
  if n_ok = 0 then
    raise exception 'FAIL T3: no delivery has a plausible OCR date - the backfill query matched nothing';
  end if;
  raise notice 'PASS T3 % plausible OCR date(s) are on deliveries.invoice_date', n_ok;
end
$t$;

-- T4 the known cases ---------------------------------------------------------------
do $t$
declare
  c record;
  v date;
  found_any boolean;
begin
  for c in
    select * from (values
      ('1531277',    date '2026-09-09'),  -- note dated a week before receipt
      ('7126189988', date '2026-10-05'),  -- hummus, a day before receipt
      ('2606611',    null::date),         -- OCR misread 2023-09-26
      ('IN26012571', null::date)          -- OCR misread 2023-09-26
    ) v(doc, expected)
  loop
    found_any := false;
    for v in select invoice_date from public.deliveries where document_number = c.doc loop
      found_any := true;
      if v is distinct from c.expected then
        raise exception 'FAIL T4: note % has invoice_date %, expected %', c.doc, v, c.expected;
      end if;
    end loop;
    if not found_any then
      raise notice 'SKIP T4: note % no longer exists', c.doc;
    end if;
  end loop;
  raise notice 'PASS T4 known notes';
end
$t$;

-- T5 the backfill cannot queue or send anything -------------------------------------
-- (a) every UPDATE trigger on deliveries is column-scoped and none watches
--     invoice_date (trg_priority_push_enqueue is OF status; the canonicalizer is
--     OF supplier_hebrew, supplier_vat);
-- (b) no outbox / bot_webhook_log row was created in this transaction (a
--     default now() equals this transaction's start time exactly).
do $t$
declare
  v_trg text;
  n_outbox int;
  n_log int;
begin
  select string_agg(t.tgname, ', ') into v_trg
    from pg_trigger t
   where t.tgrelid = 'public.deliveries'::regclass
     and not t.tgisinternal
     and (t.tgtype & 16) <> 0
     and (coalesce(array_length(t.tgattr::int2[], 1), 0) = 0
          or (select a.attnum from pg_attribute a
               where a.attrelid = t.tgrelid and a.attname = 'invoice_date') = any (t.tgattr::int2[]));
  if v_trg is not null then
    raise exception 'FAIL T5: UPDATE trigger(s) on deliveries would fire on invoice_date: %', v_trg;
  end if;
  select count(*) into n_outbox from public.priority_push_outbox where queued_at = now();
  select count(*) into n_log    from public.bot_webhook_log      where created_at = now();
  if n_outbox + n_log > 0 then
    raise exception 'FAIL T5: this transaction created % outbox and % bot_webhook_log row(s)', n_outbox, n_log;
  end if;
  raise notice 'PASS T5 no trigger fires on invoice_date; nothing queued or logged';
end
$t$;

do $t$ begin raise notice 'ALL PASS 2026-10-08-priority-push-05-units-shortage'; end $t$;

-- >>> Task 14b: delivery_gaps_v tests
-- ---------- delivery_gaps_v (Task 14b) ----------
-- Hebrew here: בדיקה = "test"; חסר = "short"; לא נספר = "not counted"; תקין = "OK"; ישן = "old";
-- סופקה בחוסר = "supplied short" (the legacy per-delivery reason); טיוטא = "draft" (Priority status).
create temp table t14g (k text primary key, delivery_id uuid not null);

do $$
declare
  v_d uuid;
begin
  -- closed, one short line with a reason, one not-counted line, one clean line, and a GR
  insert into public.deliveries (document_number, supplier_hebrew, status)
  values ('TG-990414000201', 'בדיקה 990414', 'Has Discrepancy') returning id into v_d;
  insert into t14g values ('closed', v_d);
  insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, invoice_qty_kg, received_qty_kg,
                                     unit, discrepancy_status, gap_reason, gap_note, rest_expected, count_source)
  values (v_d, 'TG-SHORT', 'חסר', 40, 32, 'kg', 'Short', 'supplier_short', 'driver said tomorrow', 'will_come', 'counted'),
         (v_d, 'TG-ASSUMED', 'לא נספר', 10, 10, 'units', 'None', null, null, null, 'invoice_assumed'),
         (v_d, 'TG-CLEAN', 'תקין', 5, 5, 'kg', 'None', null, null, null, 'counted');
  insert into public.priority_goods_receipts (doc, docno, delivery_id, booknum, origin, statdes)
  values (-990414201, 'GRTG990414201', v_d, 'TG-990414000201', 'priority', 'טיוטא');

  -- legacy line: reason only in discrepancy_note; GR confirmed by hand on the outbox
  insert into public.deliveries (document_number, supplier_hebrew, status)
  values ('TG-990414000202', 'בדיקה 990414', 'Complete') returning id into v_d;
  insert into t14g values ('legacy', v_d);
  insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, invoice_qty_kg, received_qty_kg,
                                     unit, discrepancy_status, discrepancy_note)
  values (v_d, 'TG-LEGACY', 'ישן', 12, 9, 'kg', 'Short', 'סופקה בחוסר');
  insert into public.priority_push_outbox (delivery_id, document_number, delivery_status, category, status,
                                           not_ready_reason)
  values (v_d, 'TG-990414000202', 'Complete', 'non_meat', 'delivered',
          'confirmed by hand: Priority draft GR26000777 (admin:1)');

  -- closed and delivered to Priority: one line with a unit risk, one with no linked item, one clean
  insert into public.deliveries (document_number, supplier_hebrew, status)
  values ('TG-990414000204', 'בדיקה 990414', 'Complete') returning id into v_d;
  insert into t14g values ('flagged', v_d);
  insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, invoice_qty_kg, received_qty_kg,
                                     unit, discrepancy_status, count_source)
  values (v_d, 'TG-RISK', 'תקין', 6, 6, 'unknown', 'None', 'counted'),
         (v_d, 'TG-UNLINKED', 'תקין', 3, 3, 'units', 'None', 'counted'),
         (v_d, 'TG-FINE', 'תקין', 2, 2, 'kg', 'None', 'counted');
  insert into public.priority_push_outbox (delivery_id, document_number, delivery_status, category, status,
                                           unit_risk_lines, unmapped_codes)
  values (v_d, 'TG-990414000204', 'Complete', 'non_meat', 'delivered',
          '[{"code":"TG-RISK","unit_risk":"unit_unknown"}]'::jsonb, array['TG-UNLINKED']);

  -- still open: never listed
  insert into public.deliveries (document_number, supplier_hebrew, status)
  values ('TG-990414000203', 'בדיקה 990414', 'In Progress') returning id into v_d;
  insert into t14g values ('open', v_d);
  insert into public.delivery_items (receipt_id, item_code, invoice_qty_kg, received_qty_kg, unit, discrepancy_status)
  values (v_d, 'TG-OPEN', 10, 2, 'kg', 'Short');
end
$$;

do $$
declare
  v_rows text;
  g      record;
begin
  select string_agg(v.code, ',' order by v.code) into v_rows
    from public.delivery_gaps_v v where v.delivery_id = (select delivery_id from t14g where k = 'closed');
  if v_rows is distinct from 'TG-ASSUMED,TG-SHORT' then
    raise exception 'T14b gaps lines: %', v_rows;
  end if;

  select * into g from public.delivery_gaps_v v
   where v.delivery_id = (select delivery_id from t14g where k = 'closed') and v.code = 'TG-SHORT';
  if g.invoice_qty <> 40 or g.received_qty <> 32 or g.unit <> 'kg' or g.gap_reason <> 'supplier_short'
     or g.gap_note <> 'driver said tomorrow' or g.rest_expected <> 'will_come' or g.count_source <> 'counted'
     or g.gr_docno <> 'GRTG990414201' or g.gap_qty <> -8 or g.supplier <> 'בדיקה 990414' or g.name <> 'חסר' then
    raise exception 'T14b short line: %', to_jsonb(g);
  end if;

  select * into g from public.delivery_gaps_v v
   where v.delivery_id = (select delivery_id from t14g where k = 'legacy');
  if g.gap_reason is distinct from 'סופקה בחוסר' or g.gr_docno is distinct from 'GR26000777' then
    raise exception 'T14b legacy line: %', to_jsonb(g);
  end if;

  if exists (select 1 from public.delivery_gaps_v v where v.delivery_id = (select delivery_id from t14g where k = 'open')) then
    raise exception 'T14b lists an open delivery';
  end if;

  -- unit risk and unlinked items reach the view; a clean line of the same delivery does not
  select string_agg(v.code || ':' || coalesce(v.unit_risk, '-') || ':' || v.item_not_linked::text, ',' order by v.code)
    into v_rows
    from public.delivery_gaps_v v where v.delivery_id = (select delivery_id from t14g where k = 'flagged');
  if v_rows is distinct from 'TG-RISK:unit_unknown:false,TG-UNLINKED:-:true' then
    raise exception 'T14b flagged lines: %', v_rows;
  end if;
  -- lines with no outbox row carry no flags
  if exists (select 1 from public.delivery_gaps_v v
              where v.delivery_id = (select delivery_id from t14g where k = 'closed')
                and (v.unit_risk is not null or v.item_not_linked)) then
    raise exception 'T14b a line without an outbox row is flagged';
  end if;

  if has_table_privilege('anon', 'public.delivery_gaps_v', 'SELECT')
     or has_table_privilege('authenticated', 'public.delivery_gaps_v', 'SELECT')
     or has_table_privilege('public', 'public.delivery_gaps_v', 'SELECT')
     or not has_table_privilege('service_role', 'public.delivery_gaps_v', 'SELECT') then
    raise exception 'T14b grants on delivery_gaps_v are wrong';
  end if;
end
$$;

do $$
begin
  set local role service_role;
  perform count(*) from public.delivery_gaps_v;
  reset role;
end
$$;

-- R-A-M-7: a note whose push was skipped (test scan, pre-autofire) never reached Priority, so
-- there is nothing to fix in a draft: its lines are not listed. With a Priority GR on file they are.
-- Hebrew here: בדיקה = "test"; חסר = "short"; טיוטא = "draft" (Priority status).
do $$
declare
  v_d uuid;
begin
  -- closed, one Short line, outbox row 'skipped', no GR row: must NOT be listed
  insert into public.deliveries (document_number, supplier_hebrew, status)
  values ('TG-990414000205', 'בדיקה 990414', 'Complete') returning id into v_d;
  insert into t14g values ('skipped', v_d);
  insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, invoice_qty_kg, received_qty_kg,
                                     unit, discrepancy_status)
  values (v_d, 'TG-SKIPPED', 'חסר', 20, 15, 'kg', 'Short');
  insert into public.priority_push_outbox (delivery_id, document_number, delivery_status, category, status)
  values (v_d, 'TG-990414000205', 'Complete', 'non_meat', 'skipped');

  -- same, but a Priority GR exists for it: must be listed
  insert into public.deliveries (document_number, supplier_hebrew, status)
  values ('TG-990414000206', 'בדיקה 990414', 'Complete') returning id into v_d;
  insert into t14g values ('skipped_gr', v_d);
  insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, invoice_qty_kg, received_qty_kg,
                                     unit, discrepancy_status)
  values (v_d, 'TG-SKIPPEDGR', 'חסר', 20, 15, 'kg', 'Short');
  insert into public.priority_push_outbox (delivery_id, document_number, delivery_status, category, status)
  values (v_d, 'TG-990414000206', 'Complete', 'non_meat', 'skipped');
  insert into public.priority_goods_receipts (doc, docno, delivery_id, booknum, origin, statdes)
  values (-990414206, 'GRTG990414206', v_d, 'TG-990414000206', 'priority', 'טיוטא');
end
$$;

-- live counts the view returns today (the fixtures above are left out); the last figure is how many of
-- those lines sit on a skipped outbox row with no GR - 0 once R-A-M-7 is in the view
do $$
declare
  n_lines int;
  n_deliveries int;
  n_skipped int;
begin
  select count(*), count(distinct v.delivery_id) into n_lines, n_deliveries
    from public.delivery_gaps_v v
   where v.delivery_id not in (select delivery_id from t14g);
  select count(*) into n_skipped
    from public.delivery_gaps_v v
    join public.priority_push_outbox o on o.delivery_id = v.delivery_id
   where o.status = 'skipped' and v.gr_docno is null
     and v.delivery_id not in (select delivery_id from t14g);
  raise notice 'T14b live data (fixtures excluded): % line(s) in % delivery(ies); % on a skipped note with no GR',
    n_lines, n_deliveries, n_skipped;
end
$$;

do $$
begin
  if exists (select 1 from public.delivery_gaps_v v
              where v.delivery_id = (select delivery_id from t14g where k = 'skipped')) then
    raise exception 'T14b lists a line of a skipped note that never reached Priority';
  end if;
  if (select string_agg(v.code, ',' order by v.code) from public.delivery_gaps_v v
       where v.delivery_id = (select delivery_id from t14g where k = 'skipped_gr')) is distinct from 'TG-SKIPPEDGR' then
    raise exception 'T14b dropped the line of a skipped note that has a Priority GR';
  end if;
  raise notice 'PASS T14b skipped notes without a GR are not listed';
end
$$;

do $$ begin raise notice 'T14b delivery_gaps_v tests: all passed'; end $$;
-- <<< Task 14b: delivery_gaps_v tests
