-- Tests for 2026-10-08-priority-push-02-outcomes-explain.sql (M2).
-- Run ONLY through scripts/sql/run_sql_test.py, which wraps this file in
-- BEGIN ... ROLLBACK: every fixture, config change and pg_net request below is
-- rolled back (pg_net sends only committed requests). Every URL used is on the
-- reserved .invalid TLD as a second guard. Never SELECT net.http_request_queue
-- .headers here: it holds the webhook secrets.

-- Same lock as job 8 (priority-push-dispatch): it skips its ticks until ROLLBACK,
-- so the dispatch calls below are never refused and never race it.
select pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

-- keep every real queued row out of this file's dispatch calls (as M1's test
-- does): plan() then sees only the fixtures below. Rolled back like the rest.
update public.priority_push_outbox
   set next_check_at = now() + interval '1 hour'
 where status in ('queued', 'waiting');

-- ===================== Part 1 (Task 6) =====================================

-- harmless destinations and a known config for this transaction only
update public.priority_push_config
   set url               = 'https://priority-push-test.invalid/make',
       test_url          = 'https://priority-push-test.invalid/fake-make',
       enabled           = true,
       send_unready      = true,
       po_grace_minutes  = 0,
       categories        = array['meat', 'non_meat']
 where id = 1;

-- Hebrew fixture text (glosses): זזזספקבדיקהזזז = "zzz test supplier zzz",
-- פריט בדיקה = "test item". Neither exists in the client's Priority mirror.
insert into public.users (chat_id, nickname, env)
values (990000000001, 'zz-m2-test-prod', 'Prod'),
       (990000000002, 'zz-m2-test-test', 'Test');

insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
values ('00000000-0000-4000-8000-000000000601', 'ZZT6-9900601', 'זזזספקבדיקהזזז', 990000000001, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000602', 'ZZT6-9900602', 'זזזספקבדיקהזזז', 990000000002, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000603', 'ZZT6-9900603', 'זזזספקבדיקהזזז', 990000000001, 'In Progress', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000604', 'ZZT6-9900604', 'זזזספקבדיקהזזז', 990000000002, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000605', 'ZZT6-9900605', 'זזזספקבדיקהזזז', 990000000001, 'Complete',    now() - interval '1 hour');

insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, unit, invoice_qty_kg, received_qty_kg)
select d, 'ZZT6-NOITEM', 'פריט בדיקה', 'units', 3, 3
  from unnest(array['00000000-0000-4000-8000-000000000601',
                    '00000000-0000-4000-8000-000000000602',
                    '00000000-0000-4000-8000-000000000603',
                    '00000000-0000-4000-8000-000000000604',
                    '00000000-0000-4000-8000-000000000605']::uuid[]) d;

-- 601: re-queued after an earlier "Accepted" (the never-left / hand re-queue path):
--      its old reply must be archived before the new send clears it.
-- 602: a Test row (target 'test') -> must go to test_url.
-- 603: delivery still In Progress -> plan() holds it (hold_not_closed).
-- 605: unconfirmed with a JSON reply: archive_reply idempotence (dispatch never touches it).
insert into public.priority_push_outbox
       (id, delivery_id, document_number, delivery_status, category, status, target,
        attempts, request_id, sent_at, responded_at, status_code, response_body,
        response_error, unmapped_codes)
values (990000601, '00000000-0000-4000-8000-000000000601', 'ZZT6-9900601', 'Complete', 'non_meat', 'queued', 'make',
        1, -990601, now() - interval '1 day', now() - interval '1 day', 200, 'Accepted',
        'HTTP 200 without the scenario''s {"ok":true} confirmation', array['ZZT6-NOITEM']),
       (990000602, '00000000-0000-4000-8000-000000000602', 'ZZT6-9900602', 'Complete', 'non_meat', 'queued', 'test',
        0, null, null, null, null, null, null, null),
       (990000603, '00000000-0000-4000-8000-000000000603', 'ZZT6-9900603', 'Complete', 'non_meat', 'queued', 'make',
        0, null, null, null, null, null, null, null),
       (990000605, '00000000-0000-4000-8000-000000000605', 'ZZT6-9900605', 'Complete', 'non_meat', 'unconfirmed', 'make',
        1, -990605, now() - interval '1 day', now() - interval '1 day', 500,
        '{"ok":false,"stage":"createHeader"}', 'Scenario failed', array['A1', 'B2']);

