-- Tests for 2026-10-08-priority-push-04-resend-views.sql (M4).
-- Run ONLY through telegram-warehouse-bot/scripts/sql/run_sql_test.py, which wraps this file in
-- BEGIN … ROLLBACK: every fixture row below disappears. Each DO block raises on failure.
-- Nothing can reach Make or the bot: no row is committed and pg_net only sends committed queue
-- rows. The one queue row inserted here points at a closed local port; the bot webhook that M3's
-- trg_priority_push_outcome queues when mark_found sets 'delivered' is rolled back with the rest.
-- The fixture GR rows in the client's priority_goods_receipts use origin 'priority', so our
-- trg_bot_priority_receipt does nothing for them, and they are rolled back too.
-- Fixture note numbers all carry 990414 so they cannot collide with real notes.
-- The functions hold job 8's advisory lock until ROLLBACK: job 8 skips its ticks while this runs.
-- Hebrew in this file: בדיקה = "test"; פריט בדיקה = "test item"; טיוטא = "draft" (Priority status);
-- "שורה 1- - חסר מס' ספק" = "line 1 - missing supplier number" (Priority's supplier reject);
-- "שורה 2- כמות לא חוקית" = "line 2 - invalid quantity".

create temp table t14 (k text primary key, delivery_id uuid not null, outbox_id bigint);

create function pg_temp.t14_make(
  p_key text, p_doc text, p_supplier text, p_delivery_status text, p_created_at timestamptz,
  p_outbox_status text default null, p_status_code integer default null, p_body text default null,
  p_nrr text default null, p_sent_at timestamptz default null, p_request_id bigint default null)
returns uuid language plpgsql as $f$
declare
  v_d uuid;
  v_o bigint;
begin
  insert into public.deliveries (document_number, supplier_hebrew, status, created_at)
  values (p_doc, p_supplier, p_delivery_status::public.delivery_status, p_created_at)
  returning id into v_d;
  if p_outbox_status is not null then
    insert into public.priority_push_outbox
      (delivery_id, document_number, delivery_status, category, status, attempts, request_id,
       status_code, response_body, response_error, queued_at, sent_at, responded_at, not_ready_reason)
    values
      (v_d, p_doc, p_delivery_status, 'non_meat', p_outbox_status,
       case when p_sent_at is null then 0 else 1 end, p_request_id,
       p_status_code, p_body, p_body, coalesce(p_sent_at, p_created_at) - interval '10 seconds',
       p_sent_at, case when p_status_code is not null then p_sent_at end, p_nrr)
    returning id into v_o;
  end if;
  insert into t14 values (p_key, v_d, v_o);
  return v_d;
end
$f$;

create function pg_temp.t14_o(p_key text) returns bigint language sql as
  $f$ select outbox_id from t14 where k = p_key $f$;
create function pg_temp.t14_d(p_key text) returns uuid language sql as
  $f$ select delivery_id from t14 where k = p_key $f$;
create function pg_temp.t14_problems(p_key text) returns text language sql as $f$
  select string_agg(v.problem || ':' || coalesce(v.error_class, '-'), ',' order by v.problem)
    from public.priority_push_attention_v v
   where v.delivery_id = (select t.delivery_id from t14 t where t.k = p_key)
$f$;

-- ---------- fixtures ----------
do $$
declare
  c_sup  constant text := 'בדיקה 990414';                       -- English: test 990414; no Priority supplier has this name
  v_real text := (select s.supdes from public.priority_suppliers s
                   where nullif(btrim(s.supdes), '') is not null order by s.supname limit 1);
  v_q    bigint;
  v_d    uuid;
begin
  if v_real is null then raise exception 'T14 setup: priority_suppliers is empty'; end if;

  perform pg_temp.t14_make('queued', 'TQ-990414000101', c_sup, 'Complete', now() - interval '3 days', 'queued');
  update public.priority_push_outbox set hold_reason = 'T14 hold' where id = pg_temp.t14_o('queued');

  perform pg_temp.t14_make('gr', 'TQ-990414000102', c_sup, 'Complete', now() - interval '1 day', 'failed', 400,
                           '{"ok":false,"stage":"createLines","error":"T14 generic 400"}', null, now() - interval '1 hour');
  insert into public.priority_goods_receipts (doc, docno, delivery_id, booknum, origin, statdes)
  values (-990414102, 'GRT14990414102', pg_temp.t14_d('gr'), 'TQ-990414000102', 'priority', 'טיוטא');  -- English: draft

  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', 'http://127.0.0.1:9/t14-never-sent', '{}'::jsonb, null, 1000)
  returning id into v_q;
  perform pg_temp.t14_make('inflight', 'TQ-990414000103', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour', v_q);

  perform pg_temp.t14_make('accepted', 'TQ-990414000104', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour', 990414104);
  update public.priority_push_outbox
     set alerted_at = now(), alert_kind = 'unconfirmed', alert_tries = 2, unmapped_codes = array['T14A']
   where id = pg_temp.t14_o('accepted');

  perform pg_temp.t14_make('sib_a', '71:990414000105', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour');
  perform pg_temp.t14_make('sib_b', '71990414000105', c_sup, 'Complete', now() - interval '1 day', 'sent', null,
                           null, null, now() - interval '10 minutes');

  perform pg_temp.t14_make('sib_gr', '*990414000107*', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour');
  insert into public.priority_goods_receipts (doc, docno, delivery_id, booknum, origin, statdes)
  values (-990414107, 'GRT14990414107', null, '990414000107', 'priority', 'טיוטא');  -- English: draft

  perform pg_temp.t14_make('rej_sup', 'TQ-990414000108', c_sup, 'Complete', now() - interval '1 day', 'failed', 400,
    $j${"ok":false,"error":"Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס' ספק ","stage":"createHeader","form":"DOCUMENTS_P"}$j$,  -- English: line 1 - missing supplier number
    'sent although not ready (priority_push_config.send_unready): supplier_unmatched [T14S]', now() - interval '1 hour');

  v_d := pg_temp.t14_make('rej_items', 'TQ-990414000109', v_real, 'Complete', now() - interval '1 day', 'unconfirmed', 500,
    'Scenario failed to complete.',
    'sent although not ready (priority_push_config.send_unready): items_unmapped [T14-ITEM-990414]', now() - interval '1 hour');
  insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, invoice_qty_kg, received_qty_kg, unit)
  values (v_d, 'T14-ITEM-990414', 'פריט בדיקה', 5, 5, 'units');  -- English: test item

  perform pg_temp.t14_make('json_fail', 'TQ-990414000110', c_sup, 'Complete', now() - interval '1 day', 'failed', 400,
    $j${"ok":false,"stage":"createLines","error":"שורה 2- כמות לא חוקית"}$j$, null, now() - interval '1 hour', 990414110);  -- English: line 2 - invalid quantity

  perform pg_temp.t14_make('mf_unconf', 'TQ-990414000111', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 500,
                           'Scenario failed to complete.', null, now() - interval '1 hour', 990414111);

  -- same note (normalised '71990414000121'), the sibling queued BEFORE this row: blocks it
  perform pg_temp.t14_make('early_a', '71:990414000121', c_sup, 'Complete', now() - interval '1 hour', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour', 990414121);
  perform pg_temp.t14_make('early_b', '*71990414000121*', c_sup, 'Complete', now() - interval '1 day', 'queued');
  -- same note, but the sibling was queued AFTER this row (plan() would send this one first)
  perform pg_temp.t14_make('late_a', '71:990414000119', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour', 990414119);
  perform pg_temp.t14_make('late_b', '*71990414000119*', c_sup, 'Complete', now(), 'queued');
  -- same note, but the sibling is a test-harness row (target 'test' never holds a real one)
  perform pg_temp.t14_make('tgt_a', '71:990414000120', c_sup, 'Complete', now() - interval '1 day', 'unconfirmed', 200,
                           'Accepted', null, now() - interval '1 hour', 990414120);
  perform pg_temp.t14_make('tgt_b', '71990414000120', c_sup, 'Complete', now() - interval '1 day', 'sent', null,
                           null, null, now() - interval '10 minutes');
  update public.priority_push_outbox set target = 'test' where id = pg_temp.t14_o('tgt_b');
  perform pg_temp.t14_make('mf_delivered', 'TQ-990414000112', c_sup, 'Complete', now() - interval '1 day', 'delivered', 200,
                           '{"ok":true,"docno":"GRT14"}', null, now() - interval '1 hour');
  perform pg_temp.t14_make('mf_queued', 'TQ-990414000113', c_sup, 'Complete', now(), 'queued');

  perform pg_temp.t14_make('notq', 'TQ-990414000114', c_sup, 'Complete', now() - interval '1 day');

  perform pg_temp.t14_make('orph1', 'TQ-990414000115', c_sup, 'In Progress', now() - interval '3 days');
  perform pg_temp.t14_make('orph1_sib', '990414000115', c_sup, 'Complete', now() - interval '70 hours', 'delivered', 200,
                           '{"ok":true}', null, now() - interval '69 hours');
  perform pg_temp.t14_make('orph2', 'TQ-990414000116', c_sup, 'In Progress', now() - interval '3 hours');
  v_d := pg_temp.t14_make('orph3', 'TQ-990414000117', c_sup, 'In Progress', now() - interval '3 hours');
  insert into public.pallets (lpn, receipt_id, document_number, category)
  values ('T14-LPN-990414117', v_d, 'TQ-990414000117', 'meat');
  v_d := pg_temp.t14_make('orph4', 'TQ-990414000118', c_sup, 'In Progress', now() - interval '3 days');
  insert into public.priority_goods_receipts (doc, docno, delivery_id, booknum, origin, statdes)
  values (-990414118, 'GRT14990414118', v_d, 'TQ-990414000118', 'priority', 'טיוטא');  -- English: draft
end
$$;

-- ---------- priority_push_attention_v ----------
do $$
declare
  v_reason text;
begin
  if pg_temp.t14_problems('rej_sup') is distinct from 'failed:supplier_missing' then
    raise exception 'T14 view rej_sup: %', pg_temp.t14_problems('rej_sup');
  end if;
  if pg_temp.t14_problems('rej_items') is distinct from 'unconfirmed:make_crash' then
    raise exception 'T14 view rej_items: %', pg_temp.t14_problems('rej_items');
  end if;
  if pg_temp.t14_problems('sib_a') is distinct from 'unconfirmed:make_no_ok' then
    raise exception 'T14 view sib_a: %', pg_temp.t14_problems('sib_a');
  end if;
  if pg_temp.t14_problems('sib_b') is distinct from 'no_writeback:no_reply' then
    raise exception 'T14 view sib_b: %', pg_temp.t14_problems('sib_b');
  end if;
  if pg_temp.t14_problems('queued') is distinct from 'held:-' then
    raise exception 'T14 view queued: %', pg_temp.t14_problems('queued');
  end if;
  select v.reason_text into v_reason from public.priority_push_attention_v v
   where v.delivery_id = pg_temp.t14_d('queued');
  if v_reason is distinct from 'Held, not sent: T14 hold' then
    raise exception 'T14 view held reason: %', v_reason;
  end if;
  if pg_temp.t14_problems('gr') is distinct from 'failed:other' then
    raise exception 'T14 view gr: %', pg_temp.t14_problems('gr');
  end if;
  select v.reason_text into v_reason from public.priority_push_attention_v v
   where v.delivery_id = pg_temp.t14_d('gr');
  if v_reason not like 'Priority already has GRT14990414102 for this delivery.%' then
    raise exception 'T14 view gr reason: %', v_reason;
  end if;
  if pg_temp.t14_problems('notq') is distinct from 'not_queued:-' then
    raise exception 'T14 view notq: %', pg_temp.t14_problems('notq');
  end if;
  if pg_temp.t14_problems('orph1') is distinct from 'orphan_class1:-' then
    raise exception 'T14 view orph1: %', pg_temp.t14_problems('orph1');
  end if;
  if pg_temp.t14_problems('orph2') is distinct from 'orphan_class2:-' then
    raise exception 'T14 view orph2: %', pg_temp.t14_problems('orph2');
  end if;
  if pg_temp.t14_problems('orph3') is distinct from 'orphan_class3:-' then
    raise exception 'T14 view orph3: %', pg_temp.t14_problems('orph3');
  end if;
  -- never listed: a linked GR (class 4), a delivered row, a just-queued row, a closed sibling
  if pg_temp.t14_problems('orph4') is not null
     or pg_temp.t14_problems('mf_delivered') is not null
     or pg_temp.t14_problems('mf_queued') is not null
     or pg_temp.t14_problems('orph1_sib') is not null then
    raise exception 'T14 view lists a row it must not: orph4=% delivered=% queued=% sib=%',
      pg_temp.t14_problems('orph4'), pg_temp.t14_problems('mf_delivered'),
      pg_temp.t14_problems('mf_queued'), pg_temp.t14_problems('orph1_sib');
  end if;
end
$$;

-- grants: only service_role (the scanner API) may read the view or call the two functions
do $$
declare
  c_resend constant text := 'public.priority_push_resend(bigint,text,boolean,boolean,boolean,boolean)';
  c_found  constant text := 'public.priority_push_mark_found(bigint,text,text)';
  v_role   text;
begin
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    if has_table_privilege(v_role, 'public.priority_push_attention_v', 'SELECT')
       or has_function_privilege(v_role, c_resend, 'EXECUTE')
       or has_function_privilege(v_role, c_found, 'EXECUTE') then
      raise exception 'T14 grants: % can reach a new M4 object', v_role;
    end if;
  end loop;
  if not (has_table_privilege('service_role', 'public.priority_push_attention_v', 'SELECT')
          and has_function_privilege('service_role', c_resend, 'EXECUTE')
          and has_function_privilege('service_role', c_found, 'EXECUTE')) then
    raise exception 'T14 grants: service_role is missing a grant';
  end if;
end
$$;
-- the view really runs as service_role (security_invoker: every table and function it uses)
do $$
begin
  set local role service_role;
  perform count(*) from public.priority_push_attention_v;
  reset role;
end
$$;

-- ---------- priority_push_resend: every refusal ----------
do $$
declare
  r jsonb;
begin
  begin
    perform public.priority_push_resend(pg_temp.t14_o('accepted'), '  ', true, true);
    raise exception 'T14 resend: blank p_by accepted';
  exception when raise_exception then
    if sqlerrm not like 'priority_push_resend: p_by%' then raise; end if;
  end;

  r := public.priority_push_resend(-1, 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'not_resendable_status' then raise exception 'T14 missing row: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('queued'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'not_resendable_status' then raise exception 'T14 queued: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('mf_delivered'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'not_resendable_status' then raise exception 'T14 delivered: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('gr'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'already_in_priority' then raise exception 'T14 gr: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('inflight'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'request_in_flight' then raise exception 'T14 inflight: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('accepted'), 'test:t14', true, false);
  if r ->> 'refused' is distinct from 'checks_not_confirmed' then raise exception 'T14 checks 1: %', r; end if;
  r := public.priority_push_resend(pg_temp.t14_o('accepted'), 'test:t14', null, true);
  if r ->> 'refused' is distinct from 'checks_not_confirmed' then raise exception 'T14 checks 2: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('sib_a'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'sibling_in_flight' then raise exception 'T14 sibling outbox: %', r; end if;
  if r ->> 'detail' not like '%outbox ' || pg_temp.t14_o('sib_b') || ' sent%' then
    raise exception 'T14 sibling detail: %', r;
  end if;

  r := public.priority_push_resend(pg_temp.t14_o('sib_gr'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'sibling_in_flight' then raise exception 'T14 sibling GR: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('early_a'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'sibling_in_flight' then raise exception 'T14 earlier queued sibling: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('rej_sup'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'known_reject_supplier' then raise exception 'T14 known supplier: %', r; end if;

  r := public.priority_push_resend(pg_temp.t14_o('rej_items'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'known_reject_items' then raise exception 'T14 known items: %', r; end if;

  -- a refusal changes nothing
  if exists (select 1 from public.priority_push_attempts a
              where a.outbox_id in (select outbox_id from t14 where outbox_id is not null))
     or (select o.status from public.priority_push_outbox o where o.id = pg_temp.t14_o('accepted')) <> 'unconfirmed'
     or (select o.alert_tries from public.priority_push_outbox o where o.id = pg_temp.t14_o('accepted')) <> 2 then
    raise exception 'T14 a refusal wrote something';
  end if;
end
$$;

-- ---------- priority_push_resend: accept path ----------
do $$
declare
  r jsonb;
  a public.priority_push_attempts%rowtype;
  o public.priority_push_outbox%rowtype;
begin
  r := public.priority_push_resend(pg_temp.t14_o('accepted'), 'test:t14', true, true);
  if not (r ->> 'ok')::boolean or (r ->> 'attempt')::int <> 2 or r ->> 'refused' is not null then
    raise exception 'T14 accept: %', r;
  end if;

  select * into a from public.priority_push_attempts where outbox_id = pg_temp.t14_o('accepted');
  if a.reason is distinct from 'resend' or a.archived_by is distinct from 'test:t14'
     or a.status_code is distinct from 200 or a.response_body is distinct from '"Accepted"'::jsonb
     or a.request_id is distinct from 990414104 or a.attempt is distinct from 1
     or a.unmapped_codes is distinct from '["T14A"]'::jsonb or a.sent_at is null then
    raise exception 'T14 archive row: %', to_jsonb(a);
  end if;

  select * into o from public.priority_push_outbox where id = pg_temp.t14_o('accepted');
  if o.status <> 'queued' or o.next_check_at is not null or o.attempts <> 0
     or o.alerted_at is not null or o.alert_kind is not null or o.alert_tries <> 0
     or o.released_at is not null then
    raise exception 'T14 reset: %', to_jsonb(o);
  end if;

  -- a second click finds the row queued
  r := public.priority_push_resend(pg_temp.t14_o('accepted'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'not_resendable_status' then raise exception 'T14 double click: %', r; end if;

  -- the re-queued row is not "held": its clock restarted at the re-send
  if pg_temp.t14_problems('accepted') is not null then
    raise exception 'T14 view after resend: %', pg_temp.t14_problems('accepted');
  end if;

  -- another unconfirmed reply, another Send again: attempt 3, two archive rows
  update public.priority_push_outbox
     set status = 'unconfirmed', status_code = 500, response_body = 'Scenario failed to complete.',
         attempts = 1, request_id = 990414204
   where id = pg_temp.t14_o('accepted');
  r := public.priority_push_resend(pg_temp.t14_o('accepted'), 'test:t14b', true, true);
  if (r ->> 'attempt')::int <> 3
     or (select count(*) from public.priority_push_attempts where outbox_id = pg_temp.t14_o('accepted')) <> 2 then
    raise exception 'T14 second resend: %', r;
  end if;

  -- a JSON reply is archived as JSON
  r := public.priority_push_resend(pg_temp.t14_o('json_fail'), 'test:t14', true, true);
  if not (r ->> 'ok')::boolean
     or (select a2.response_body ->> 'stage' from public.priority_push_attempts a2
          where a2.outbox_id = pg_temp.t14_o('json_fail')) is distinct from 'createLines' then
    raise exception 'T14 json archive: %', r;
  end if;

  -- release guard: the sibling check is skipped and released_at is stamped
  r := public.priority_push_resend(pg_temp.t14_o('sib_a'), 'test:t14', true, true, true);
  if not (r ->> 'ok')::boolean
     or (select o2.released_at from public.priority_push_outbox o2 where o2.id = pg_temp.t14_o('sib_a')) is null then
    raise exception 'T14 release guard: %', r;
  end if;

  -- override: a known supplier reject may be sent again on purpose
  r := public.priority_push_resend(pg_temp.t14_o('rej_sup'), 'test:t14', true, true, false, true);
  if not (r ->> 'ok')::boolean then raise exception 'T14 override: %', r; end if;

  -- a same-note sibling queued AFTER this row does not block it (plan() sends the earlier one first)
  r := public.priority_push_resend(pg_temp.t14_o('late_a'), 'test:t14', true, true);
  if not (r ->> 'ok')::boolean then raise exception 'T14 later queued sibling blocked: %', r; end if;

  -- a test-harness sibling (target 'test') never blocks a real row
  r := public.priority_push_resend(pg_temp.t14_o('tgt_a'), 'test:t14', true, true);
  if not (r ->> 'ok')::boolean then raise exception 'T14 test-target sibling blocked: %', r; end if;
end
$$;

-- ---------- priority_push_mark_found ----------
do $$
declare
  r jsonb;
  a public.priority_push_attempts%rowtype;
begin
  r := public.priority_push_mark_found(pg_temp.t14_o('mf_unconf'), '  ', 'test:t14');
  if r ->> 'refused' is distinct from 'docno_invalid' then raise exception 'T14 mark blank: %', r; end if;
  r := public.priority_push_mark_found(pg_temp.t14_o('mf_unconf'), 'GR 26000999; drop', 'test:t14');
  if r ->> 'refused' is distinct from 'docno_invalid' then raise exception 'T14 mark junk: %', r; end if;

  r := public.priority_push_mark_found(pg_temp.t14_o('mf_delivered'), 'GR26000998', 'test:t14');
  if r ->> 'refused' is distinct from 'not_markable_status' then raise exception 'T14 mark delivered: %', r; end if;
  r := public.priority_push_mark_found(-1, 'GR26000998', 'test:t14');
  if r ->> 'refused' is distinct from 'not_markable_status' then raise exception 'T14 mark missing: %', r; end if;

  r := public.priority_push_mark_found(pg_temp.t14_o('inflight'), 'GR26000997', 'test:t14');
  if r ->> 'refused' is distinct from 'request_in_flight' then raise exception 'T14 mark inflight: %', r; end if;

  if (select o.status from public.priority_push_outbox o where o.id = pg_temp.t14_o('mf_unconf')) <> 'unconfirmed' then
    raise exception 'T14 a mark refusal changed the row';
  end if;

  r := public.priority_push_mark_found(pg_temp.t14_o('mf_unconf'), ' gr26000999 ', 'test:t14');
  if not (r ->> 'ok')::boolean or r ->> 'docno' <> 'GR26000999' or r ->> 'previous_status' <> 'unconfirmed' then
    raise exception 'T14 mark ok: %', r;
  end if;
  if (select o.status || '|' || o.not_ready_reason from public.priority_push_outbox o
       where o.id = pg_temp.t14_o('mf_unconf'))
     is distinct from 'delivered|confirmed by hand: Priority draft GR26000999 (test:t14)' then
    raise exception 'T14 mark row: %', (select to_jsonb(o) from public.priority_push_outbox o
                                         where o.id = pg_temp.t14_o('mf_unconf'));
  end if;
  select * into a from public.priority_push_attempts where outbox_id = pg_temp.t14_o('mf_unconf');
  if a.reason is distinct from 'mark_found' or a.archived_by is distinct from 'test:t14'
     or a.status_code is distinct from 500 then
    raise exception 'T14 mark archive: %', to_jsonb(a);
  end if;
  -- the client's mirror is never written (no wb_mark_gr_synced)
  if exists (select 1 from public.priority_goods_receipts g where g.delivery_id = pg_temp.t14_d('mf_unconf')) then
    raise exception 'T14 mark wrote priority_goods_receipts';
  end if;
  if pg_temp.t14_problems('mf_unconf') is not null then
    raise exception 'T14 view still lists a found row: %', pg_temp.t14_problems('mf_unconf');
  end if;

  -- a held (queued) row may be marked found
  r := public.priority_push_mark_found(pg_temp.t14_o('mf_queued'), 'GR26000996', 'test:t14');
  if not (r ->> 'ok')::boolean then raise exception 'T14 mark queued: %', r; end if;

  -- Send again, then Mark as found before job 8 re-sends: the same request_id is already
  -- archived (M2's archive helper skips it); it is kept once and nothing raises
  r := public.priority_push_mark_found(pg_temp.t14_o('accepted'), 'GR26000995', 'test:t14');
  if not coalesce((r ->> 'ok')::boolean, false) or r ->> 'previous_status' is distinct from 'queued'
     or (select count(*) from public.priority_push_attempts
          where outbox_id = pg_temp.t14_o('accepted')) <> 2 then
    raise exception 'T14 mark after resend: %', r;
  end if;

  -- a delivered row cannot be re-sent
  r := public.priority_push_resend(pg_temp.t14_o('mf_unconf'), 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'not_resendable_status' then raise exception 'T14 resend after mark: %', r; end if;
end
$$;

-- ---------- bot_unreachable: the office alert never reached the bot ----------
do $$
declare
  v_reason text;
begin
  perform pg_temp.t14_make('unreach', 'TQ-990414000123', 'בדיקה 990414', 'Complete', now() - interval '1 day', 'failed', 400,  -- English: test 990414
                           '{"ok":false,"stage":"createLines","error":"T14 generic 400"}', null, now() - interval '1 hour', 990414123);
  perform pg_temp.t14_make('retrying', 'TQ-990414000124', 'בדיקה 990414', 'Complete', now() - interval '1 day', 'failed', 400,  -- English: test 990414
                           '{"ok":false,"stage":"createLines","error":"T14 generic 400"}', null, now() - interval '1 hour', 990414124);
  -- 'unreach': 4 sends, all answered 502 (Railway's answer while the bot is mid-deploy): M3's retries used up
  update public.priority_push_outbox set alerted_at = now() - interval '5 minutes', alert_kind = 'failed', alert_tries = 3
   where id = pg_temp.t14_o('unreach');
  -- 'retrying': M3 is still retrying (alert_tries = 1): not listed yet
  update public.priority_push_outbox set alerted_at = now() - interval '1 minute', alert_kind = 'failed', alert_tries = 1
   where id = pg_temp.t14_o('retrying');
  insert into public.bot_webhook_log (event, delivery_id, outbox_id, kind, request_id, status_code, reply_error, created_at)
  values ('priority_push_outcome', pg_temp.t14_d('unreach'),  pg_temp.t14_o('unreach'),  'failed', -990414123, 502,
          'Bad Gateway', now() - interval '5 minutes'),
         ('priority_push_outcome', pg_temp.t14_d('retrying'), pg_temp.t14_o('retrying'), 'failed', -990414124, 502,
          'Bad Gateway', now() - interval '1 minute');
  if pg_temp.t14_problems('unreach') is distinct from 'bot_unreachable:-,failed:other' then
    raise exception 'T14 view unreach: %', pg_temp.t14_problems('unreach');
  end if;
  if pg_temp.t14_problems('retrying') is distinct from 'failed:other' then
    raise exception 'T14 view retrying: %', pg_temp.t14_problems('retrying');
  end if;
  select v.reason_text into v_reason from public.priority_push_attention_v v
   where v.delivery_id = pg_temp.t14_d('unreach') and v.problem = 'bot_unreachable';
  if v_reason not like 'The office alert (failed) for note TQ-990414000123 never reached the bot: it answered HTTP 502%' then
    raise exception 'T14 view unreach reason: %', v_reason;
  end if;
  if exists (select 1 from public.priority_push_attention_v v
              where v.delivery_id = pg_temp.t14_d('unreach') and v.problem = 'bot_unreachable'
                and (v.outbox_status is not null or v.gr_docno is not null or v.outbox_id is null)) then
    raise exception 'T14 view unreach: the bot_unreachable row must carry outbox_id but no outbox_status / gr_docno';
  end if;
  -- Send again resets the claim (alert_tries = 0): the bot_unreachable row goes away
  if not (public.priority_push_resend(pg_temp.t14_o('unreach'), 'test:t14', true, true) ->> 'ok')::boolean then
    raise exception 'T14 unreach: Send again refused';
  end if;
  if pg_temp.t14_problems('unreach') is not null then
    raise exception 'T14 view unreach after Send again: %', pg_temp.t14_problems('unreach');
  end if;
end
$$;

-- ---------- a delivery the client's GR sync reopens (his wb_apply_priority_gr) ----------
-- His wb_apply_priority_gr (read 2026-10-07) links a pulled Priority GR to our delivery by
-- BOOKNUM and sets deliveries.status 'In Progress' for a draft (טיוטא = draft) and 'Complete'
-- for a final one (סופית = final). After our push was delivered, that must never queue it again,
-- alert again, list it as an orphan or make it re-sendable. Simulated with the same two writes
-- his function makes; his function is not called (it depends on his field-map tables).
do $$
declare
  v_d uuid;
  v_o bigint;
  v_n integer;
  r   jsonb;
  e   jsonb;
begin
  -- this block calls the watch: keep every alert it might queue off the real bot URL
  update public.bot_webhook_config set url = 'https://priority-push-test.invalid/bot' where id;

  v_d := pg_temp.t14_make('reopen', 'TQ-990414000122', 'בדיקה 990414', 'Complete', now() - interval '3 days', 'delivered', 200,  -- English: test 990414
                          '{"ok":true,"reason":"created_draft","docno":"GRT14990414122"}', null, now() - interval '3 days');
  v_o := pg_temp.t14_o('reopen');
  update public.priority_push_outbox set alerted_at = now() - interval '3 days', alert_kind = 'delivered' where id = v_o;
  -- the pull: his GR row linked to our delivery, and the delivery re-opened as a draft
  insert into public.priority_goods_receipts (doc, docno, delivery_id, booknum, origin, statdes)
  values (-990414122, 'GRT14990414122', v_d, 'TQ-990414000122', 'priority', 'טיוטא');  -- English: draft
  update public.deliveries set status = 'In Progress' where id = v_d;
  select count(*) into v_n from public.bot_webhook_log where outbox_id = v_o or delivery_id = v_d;

  if pg_temp.t14_problems('reopen') is not null then
    raise exception 'T14 reopen (In Progress, GR linked) is listed: %', pg_temp.t14_problems('reopen');
  end if;
  r := public.priority_push_resend(v_o, 'test:t14', true, true);
  if r ->> 'refused' is distinct from 'not_resendable_status' then raise exception 'T14 reopen resend: %', r; end if;

  -- the draft is confirmed in Priority: his sync sets the delivery Complete again
  update public.deliveries set status = 'Complete' where id = v_d;
  perform public.priority_push_watch();
  if (select o.status from public.priority_push_outbox o where o.id = v_o) <> 'delivered'
     or (select count(*) from public.priority_push_outbox o where o.delivery_id = v_d) <> 1 then
    raise exception 'T14 reopen: the re-close re-queued the delivery: %',
      (select to_jsonb(o) from public.priority_push_outbox o where o.id = v_o);
  end if;
  if (select count(*) from public.bot_webhook_log where outbox_id = v_o or delivery_id = v_d) <> v_n then
    raise exception 'T14 reopen: the re-close or the watch alerted again';
  end if;
  e := public.priority_push_explain(v_d);
  if e ->> 'decision' in ('send', 'send_unready') then
    raise exception 'T14 reopen: explain would send it again: %', e ->> 'decision';
  end if;
  if pg_temp.t14_problems('reopen') is not null then
    raise exception 'T14 reopen (Complete again) is listed: %', pg_temp.t14_problems('reopen');
  end if;
end
$$;

-- ---------- a Test receiver's never-queued delivery is not an office problem (M3's digest rule) ----------
do $$
declare
  v_d uuid;
begin
  insert into public.users (chat_id, nickname, env) values (990414990414, 'zz-t14-test-receiver', 'Test');
  v_d := pg_temp.t14_make('notq_test', 'TQ-990414000125', 'בדיקה 990414', 'Complete', now() - interval '1 day');  -- English: test 990414
  update public.deliveries set received_by_chat_id = 990414990414 where id = v_d;
  if pg_temp.t14_problems('notq_test') is not null then
    raise exception 'T14 view lists a Test receiver''s never-queued delivery: %', pg_temp.t14_problems('notq_test');
  end if;
  if pg_temp.t14_problems('notq') is distinct from 'not_queued:-' then
    raise exception 'T14 view notq (Prod receiver) after the Test rule: %', pg_temp.t14_problems('notq');
  end if;
end
$$;

do $$ begin raise notice 'T14 priority-push-04 tests: all passed'; end $$;
