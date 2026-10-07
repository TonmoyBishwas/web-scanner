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