-- T6.1 the schema
do $t$
begin
  perform alerted_at, alert_kind, alert_tries, worker_notified_at, hold_reason, unit_risk_lines
     from public.priority_push_outbox limit 1;
  perform status_code, reply_error, outbox_id, kind from public.bot_webhook_log limit 1;
  perform id, outbox_id, attempt, request_id, sent_at, responded_at, status_code, response_body,
          response_error, not_ready_reason, unmapped_codes, archived_by, reason, created_at
     from public.priority_push_attempts limit 1;
  if (select alert_tries from public.priority_push_outbox where id = 990000602) is distinct from 0 then
    raise exception 'T6.1 alert_tries must default to 0';
  end if;
  if (select hold_unit_risk from public.priority_push_config where id = 1) is distinct from false then
    raise exception 'T6.1 priority_push_config.hold_unit_risk must default to false';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.priority_push_attempts'::regclass and contype = 'f'
                    and confrelid = 'public.priority_push_outbox'::regclass and confdeltype = 'c') then
    raise exception 'T6.1 priority_push_attempts.outbox_id must reference the outbox ON DELETE CASCADE';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.priority_push_attempts'::regclass) then
    raise exception 'T6.1 RLS must be on for priority_push_attempts';
  end if;
  raise notice 'T6.1 schema ok';
end
$t$;

-- T6.2 normalize_note_number
do $t$
begin
  if public.normalize_note_number('71:26189988') is distinct from '7126189988' then raise exception 'T6.2 71: prefix'; end if;
  if public.normalize_note_number('*200160*')    is distinct from '200160'     then raise exception 'T6.2 asterisks'; end if;
  if public.normalize_note_number(' IN264177998 ') is distinct from '264177998' then raise exception 'T6.2 letters + spaces'; end if;
  if public.normalize_note_number('01/002997')   is distinct from '01002997'   then raise exception 'T6.2 keeps leading zero'; end if;
  if public.normalize_note_number('')            is not null then raise exception 'T6.2 empty -> NULL'; end if;
  if public.normalize_note_number(null)          is not null then raise exception 'T6.2 NULL -> NULL'; end if;
  if public.normalize_note_number('ABC')         is not null then raise exception 'T6.2 no digits -> NULL'; end if;
  if (select provolatile from pg_proc where oid = 'public.normalize_note_number(text)'::regprocedure) <> 'i' then
    raise exception 'T6.2 normalize_note_number must be IMMUTABLE';
  end if;
  raise notice 'T6.2 normalize_note_number ok';
end
$t$;

-- T6.3 grants: nothing new is callable by PUBLIC / anon / authenticated
do $t$
declare
  f text;
begin
  foreach f in array array['public.normalize_note_number(text)',
                           'public.priority_push_archive_reply(bigint,text,text)',
                           'public.priority_push_dispatch()'] loop
    if (select proacl from pg_proc where oid = f::regprocedure) is null
       or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'T6.3 % is executable by PUBLIC', f;
    end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'T6.3 % is executable by anon/authenticated', f;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.normalize_note_number(text)', 'execute') then
    raise exception 'T6.3 service_role needs normalize_note_number (views call it)';
  end if;
  if has_function_privilege('service_role', 'public.priority_push_archive_reply(bigint,text,text)', 'execute') then
    raise exception 'T6.3 archive_reply is internal: no service_role grant';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.priority_push_archive_reply(bigint,text,text)'::regprocedure) then
    raise exception 'T6.3 archive_reply writes: it must be SECURITY DEFINER';
  end if;
  raise notice 'T6.3 grants ok';
end
$t$;

-- T6.4 priority_push_archive_reply keeps a reply once per request
do $t$
declare
  v1 integer;
  v2 integer;
  a  record;
begin
  v1 := public.priority_push_archive_reply(990000605, 'resend', 'admin:test');
  v2 := public.priority_push_archive_reply(990000605, 'resend', 'admin:test');
  if v1 is distinct from 1 then raise exception 'T6.4 first archive must return attempt 1, got %', v1; end if;
  if v2 is not null then raise exception 'T6.4 second archive of the same request must return NULL, got %', v2; end if;
  if (select count(*) from public.priority_push_attempts where outbox_id = 990000605) <> 1 then
    raise exception 'T6.4 exactly one archived row expected';
  end if;
  select * into a from public.priority_push_attempts where outbox_id = 990000605;
  if a.request_id <> -990605 or a.status_code <> 500 or a.response_body ->> 'stage' <> 'createHeader'
     or a.unmapped_codes <> '["A1", "B2"]'::jsonb or a.reason <> 'resend' or a.archived_by <> 'admin:test' then
    raise exception 'T6.4 archived row is wrong: %', row_to_json(a);
  end if;
  if public.priority_push_archive_reply(990000603, 'resend', 'admin:test') is not null then
    raise exception 'T6.4 a row that was never sent has nothing to archive';
  end if;
  -- M4's resend / mark_found insert their own rows: a second row for the same
  -- request must be accepted (no unique index), and archive_reply still skips it
  insert into public.priority_push_attempts (outbox_id, attempt, request_id, archived_by, reason)
  values (990000605, 1, -990605, 'admin:test', 'mark_found');
  if public.priority_push_archive_reply(990000605, 'resend', 'admin:test') is not null then
    raise exception 'T6.4 a request that already has rows must not be archived again';
  end if;
  raise notice 'T6.4 archive_reply ok';
end
$t$;

-- T6.5 dispatch: archive before overwrite, additive body keys, test routing, held rows
do $t$
declare
  o   record;
  a   record;
  q   record;
  v_b jsonb;
begin
  perform public.priority_push_dispatch();

  -- 601: the old "Accepted" reply survives in priority_push_attempts
  select * into a from public.priority_push_attempts where outbox_id = 990000601;
  if not found then raise exception 'T6.5 601: previous reply was not archived'; end if;
  if a.request_id <> -990601 or a.status_code <> 200 or a.response_body <> '"Accepted"'::jsonb
     or a.attempt <> 1 or a.reason <> 'reply_overwritten' or a.archived_by <> 'priority_push_dispatch'
     or a.unmapped_codes <> '["ZZT6-NOITEM"]'::jsonb then
    raise exception 'T6.5 601: archived row is wrong: %', row_to_json(a);
  end if;
  select * into o from public.priority_push_outbox where id = 990000601;
  if o.status <> 'sent' or o.request_id is null or o.request_id = -990601 or o.attempts <> 2
     or o.response_body is not null or o.hold_reason is not null then
    raise exception 'T6.5 601: not sent as expected: status %, request %, attempts %', o.status, o.request_id, o.attempts;
  end if;
  select q2.url, convert_from(q2.body, 'UTF8')::jsonb as body
    into q from net.http_request_queue q2 where q2.id = o.request_id;
  if not found then raise exception 'T6.5 601: no pg_net request %', o.request_id; end if;
  if q.url <> 'https://priority-push-test.invalid/make' then
    raise exception 'T6.5 601: posted to the wrong url %', q.url;
  end if;
  v_b := q.body;
  if (v_b ->> 'outbox_id')::bigint <> 990000601 or (v_b ->> 'attempt')::int <> 2
     or v_b ->> 'event' <> 'delivery_closed'
     or not (v_b ?& array['delivery_id', 'document_number', 'status', 'category',
                          'supplier_name', 'supplier_vat', 'received_by_chat_id']) then
    raise exception 'T6.5 601: body is wrong: %', v_b;
  end if;

  -- 602: target 'test' goes to test_url, first attempt
  select * into o from public.priority_push_outbox where id = 990000602;
  if o.status <> 'sent' then raise exception 'T6.5 602: Test row not sent (status %)', o.status; end if;
  select q2.url, convert_from(q2.body, 'UTF8')::jsonb as body
    into q from net.http_request_queue q2 where q2.id = o.request_id;
  if not found then raise exception 'T6.5 602: no pg_net request %', o.request_id; end if;
  if q.url <> 'https://priority-push-test.invalid/fake-make' or (q.body ->> 'attempt')::int <> 1 then
    raise exception 'T6.5 602: expected test_url and attempt 1, got % / %', q.url, q.body ->> 'attempt';
  end if;
  if exists (select 1 from public.priority_push_attempts where outbox_id = 990000602) then
    raise exception 'T6.5 602: a first send has nothing to archive';
  end if;

  -- 603: held, and now it says why
  select * into o from public.priority_push_outbox where id = 990000603;
  if o.status <> 'queued' or o.hold_reason is distinct from
     'delivery status is now In Progress; sent only while Complete / Has Discrepancy' then
    raise exception 'T6.5 603: hold_reason not recorded: % / %', o.status, o.hold_reason;
  end if;
  raise notice 'T6.5 dispatch ok';
end
$t$;

-- T6.6 a Test row while test_url is empty: M1's routing is kept unchanged
--      (skipped, nothing posted), and it carries no stale hold_reason
update public.priority_push_config set test_url = null where id = 1;
insert into public.priority_push_outbox (id, delivery_id, document_number, delivery_status, category, status, target, hold_reason)
values (990000604, '00000000-0000-4000-8000-000000000604', 'ZZT6-9900604', 'Complete', 'non_meat', 'queued', 'test',
        'stale hold text from an earlier tick');
do $t$
declare
  o record;
begin
  perform public.priority_push_dispatch();
  select * into o from public.priority_push_outbox where id = 990000604;
  if o.status <> 'skipped' or o.request_id is not null or o.hold_reason is not null
     or o.response_error is distinct from 'skipped: test row not sent - priority_push_config.test_url is not set' then
    raise exception 'T6.6 604: % / % / % / %', o.status, o.request_id, o.hold_reason, o.response_error;
  end if;
  raise notice 'T6.6 test row without test_url ok';
end
$t$;
update public.priority_push_config set test_url = 'https://priority-push-test.invalid/fake-make' where id = 1;
-- ===================== Part 2 (Task 7): priority_push_explain ===============

update public.priority_push_config
   set url               = 'https://priority-push-test.invalid/make',
       test_url          = 'https://priority-push-test.invalid/fake-make',
       enabled           = true,
       send_unready      = true,
       po_grace_minutes  = 0,
       categories        = array['meat', 'non_meat']
 where id = 1;

insert into public.users (chat_id, nickname, env)
values (990000000011, 'zz-m2-explain-prod', 'Prod'),
       (990000000012, 'zz-m2-explain-test', 'Test');

-- 701  Prod, unknown supplier, five lines covering every unit_risk rule
-- 711  an earlier delivery of note ZZT7-9900711, already delivered to Priority
-- 712  the same note again (spaces around it): plan() holds it, hold_same_invoice
-- 713  the same digits spelled differently: plan() matches notes exactly, so NOT held
-- 714  the same note again, Test receiver (target 'test'): M1's plan() never
--      lets a real row hold a test row (or the reverse), so NOT held
-- 721  Test receiver, routed to the fake Make (target 'test')
-- 722  Test receiver, row skipped at close (no test routing then)
-- 723  Test receiver, no outbox row yet
-- 731  Prod, closed, no outbox row and no category source
-- English: supplier_hebrew 'זזזספקבדיקהזזז' = "zzz test supplier zzz" (a made-up name).
insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
values ('00000000-0000-4000-8000-000000000701', 'ZZT7-9900701',     'זזזספקבדיקהזזז', 990000000011, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000711', 'ZZT7-9900711',     'זזזספקבדיקהזזז', 990000000011, 'Complete', now() - interval '1 day'),
       ('00000000-0000-4000-8000-000000000712', '  ZZT7-9900711 ',  'זזזספקבדיקהזזז', 990000000011, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000713', 'ZZT7:9900711',     'זזזספקבדיקהזזז', 990000000011, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000714', 'ZZT7-9900711',     'זזזספקבדיקהזזז', 990000000012, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000721', 'ZZT7-9900721',     'זזזספקבדיקהזזז', 990000000012, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000722', 'ZZT7-9900722',     'זזזספקבדיקהזזז', 990000000012, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000723', 'ZZT7-9900723',     'זזזספקבדיקהזזז', 990000000012, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000731', 'ZZT7-9900731',     'זזזספקבדיקהזזז', 990000000011, 'Complete', now() - interval '1 hour');

-- 701's lines. The real Priority items are picked from the client's item mirror
-- (read only): direct-method items, i.e. not any supplier's code in sku_crosswalk.
-- Glosses: לחם בדיקה = "test bread"; catalog unitname ק'ג = kg, יח = units.
insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, unit, invoice_qty_kg, received_qty_kg)
values ('00000000-0000-4000-8000-000000000701', 'ZZT7-NOITEM', 'לחם בדיקה', 'units', 5, 5);
insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, unit, invoice_qty_kg, received_qty_kg)
select '00000000-0000-4000-8000-000000000701', x.partname, x.label, x.unit, x.qty, x.qty
  from (select (select cp.partname from public.catalog_products cp
                 where cp.unitname = 'ק''ג'
                   and not exists (select 1 from public.sku_crosswalk s where s.supplier_sku = cp.partname)
                 order by cp.partname limit 1)            as partname,
               'kg item counted in units' as label, 'units' as unit, 7::numeric as qty
        union all
        select (select cp.partname from public.catalog_products cp
                 where cp.unitname = 'יח'
                   and not exists (select 1 from public.sku_crosswalk s where s.supplier_sku = cp.partname)
                 order by cp.partname limit 1),
               'unit item weighed in kg', 'kg', 2.5
        union all
        select (select cp.partname from public.catalog_products cp
                 where cp.unitname = 'יח'
                   and not exists (select 1 from public.sku_crosswalk s where s.supplier_sku = cp.partname)
                 order by cp.partname offset 1 limit 1),
               'unit item counted in cartons', 'cartons', 4
        union all
        select (select cp.partname from public.catalog_products cp
                 where cp.unitname = 'ק''ג'
                   and not exists (select 1 from public.sku_crosswalk s where s.supplier_sku = cp.partname)
                 order by cp.partname offset 1 limit 1),
               'kg item weighed in kg', 'kg', 10) x;
-- English: פריט בדיקה = "test item".
insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, unit, invoice_qty_kg, received_qty_kg)
select d, 'ZZT7-NOITEM', 'פריט בדיקה', 'units', 3, 3
  from unnest(array['00000000-0000-4000-8000-000000000711',
                    '00000000-0000-4000-8000-000000000712',
                    '00000000-0000-4000-8000-000000000713',
                    '00000000-0000-4000-8000-000000000714',
                    '00000000-0000-4000-8000-000000000721',
                    '00000000-0000-4000-8000-000000000722',
                    '00000000-0000-4000-8000-000000000723',
                    '00000000-0000-4000-8000-000000000731']::uuid[]) d;

insert into public.priority_push_outbox
       (id, delivery_id, document_number, delivery_status, category, status, target, response_error, queued_at)
values (990000701, '00000000-0000-4000-8000-000000000701', 'ZZT7-9900701',    'Complete', 'non_meat', 'queued',    'make', null, now()),
       (990000711, '00000000-0000-4000-8000-000000000711', 'ZZT7-9900711',    'Complete', 'non_meat', 'delivered', 'make', null, now() - interval '1 day'),
       (990000712, '00000000-0000-4000-8000-000000000712', '  ZZT7-9900711 ', 'Complete', 'non_meat', 'queued',    'make', null, now()),
       (990000713, '00000000-0000-4000-8000-000000000713', 'ZZT7:9900711',    'Complete', 'non_meat', 'queued',    'make', null, now()),
       (990000714, '00000000-0000-4000-8000-000000000714', 'ZZT7-9900711',    'Complete', 'non_meat', 'queued',    'test', null, now()),
       (990000721, '00000000-0000-4000-8000-000000000721', 'ZZT7-9900721',    'Complete', 'non_meat', 'queued',    'test', null, now()),
       (990000722, '00000000-0000-4000-8000-000000000722', 'ZZT7-9900722',    'Complete', 'non_meat', 'skipped',   'make',
        'skipped: Test user 990000000012', now());

-- T7.0 preconditions: the fixtures' notes are not live notes, the catalog had the items
do $t$
begin
  if exists (select 1 from public.deliveries
              where btrim(document_number) in ('ZZT7-9900701', 'ZZT7-9900711', 'ZZT7:9900711')
                and id not in ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711',
                               '00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000713',
                               '00000000-0000-4000-8000-000000000714')) then
    raise exception 'T7.0 a live delivery uses a fixture note number; pick other numbers';
  end if;
  if (select count(*) from public.delivery_items
       where receipt_id = '00000000-0000-4000-8000-000000000701' and item_code is not null) <> 5 then
    raise exception 'T7.0 the item mirror did not give the 4 fixture items';
  end if;
  raise notice 'T7.0 preconditions ok';
end
$t$;

-- T7.1 the function's shape and grants
do $t$
declare
  f text := 'public.priority_push_explain(uuid)';
begin
  if (select provolatile from pg_proc where oid = f::regprocedure) <> 's' then
    raise exception 'T7.1 explain must be STABLE';
  end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')
     or (select proacl from pg_proc where oid = f::regprocedure) is null
     or has_function_privilege('anon', f, 'execute')
     or has_function_privilege('authenticated', f, 'execute') then
    raise exception 'T7.1 explain must not be executable by PUBLIC / anon / authenticated';
  end if;
  if not has_function_privilege('service_role', f, 'execute') then
    raise exception 'T7.1 the scanner (service_role) must be able to call explain';
  end if;
  if not (select coalesce(proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
            from pg_proc where oid = f::regprocedure)
     or not (select prosecdef from pg_proc where oid = f::regprocedure) then
    raise exception 'T7.1 explain must be SECURITY DEFINER with search_path = public, pg_temp';
  end if;
  raise notice 'T7.1 shape ok';
end
$t$;

-- T7.2 an unready Prod delivery: send_unready, and every unit-risk rule
do $t$
declare
  e   jsonb := public.priority_push_explain('00000000-0000-4000-8000-000000000701');
  l   jsonb;
  k   text;
begin
  if not (e ?& array['decision', 'hold_reason', 'ready', 'supplier_resolved', 'supplier_supname',
                     'lines', 'unit_risk_lines', 'lines_error', 'unmapped_codes', 'not_ready_reason', 'is_test']) then
    raise exception 'T7.2 a contract key is missing: %', e;
  end if;
  -- normal path: the lines resolved, so lines_error is present and JSON null (a stable key set);
  -- the exception handler that fills it cannot be forced from here without touching the
  -- client's wb_* objects, so that branch is reviewed, not run.
  if jsonb_typeof(e -> 'lines_error') is distinct from 'null' or jsonb_typeof(e -> 'unit_risk_lines') <> 'array' then
    raise exception 'T7.2 lines_error must be JSON null and unit_risk_lines an array on the normal path: % / %',
      e -> 'lines_error', e -> 'unit_risk_lines';
  end if;
  if e ->> 'decision' <> 'send_unready' or (e ->> 'ready')::boolean or (e ->> 'supplier_resolved')::boolean
     or e ->> 'supplier_supname' is not null or e ->> 'not_ready_reason' <> 'supplier_unmatched'
     or e ->> 'hold_reason' is not null or (e ->> 'is_test')::boolean
     or (e ->> 'outbox_id')::bigint <> 990000701 or e ->> 'outbox_status' <> 'queued' then
    raise exception 'T7.2 header is wrong: %', e - 'lines' - 'unit_risk_lines';
  end if;
  if not (e -> 'unmapped_codes') ? 'ZZT7-NOITEM' then
    raise exception 'T7.2 the unmapped line must be listed: %', e -> 'unmapped_codes';
  end if;
  if jsonb_array_length(e -> 'lines') <> 5 or jsonb_array_length(e -> 'unit_risk_lines') <> 4 then
    raise exception 'T7.2 expected 5 lines / 4 unit-risk lines, got % / %',
      jsonb_array_length(e -> 'lines'), jsonb_array_length(e -> 'unit_risk_lines');
  end if;
  for l in select * from jsonb_array_elements(e -> 'lines') loop
    if not (l ?& array['code', 'name', 'partname', 'source', 'our_unit', 'item_unit', 'received', 'unit_risk']) then
      raise exception 'T7.2 a line key is missing: %', l;
    end if;
    -- English: לחם בדיקה = "test bread" (701's line with no Priority item).
    k := case l ->> 'name'
           when 'לחם בדיקה'                     then 'no_item_defaults_kg'
           when 'kg item counted in units'      then 'count_to_kg_item'
           when 'unit item weighed in kg'       then 'kg_to_unit_item'
           when 'unit item counted in cartons'  then 'packs_not_units'
           when 'kg item weighed in kg'         then null
         end;
    if l ->> 'unit_risk' is distinct from k then
      raise exception 'T7.2 line % expected unit_risk %, got %', l ->> 'name', k, l ->> 'unit_risk';
    end if;
  end loop;
  l := (select x from jsonb_array_elements(e -> 'lines') x where x ->> 'code' = 'ZZT7-NOITEM');
  if l ->> 'partname' is not null or l ->> 'source' is not null or l ->> 'item_unit' is not null
     or l ->> 'our_unit' <> 'units' or (l ->> 'received')::numeric <> 5 then
    raise exception 'T7.2 the no-item line is wrong: %', l;
  end if;
  l := (select x from jsonb_array_elements(e -> 'lines') x where x ->> 'name' = 'kg item weighed in kg');
  -- English: ק'ג = kg (the catalog's unit name).
  if l ->> 'source' <> 'direct' or l ->> 'item_unit' <> 'ק''ג' or l ->> 'partname' is null then
    raise exception 'T7.2 a direct kg item is wrong: %', l;
  end if;
  raise notice 'T7.2 unready Prod delivery ok';
end
$t$;

-- T7.3 same note already delivered -> hold_same_invoice; a differently spelt
--      note is NOT held (plan() matches the trimmed note exactly; pinned here);
--      a Test row is never held by a real row of the same note (M1's rule)
do $t$
declare
  e jsonb := public.priority_push_explain('00000000-0000-4000-8000-000000000712');
begin
  if e ->> 'decision' <> 'hold_same_invoice'
     or e ->> 'hold_reason' not like 'supplier note ZZT7-9900711 is already in Priority or on its way under outbox row 990000711 %' then
    raise exception 'T7.3 712 expected hold_same_invoice: % / %', e ->> 'decision', e ->> 'hold_reason';
  end if;
  if public.normalize_note_number('ZZT7:9900711') <> public.normalize_note_number('ZZT7-9900711') then
    raise exception 'T7.3 fixture: 713 must normalise like 711';
  end if;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000713');
  if e ->> 'decision' <> 'send_unready' then
    raise exception 'T7.3 713 (exact-match rule) expected send_unready, got %', e ->> 'decision';
  end if;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000714');
  if e ->> 'decision' <> 'send_unready' or not (e ->> 'is_test')::boolean then
    raise exception 'T7.3 714 (Test row, same note as a real row) expected send_unready, got % / %',
      e ->> 'decision', e ->> 'hold_reason';
  end if;
  raise notice 'T7.3 same-note hold ok';
end
$t$;

-- T7.4 explain says exactly what plan() decides, for every due fixture row
do $t$
declare
  p record;
  e jsonb;
  n integer := 0;
begin
  for p in select * from public.priority_push_plan() where outbox_id between 990000700 and 990000799 loop
    e := public.priority_push_explain(p.delivery_id);
    if p.decision = 'send' then
      -- (the CASE is in parentheses: PL/pgSQL ends an IF condition at the first THEN outside them)
      if e ->> 'decision' <> (case when p.reason like 'sent although not ready%' then 'send_unready' else 'send' end) then
        raise exception 'T7.4 outbox %: plan send (%), explain %', p.outbox_id, p.reason, e ->> 'decision';
      end if;
    elsif e ->> 'decision' <> p.decision
       or (e ->> 'hold_reason') is distinct from left(p.reason, 1000) then
      raise exception 'T7.4 outbox %: plan % / %, explain % / %',
        p.outbox_id, p.decision, p.reason, e ->> 'decision', e ->> 'hold_reason';
    end if;
    n := n + 1;
  end loop;
  if n < 5 then
    raise exception 'T7.4 expected at least 5 due fixture rows (701, 712, 713, 714, 721), got %', n;
  end if;
  raise notice 'T7.4 parity with plan() ok (% rows)', n;
end
$t$;

-- T7.5 Test receivers
do $t$
declare
  e jsonb;
begin
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000721');
  if not (e ->> 'is_test')::boolean or e ->> 'decision' <> 'send_unready' then
    raise exception 'T7.5 721 (target test, test_url set): % / %', e ->> 'is_test', e ->> 'decision';
  end if;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000722');
  if not (e ->> 'is_test')::boolean or e ->> 'decision' <> 'skipped_test'
     or e ->> 'hold_reason' <> 'skipped: Test user 990000000012' then
    raise exception 'T7.5 722 (skipped at close): % / %', e ->> 'decision', e ->> 'hold_reason';
  end if;
  -- 723 has no row: with test routing on it would be queued (then held: no category source)
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000723');
  if not (e ->> 'is_test')::boolean or e ->> 'decision' <> 'hold_category' or e -> 'outbox_id' <> 'null'::jsonb then
    raise exception 'T7.5 723 (no row, test_url set): % / %', e ->> 'decision', e -> 'outbox_id';
  end if;
  update public.priority_push_config set test_url = null where id = 1;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000723');
  if e ->> 'decision' <> 'skipped_test' or e ->> 'hold_reason' <> 'skipped: Test user 990000000012' then
    raise exception 'T7.5 723 (no row, no test_url): % / %', e ->> 'decision', e ->> 'hold_reason';
  end if;
  -- a queued target 'test' row with no test_url: M1's dispatch will mark it skipped
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000721');
  if e ->> 'decision' <> 'skipped_test'
     or e ->> 'hold_reason' <> 'skipped: test row not sent - priority_push_config.test_url is not set' then
    raise exception 'T7.5 721 (target test, no test_url): % / %', e ->> 'decision', e ->> 'hold_reason';
  end if;
  update public.priority_push_config set test_url = 'https://priority-push-test.invalid/fake-make' where id = 1;
  raise notice 'T7.5 Test receivers ok';
end
$t$;

-- T7.6 no outbox row, a missing delivery, the push switched off
do $t$
declare
  e jsonb;
begin
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000731');
  if e ->> 'decision' <> 'hold_category' or e -> 'outbox_id' <> 'null'::jsonb
     or e ->> 'hold_reason' not like 'category unknown is not in priority_push_config.categories%'
     or jsonb_array_length(e -> 'lines') <> 1 then
    raise exception 'T7.6 731 (no outbox row): %', e - 'lines' - 'unit_risk_lines';
  end if;
  e := public.priority_push_explain('00000000-0000-4000-8000-0000000007ff');
  if e ->> 'decision' <> 'hold_not_closed'
     or e ->> 'hold_reason' <> 'delivery status is now missing; sent only while Complete / Has Discrepancy'
     or e -> 'lines' <> '[]'::jsonb then
    raise exception 'T7.6 missing delivery: %', e;
  end if;
  update public.priority_push_config set enabled = false where id = 1;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000701');
  if e ->> 'decision' <> 'disabled' then
    raise exception 'T7.6 push off: expected disabled, got %', e ->> 'decision';
  end if;
  update public.priority_push_config set enabled = true where id = 1;
  raise notice 'T7.6 edge cases ok';
end
$t$;

-- the enabled false -> true flip above re-stamped enabled_since = now(); fixture
-- rows queued at now() are not before it, so nothing below is held for it.

-- T7.7 dispatch stores unit_risk_lines at send time, and a held row's
--      hold_reason equals explain's hold_reason
do $t$
declare
  o record;
  e jsonb;
begin
  perform public.priority_push_dispatch();
  select * into o from public.priority_push_outbox where id = 990000701;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000701');
  if o.status <> 'sent' or o.unit_risk_lines is null
     or o.unit_risk_lines <> e -> 'unit_risk_lines'
     or jsonb_array_length(o.unit_risk_lines) <> 4 then
    raise exception 'T7.7 701: status %, unit_risk_lines %', o.status, o.unit_risk_lines;
  end if;
  select * into o from public.priority_push_outbox where id = 990000712;
  e := public.priority_push_explain('00000000-0000-4000-8000-000000000712');
  if o.status <> 'queued' or o.hold_reason is null or o.hold_reason <> e ->> 'hold_reason' then
    raise exception 'T7.7 712: hold_reason % vs explain %', o.hold_reason, e ->> 'hold_reason';
  end if;
  raise notice 'T7.7 dispatch + explain agree ok';
end
$t$;

-- T7.8 a line whose note printed no unit (bot Task 16 stores 'unknown') is
--      flagged unit_unknown, whatever the Priority item's unit; a line with no
--      Priority item at all is still no_item_defaults_kg (that rule wins)
insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
values ('00000000-0000-4000-8000-000000000741', 'ZZT7-9900741', 'זזזספקבדיקהזזז', 990000000011, 'Complete', now() - interval '1 hour');
-- Gloss: the three labels are English on purpose; the supplier is "zzz test supplier zzz".
-- English: catalog unitname יח = units, ק'ג = kg.
insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, unit, invoice_qty_kg, received_qty_kg)
select '00000000-0000-4000-8000-000000000741', x.partname, x.label, 'unknown', 6, 6
  from (select (select cp.partname from public.catalog_products cp
                 where cp.unitname = 'יח'
                   and not exists (select 1 from public.sku_crosswalk s where s.supplier_sku = cp.partname)
                 order by cp.partname limit 1)            as partname,
               'unit item, no unit on the note'           as label
        union all
        select (select cp.partname from public.catalog_products cp
                 where cp.unitname = 'ק''ג'
                   and not exists (select 1 from public.sku_crosswalk s where s.supplier_sku = cp.partname)
                 order by cp.partname limit 1),
               'kg item, no unit on the note'
        union all
        select 'ZZT7-NOITEM', 'no item, no unit on the note') x;

do $t$
declare
  e jsonb := public.priority_push_explain('00000000-0000-4000-8000-000000000741');
  l jsonb;
  k text;
begin
  if jsonb_array_length(e -> 'lines') <> 3 or jsonb_array_length(e -> 'unit_risk_lines') <> 3 then
    raise exception 'T7.8 expected 3 lines / 3 unit-risk lines, got % / %',
      jsonb_array_length(e -> 'lines'), jsonb_array_length(e -> 'unit_risk_lines');
  end if;
  for l in select * from jsonb_array_elements(e -> 'lines') loop
    k := case l ->> 'name'
           when 'unit item, no unit on the note' then 'unit_unknown'
           when 'kg item, no unit on the note'   then 'unit_unknown'
           when 'no item, no unit on the note'   then 'no_item_defaults_kg'
         end;
    if l ->> 'unit_risk' is distinct from k or l ->> 'our_unit' is distinct from 'unknown' then
      raise exception 'T7.8 line % expected unit_risk % (our_unit unknown), got % / %',
        l ->> 'name', k, l ->> 'unit_risk', l ->> 'our_unit';
    end if;
  end loop;
  raise notice 'T7.8 unknown unit flagged ok';
end
$t$;
