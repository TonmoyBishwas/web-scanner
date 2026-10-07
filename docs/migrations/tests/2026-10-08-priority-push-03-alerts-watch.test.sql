-- Tests for 2026-10-08-priority-push-03-alerts-watch.sql (M3).
-- Run ONLY through scripts/sql/run_sql_test.py, which wraps this file in
-- BEGIN ... ROLLBACK: every fixture, config change and pg_net request below is
-- rolled back (pg_net sends only committed requests), and the bot webhook URL
-- is moved to the reserved .invalid TLD first as a second guard. Never SELECT
-- net.http_request_queue.headers' values here: they hold the webhook secret.
-- Fixtures: outbox ids 9900008xx (Task 8) / 9900009xx (Task 9), deliveries
-- 00000000-0000-4000-8000-0000000008xx / 9xx, note numbers ZZM3-*.

-- Job 8 and the watch take these locks on every tick: holding them makes the
-- real cron runs skip until ROLLBACK, so nothing here races them.
select pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));
select pg_advisory_xact_lock(hashtext('public.priority_push_watch'));

update public.bot_webhook_config set url = 'https://priority-push-test.invalid/bot' where enabled;

-- outcome alerts posted in THIS transaction for (outbox row, kind)
create function pg_temp.m3_sent(p_outbox bigint, p_kind text) returns integer
language sql as $$
  select count(*)::int
    from public.bot_webhook_log l
   where l.event = 'priority_push_outcome'
     and l.outbox_id = p_outbox and l.kind = p_kind
     and l.request_id is not null
     and l.created_at >= now()
$$;

-- the JSON body of the latest such alert, read from the uncommitted pg_net queue
create function pg_temp.m3_body(p_outbox bigint, p_kind text) returns jsonb
language sql as $$
  select convert_from(q.body, 'UTF8')::jsonb
    from public.bot_webhook_log l
    join net.http_request_queue q on q.id = l.request_id
   where l.event = 'priority_push_outcome'
     and l.outbox_id is not distinct from p_outbox and l.kind = p_kind
     and l.created_at >= now()
   order by l.id desc
   limit 1
$$;

-- ===================== Task 8: classifier, notify, outcome trigger ===========

-- T8.0 preconditions
do $t$
begin
  if to_regprocedure('public.priority_push_notify_bot(bigint,text,jsonb)') is null then
    raise exception 'T8.0 priority_push_notify_bot(bigint, text, jsonb) does not exist';
  end if;
  if not exists (select 1 from public.bot_webhook_config where enabled) then
    raise exception 'T8.0 no enabled bot_webhook_config row';
  end if;
  if not exists (select 1 from vault.secrets s join public.bot_webhook_config c
                     on c.secret_name = s.name where c.enabled) then
    raise exception 'T8.0 the bot webhook vault secret is missing';
  end if;
  raise notice 'T8.0 preconditions ok';
end
$t$;

-- T8.1 error_class: every Hebrew variant, every reply shape
-- Hebrew reply texts below: "שורה 1- - חסר מס' ספק" = "line 1 - missing supplier
-- number"; "חסר מק"ט" = "missing item number (SKU)"; "הכנסה לקובץ נכשלה" =
-- "writing to the file failed" (Priority already has the document).
do $t$
declare
  c   record;
  got text;
begin
  for c in
    select * from (values
      ('45/49 live body, ASCII apostrophe', 'failed', 400,
       '{"ok":false,"error":"Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס'' ספק ","stage":"createHeader","form":"DOCUMENTS_P"}',
       '{"ok":false,"error":"Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס'' ספק ","stage":"createHeader","form":"DOCUMENTS_P"}',
       'supplier_missing'),
      ('supplier, geresh', 'failed', 400,
       '{"ok":false,"error":"[400] שורה 1- - חסר מס׳ ספק","stage":"createHeader"}', null, 'supplier_missing'),
      ('supplier, plain text, ASCII apostrophe', 'failed', 400,
       null, 'שורה 1- - חסר מס'' ספק', 'supplier_missing'),
      ('item, ASCII quote JSON-escaped', 'unconfirmed', 500,
       '{"ok":false,"error":"[400] שורה 2 - חסר מק\"ט","stage":"createLine"}', null, 'item_missing'),
      ('item, ASCII quote plain text', 'failed', 400,
       null, 'שורה 2 - חסר מק"ט', 'item_missing'),
      ('item, gershayim', 'failed', 400,
       '{"ok":false,"error":"שורה 2 - חסר מק״ט","stage":"createLine"}', null, 'item_missing'),
      ('already in Priority', 'failed', 400,
       '{"ok":false,"error":"שורה 1- הכנסה לקובץ נכשלה","stage":"createHeader"}', null, 'already_in_priority'),
      ('46/47 Make 500', 'unconfirmed', 500,
       'Scenario failed to complete.', 'Scenario failed to complete.', 'make_crash'),
      ('53/54 Accepted', 'unconfirmed', 200,
       'Accepted', 'HTTP 200 without the scenario''s {"ok":true} confirmation (body in response_body); it may have created a Priority draft - check Priority before re-sending',
       'make_no_ok'),
      ('2xx ok:false, no Hebrew', 'unconfirmed', 200,
       '{"ok":false,"stage":"filter"}', null, 'make_no_ok'),
      ('120 s timeout', 'unconfirmed', null,
       null, 'Timeout of 120000 ms reached. Total time: 120001 ms', 'no_reply'),
      ('no reply row after 10 min', 'unconfirmed', null,
       null, 'no reply read back 00:10:00 after sending (pg_net request 9 has no reply row and is no longer queued); it may have reached the webhook - check Priority before re-sending',
       'no_reply'),
      ('still sent, nothing back', 'sent', null, null, null, 'no_reply'),
      ('never left after 3 tries', 'failed', null, null, 'Couldn''t resolve host name', 'other'),
      ('400, unknown text', 'failed', 400, '{"ok":false,"error":"something else"}', null, 'other'),
      ('expired, never sent', 'expired', null, null, null, null),
      ('delivered', 'delivered', 200, '{"ok":true,"docno":"GR1"}', null, null)
    ) v(label, st, code, body, err, want)
  loop
    got := public.priority_push_error_class(c.st, c.code, c.body, c.err);
    if got is distinct from c.want then
      raise exception 'T8.1 error_class(%): got %, want %', c.label, got, c.want;
    end if;
  end loop;
  if (select provolatile from pg_proc
       where oid = 'public.priority_push_error_class(text,integer,text,text)'::regprocedure) <> 's' then
    raise exception 'T8.1 priority_push_error_class must be STABLE';
  end if;
  raise notice 'T8.1 error_class ok (17 cases)';
end
$t$;

-- fixtures for T8.2-T8.6 (supplier זזזספקבדיקהזזז = "zzz test supplier zzz")
insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
values ('00000000-0000-4000-8000-000000000801', 'ZZM3-801', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000802', 'ZZM3-802', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000803', 'ZZM3-803', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000804', 'ZZM3-804', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000805', 'ZZM3-805', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour');

-- 801: sent -> failed (supplier missing).   802: sent -> unconfirmed -> delivered.
-- 803: waiting -> expired.                  804: sent -> queued (not an outcome).
-- 805: sent -> failed while the bot webhook config is switched off.
insert into public.priority_push_outbox
       (id, delivery_id, document_number, delivery_status, category, status, target,
        attempts, request_id, sent_at, queued_at)
values (990000801, '00000000-0000-4000-8000-000000000801', 'ZZM3-801', 'Complete', 'non_meat', 'sent',    'make', 1, -990801, now() - interval '1 minute', now() - interval '2 minutes'),
       (990000802, '00000000-0000-4000-8000-000000000802', 'ZZM3-802', 'Complete', 'non_meat', 'sent',    'make', 1, -990802, now() - interval '1 minute', now() - interval '2 minutes'),
       (990000803, '00000000-0000-4000-8000-000000000803', 'ZZM3-803', 'Complete', 'non_meat', 'waiting', 'make', 0, null,    null,                       now() - interval '8 days'),
       (990000804, '00000000-0000-4000-8000-000000000804', 'ZZM3-804', 'Complete', 'non_meat', 'sent',    'make', 1, -990804, now() - interval '1 minute', now() - interval '2 minutes'),
       (990000805, '00000000-0000-4000-8000-000000000805', 'ZZM3-805', 'Complete', 'non_meat', 'sent',    'make', 1, -990805, now() - interval '1 minute', now() - interval '2 minutes');

-- T8.2 a new outcome posts exactly one alert, with the contract body
do $t$
declare
  b jsonb;
begin
  -- English: the reply below ends "line 1 - missing supplier number" (the live 45/49 text)
  update public.priority_push_outbox
     set status = 'failed', status_code = 400,
         response_body = '{"ok":false,"error":"Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס'' ספק ","stage":"createHeader","form":"DOCUMENTS_P"}',
         response_error = 'Supplier inactive or Priority validation failed: [400] שורה 1- - חסר מס'' ספק',
         unmapped_codes = array['1003', '1079']
   where id = 990000801;

  if pg_temp.m3_sent(990000801, 'failed') <> 1 then
    raise exception 'T8.2 % alerts for the failed transition, want 1', pg_temp.m3_sent(990000801, 'failed');
  end if;
  if not exists (select 1 from public.priority_push_outbox
                  where id = 990000801 and alert_kind = 'failed' and alerted_at is not null and alert_tries = 0) then
    raise exception 'T8.2 the row was not claimed (alert_kind / alerted_at / alert_tries)';
  end if;

  b := pg_temp.m3_body(990000801, 'failed');
  if b ->> 'event' is distinct from 'priority_push_outcome'
     or b ->> 'kind' is distinct from 'failed'
     or (b ->> 'outbox_id')::bigint is distinct from 990000801
     or (b ->> 'delivery_id')::uuid is distinct from '00000000-0000-4000-8000-000000000801'::uuid
     or b ->> 'document_number' is distinct from 'ZZM3-801'
     or b ->> 'supplier' is distinct from (select supplier_hebrew from public.deliveries
                                            where id = '00000000-0000-4000-8000-000000000801')
     or b ->> 'status' is distinct from 'failed'
     or (b ->> 'status_code')::int is distinct from 400
     or b ->> 'stage' is distinct from 'createHeader'
     or b ->> 'error_class' is distinct from 'supplier_missing'
     -- English: חסר = "missing" (the Hebrew error text must reach error_text)
     or position('חסר' in coalesce(b ->> 'error_text', '')) = 0
     or b -> 'unmapped_codes' is distinct from '["1003", "1079"]'::jsonb
     or (b ->> 'received_by_chat_id')::bigint is distinct from 990000000081
     or b ->> 'is_test' is distinct from 'false' then
    raise exception 'T8.2 body wrong: %', b;
  end if;
  if not (b ?& array['supplier_vat', 'category', 'unit_risk_lines', 'not_ready_reason',
                     'hold_reason', 'gr_docno', 'attempt']) then
    raise exception 'T8.2 body misses a contract key: %', b;
  end if;
  -- addressed to this transaction's harmless URL, with the secret header present
  -- (the key only: its value is never read here)
  if not exists (select 1 from public.bot_webhook_log l
                   join net.http_request_queue q on q.id = l.request_id
                  where l.outbox_id = 990000801 and l.kind = 'failed' and l.created_at >= now()
                    and q.url = 'https://priority-push-test.invalid/bot'
                    and q.headers ? 'X-Webhook-Secret') then
    raise exception 'T8.2 the alert is not addressed to the bot URL with X-Webhook-Secret';
  end if;
  raise notice 'T8.2 one alert per new outcome, body ok';
end
$t$;

-- T8.3 no alert on a repeat transition (only priority_push_resend clears the claim)
do $t$
begin
  update public.priority_push_outbox set status = 'queued' where id = 990000801;   -- not an outcome
  update public.priority_push_outbox set status = 'failed' where id = 990000801;   -- same outcome again
  update public.priority_push_outbox set status = 'failed', attempts = attempts where id = 990000801;  -- no change
  if pg_temp.m3_sent(990000801, 'failed') <> 1 then
    raise exception 'T8.3 repeat transition alerted again: % alerts', pg_temp.m3_sent(990000801, 'failed');
  end if;
  if (select count(*) from public.bot_webhook_log
       where outbox_id = 990000801 and created_at >= now()) <> 1 then
    raise exception 'T8.3 extra bot_webhook_log rows for 990000801';
  end if;
  raise notice 'T8.3 no alert on a repeat transition';
end
$t$;

-- T8.4 each outcome kind once; queued is not an outcome
do $t$
declare
  b jsonb;
begin
  update public.priority_push_outbox
     set status = 'unconfirmed', status_code = 200, response_body = 'Accepted'
   where id = 990000802;
  update public.priority_push_outbox
     set status = 'delivered', status_code = 200,
         response_body = '{"ok":true,"reason":"created_draft","docno":"GR-ZZM3-802"}'
   where id = 990000802;
  if pg_temp.m3_sent(990000802, 'unconfirmed') <> 1 or pg_temp.m3_sent(990000802, 'delivered') <> 1 then
    raise exception 'T8.4 802: unconfirmed % / delivered % alerts, want 1 / 1',
      pg_temp.m3_sent(990000802, 'unconfirmed'), pg_temp.m3_sent(990000802, 'delivered');
  end if;
  if pg_temp.m3_body(990000802, 'unconfirmed') ->> 'error_class' is distinct from 'make_no_ok' then
    raise exception 'T8.4 802 unconfirmed error_class: %', pg_temp.m3_body(990000802, 'unconfirmed');
  end if;
  b := pg_temp.m3_body(990000802, 'delivered');
  if b ->> 'gr_docno' is distinct from 'GR-ZZM3-802' or b ->> 'error_class' is not null then
    raise exception 'T8.4 802 delivered body: %', b;
  end if;

  update public.priority_push_outbox
     set status = 'expired', not_ready_reason = 'expired: not ready for 7 days'
   where id = 990000803;
  if pg_temp.m3_sent(990000803, 'expired') <> 1 then
    raise exception 'T8.4 803: expired not alerted once';
  end if;

  update public.priority_push_outbox set status = 'queued' where id = 990000804;
  if exists (select 1 from public.bot_webhook_log where outbox_id = 990000804 and created_at >= now()) then
    raise exception 'T8.4 804: sent -> queued must not alert';
  end if;
  raise notice 'T8.4 unconfirmed / delivered / expired alerted once each; queued silent';
end
$t$;

-- T8.4b an 'unconfirmed' whose Priority GR already exists is not alerted (job 8
--       turns it 'delivered' in the same run); the 'delivered' is. Uses a real
--       row that has a GR, changed only inside this rolled-back transaction.
do $t$
declare
  v_o bigint;
begin
  select o.id into v_o
    from public.priority_push_outbox o
   where o.id not between 990000800 and 990000999
     and exists (select 1 from public.priority_goods_receipts g
                  where g.delivery_id = o.delivery_id and g.origin <> 'warehouse_bot')
   order by o.id desc
   limit 1;
  if v_o is null then
    raise notice 'T8.4b skipped: no outbox row has a Priority GR';
    return;
  end if;
  update public.priority_push_outbox
     set status = 'sent', alert_kind = null, alerted_at = null, alert_tries = 0
   where id = v_o;
  update public.priority_push_outbox
     set status = 'unconfirmed', status_code = 200, response_body = 'Accepted'
   where id = v_o;
  if pg_temp.m3_sent(v_o, 'unconfirmed') <> 0 then
    raise exception 'T8.4b outbox %: unconfirmed alerted although Priority has its GR', v_o;
  end if;
  update public.priority_push_outbox set status = 'delivered' where id = v_o;
  if pg_temp.m3_sent(v_o, 'delivered') <> 1
     or pg_temp.m3_body(v_o, 'delivered') ->> 'gr_docno' is null then
    raise exception 'T8.4b outbox %: delivered not alerted once with its GR', v_o;
  end if;
  raise notice 'T8.4b unconfirmed with a GR -> only delivered alerted (outbox %)', v_o;
end
$t$;

-- T8.5 a broken notify never blocks the status change (it runs inside job 8)
do $t$
begin
  update public.bot_webhook_config set enabled = false;
  update public.priority_push_outbox set status = 'failed', status_code = 400 where id = 990000805;
  update public.bot_webhook_config set enabled = true;
  if (select status from public.priority_push_outbox where id = 990000805) is distinct from 'failed' then
    raise exception 'T8.5 the status change was lost';
  end if;
  if not exists (select 1 from public.bot_webhook_log
                  where outbox_id = 990000805 and kind = 'failed' and request_id is null
                    and error like 'not sent: no enabled bot_webhook_config%' and created_at >= now()) then
    raise exception 'T8.5 the failed notify was not logged';
  end if;
  raise notice 'T8.5 notify failure logged, status change kept';
end
$t$;

-- T8.6 the baseline: no older outcome row is left un-stamped
do $t$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.priority_push_outbox o
   where o.id not between 990000800 and 990000999
     and o.alert_kind is null
     and o.alert_tries = 0
     and (o.status = 'delivered'
          or (o.status in ('failed', 'expired')
              and coalesce(o.sent_at, o.queued_at) < now() - interval '1 hour'));
  if v_n > 0 then
    raise exception 'T8.6 % outcome rows were never stamped (baseline or trigger missed them)', v_n;
  end if;
  raise notice 'T8.6 baseline ok';
end
$t$;

-- T8.7 server-side only; the trigger is in place
-- (I9: service_role, the scanner's server key, cannot post office alerts either)
do $t$
declare
  f text;
begin
  foreach f in array array['public.priority_push_notify_bot(bigint,text,jsonb)',
                           'public.priority_push_outcome_trg()',
                           'public.priority_push_error_class(text,integer,text,text)'] loop
    if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')
       or (select proacl from pg_proc where oid = f::regprocedure) is null then
      raise exception 'T8.7 % is executable by PUBLIC', f;
    end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'T8.7 % is executable by anon/authenticated', f;
    end if;
  end loop;
  -- I9: nothing calls the notify or the trigger function over RPC (the trigger
  -- and job 8 run as the owner), so service_role may not execute them
  foreach f in array array['public.priority_push_notify_bot(bigint,text,jsonb)',
                           'public.priority_push_outcome_trg()'] loop
    if has_function_privilege('service_role', f, 'execute') then
      raise exception 'T8.7 % is executable by service_role', f;
    end if;
  end loop;
  -- the classifier is the one exception: M4's needs-attention view calls it
  if not has_function_privilege('service_role',
                                'public.priority_push_error_class(text,integer,text,text)', 'execute') then
    raise exception 'T8.7 priority_push_error_class must stay executable by service_role (M4 view)';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.priority_push_notify_bot(bigint,text,jsonb)'::regprocedure) then
    raise exception 'T8.7 priority_push_notify_bot must be SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'trg_priority_push_outcome'
                    and tgrelid = 'public.priority_push_outbox'::regclass and tgenabled = 'O') then
    raise exception 'T8.7 trg_priority_push_outcome missing or disabled';
  end if;
  raise notice 'T8.7 privileges and trigger ok';
end
$t$;

-- ===================== Task 9: the watch, the digest, the cron jobs ==========

-- answer this transaction's pending outcome alerts for an outbox row (or, with
-- p_outbox NULL, for a delivery's not_queued alerts) as the bot would: a fake
-- pg_net reply row with that HTTP status, or a timeout
create function pg_temp.m3_reply(p_outbox bigint, p_delivery uuid, p_code integer,
                                 p_timed_out boolean default false) returns integer
language sql as $$
  with ins as (
    insert into net._http_response (id, status_code, content, timed_out, error_msg, created)
    select l.request_id, p_code,
           case when p_code is not null then 'zz m3 test reply' end,
           p_timed_out,
           case when p_timed_out then 'Timeout of 30000 ms reached' end,
           now()
      from public.bot_webhook_log l
     where l.event = 'priority_push_outcome'
       and l.created_at >= now()
       and l.request_id is not null and l.status_code is null and l.reply_error is null
       and ((p_outbox is not null and l.outbox_id = p_outbox)
            or (p_outbox is null and l.outbox_id is null and l.delivery_id = p_delivery))
       and not exists (select 1 from net._http_response h where h.id = l.request_id)
    returning 1)
  select count(*)::int from ins
$$;

-- T9.0 the functions exist
do $t$
begin
  if to_regprocedure('public.priority_push_watch()') is null
     or to_regprocedure('public.priority_push_digest()') is null
     or to_regclass('public.priority_push_alert_log') is null then
    raise exception 'T9.0 priority_push_watch() / priority_push_digest() / priority_push_alert_log missing';
  end if;
  raise notice 'T9.0 objects exist';
end
$t$;

-- fixtures for T9.1-T9.6
-- English: זזזספקבדיקהזזז = "zzz test supplier zzz" (the glosses for all Hebrew fixture text are repeated below)
insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
values ('00000000-0000-4000-8000-000000000901', 'ZZM3-901', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000902', 'ZZM3-902', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000903', 'ZZM3-903', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000904', 'ZZM3-904', 'זזזספקבדיקהזזז', 990000000081, 'In Progress', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000905', 'ZZM3-905', 'זזזספקבדיקהזזז', 990000000081, 'In Progress', now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000906', 'ZZM3-906', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000907', 'ZZM3-907', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000908', 'ZZM3-908', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000909', 'ZZM3-909', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000912', 'ZZM3-912', 'זזזספקבדיקהזזז', 990000000081, 'Complete',    now() - interval '1 hour'),
       ('00000000-0000-4000-8000-000000000913', 'ZZM3-913', 'זזזספקבדיקהזזז', 990000000081, 'In Progress', now() - interval '3 days');

-- Hebrew in the fixtures: זזזספקבדיקהזזז = "zzz test supplier zzz", פריט בדיקה = "test item".
insert into public.delivery_items (receipt_id, item_code, item_name_hebrew, unit, invoice_qty_kg, received_qty_kg)
values ('00000000-0000-4000-8000-000000000904', 'ZZM3-NOITEM', 'פריט בדיקה', 'units', 3, 3),
       ('00000000-0000-4000-8000-000000000905', 'ZZM3-NOITEM', 'פריט בדיקה', 'units', 3, 3),
       ('00000000-0000-4000-8000-000000000912', 'ZZM3-NOITEM', 'פריט בדיקה', 'units', 3, 3);

-- 901 sent 6 min ago, nothing back.  902 sent 2 min ago.  903 sent 6 min ago, then 500.
-- 904 queued 31 min ago, delivery In Progress (held).  905 queued 5 min ago (held, too young).
-- 906 closed, NO outbox row (not_queued).  907-909 retry cases.
-- 912 closed, queued 31 min ago (whatever explain() says, a row this old is alerted).
-- 913 queued 3 days ago but put back by Send again 5 min ago (held clock restarts).
insert into public.priority_push_outbox
       (id, delivery_id, document_number, delivery_status, category, status, target,
        attempts, request_id, sent_at, queued_at, status_code, response_body)
values (990000901, '00000000-0000-4000-8000-000000000901', 'ZZM3-901', 'Complete', 'non_meat', 'sent',   'make', 1, -990901, now() - interval '6 minutes', now() - interval '7 minutes', null, null),
       (990000902, '00000000-0000-4000-8000-000000000902', 'ZZM3-902', 'Complete', 'non_meat', 'sent',   'make', 1, -990902, now() - interval '2 minutes', now() - interval '3 minutes', null, null),
       (990000903, '00000000-0000-4000-8000-000000000903', 'ZZM3-903', 'Complete', 'non_meat', 'sent',   'make', 1, -990903, now() - interval '6 minutes', now() - interval '7 minutes', null, null),
       (990000904, '00000000-0000-4000-8000-000000000904', 'ZZM3-904', 'Complete', 'non_meat', 'queued', 'make', 0, null,    null,                         now() - interval '31 minutes', null, null),
       (990000905, '00000000-0000-4000-8000-000000000905', 'ZZM3-905', 'Complete', 'non_meat', 'queued', 'make', 0, null,    null,                         now() - interval '5 minutes', null, null),
       (990000907, '00000000-0000-4000-8000-000000000907', 'ZZM3-907', 'Complete', 'non_meat', 'sent',   'make', 1, -990907, now() - interval '1 minute',  now() - interval '2 minutes', null, null),
       (990000908, '00000000-0000-4000-8000-000000000908', 'ZZM3-908', 'Complete', 'non_meat', 'sent',   'make', 1, -990908, now() - interval '1 minute',  now() - interval '2 minutes', null, null),
       (990000909, '00000000-0000-4000-8000-000000000909', 'ZZM3-909', 'Complete', 'non_meat', 'sent',   'make', 1, -990909, now() - interval '1 minute',  now() - interval '2 minutes', null, null),
       (990000912, '00000000-0000-4000-8000-000000000912', 'ZZM3-912', 'Complete', 'non_meat', 'queued', 'make', 0, null,    null,                         now() - interval '31 minutes', null, null),
       (990000913, '00000000-0000-4000-8000-000000000913', 'ZZM3-913', 'Complete', 'non_meat', 'queued', 'make', 0, null,    null,                         now() - interval '3 days', null, null);

-- 913's Send again (M4's priority_push_resend archives the reply with reason 'resend')
insert into public.priority_push_attempts (outbox_id, attempt, reason, archived_by, created_at)
values (990000913, 1, 'resend', 'test:zz-m3', now() - interval '5 minutes');


-- T9.1 no_writeback after 5 min, once per send
do $t$
begin
  -- 903: Make answered 500 -> the trigger alerts 'unconfirmed' at once
  update public.priority_push_outbox
     set status = 'unconfirmed', status_code = 500, response_body = 'Scenario failed to complete.',
         response_error = 'Scenario failed to complete.'
   where id = 990000903;

  if public.priority_push_watch() < 0 then raise exception 'T9.1 watch lock refused'; end if;
  perform public.priority_push_watch();

  if pg_temp.m3_sent(990000901, 'no_writeback') <> 1 then
    raise exception 'T9.1 901: % no_writeback alerts, want 1', pg_temp.m3_sent(990000901, 'no_writeback');
  end if;
  if pg_temp.m3_body(990000901, 'no_writeback') ->> 'error_class' is distinct from 'no_reply' then
    raise exception 'T9.1 901 error_class: %', pg_temp.m3_body(990000901, 'no_writeback');
  end if;
  if pg_temp.m3_sent(990000902, 'no_writeback') <> 0 then
    raise exception 'T9.1 902 (sent 2 min ago) must not be alerted yet';
  end if;
  if pg_temp.m3_sent(990000903, 'unconfirmed') <> 1 or pg_temp.m3_sent(990000903, 'no_writeback') <> 1 then
    raise exception 'T9.1 903: unconfirmed % / no_writeback %, want 1 / 1',
      pg_temp.m3_sent(990000903, 'unconfirmed'), pg_temp.m3_sent(990000903, 'no_writeback');
  end if;
  if pg_temp.m3_body(990000903, 'no_writeback') ->> 'error_class' is distinct from 'make_crash' then
    raise exception 'T9.1 903 error_class: %', pg_temp.m3_body(990000903, 'no_writeback');
  end if;

  -- 901 then turns 'unconfirmed' (job 8's 10-minute no-reply rule): the trigger
  -- alerts that once, and no_writeback is not repeated for the same send
  update public.priority_push_outbox
     set status = 'unconfirmed',
         response_error = 'no reply read back 00:10:00 after sending (pg_net request -990901 has no reply row and is no longer queued)'
   where id = 990000901;
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if pg_temp.m3_sent(990000901, 'unconfirmed') <> 1 or pg_temp.m3_sent(990000901, 'no_writeback') <> 1 then
    raise exception 'T9.1 901 after unconfirmed: unconfirmed % / no_writeback %, want 1 / 1',
      pg_temp.m3_sent(990000901, 'unconfirmed'), pg_temp.m3_sent(990000901, 'no_writeback');
  end if;
  raise notice 'T9.1 no_writeback after 5 min, once per send';
end
$t$;

-- T9.1b the outcome trigger and the watch never both alert one outcome.
--      Both claim with UPDATE ... WHERE alert_kind IS DISTINCT FROM <kind>; in two
--      concurrent transactions (job 8's trigger vs the watch) the row lock makes
--      the second UPDATE re-check that WHERE after the first commits, so it
--      claims nothing. Inside one transaction the same rule is checked in both
--      orders: trigger first (914), watch first (915).
do $t$
begin
  -- English: זזזספקבדיקהזזז = "zzz test supplier zzz"
  insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
  values ('00000000-0000-4000-8000-000000000914', 'ZZM3-914', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour'),
         ('00000000-0000-4000-8000-000000000915', 'ZZM3-915', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour');
  insert into public.priority_push_outbox
         (id, delivery_id, document_number, delivery_status, category, status, target,
          attempts, request_id, sent_at, queued_at, status_code, response_body)
  values (990000914, '00000000-0000-4000-8000-000000000914', 'ZZM3-914', 'Complete', 'non_meat', 'sent',   'make', 1, -990914, now() - interval '1 minute', now() - interval '2 minutes', null, null),
         (990000915, '00000000-0000-4000-8000-000000000915', 'ZZM3-915', 'Complete', 'non_meat', 'failed', 'make', 1, -990915, now() - interval '1 minute', now() - interval '2 minutes', 400, '{"ok":false,"error":"x"}');

  -- 914: job 8 reads a 400 -> the trigger claims and alerts; then two watch ticks
  update public.priority_push_outbox set status = 'failed', status_code = 400, response_body = '{"ok":false,"error":"x"}'
   where id = 990000914;
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if pg_temp.m3_sent(990000914, 'failed') <> 1 then
    raise exception 'T9.1b 914 (trigger first): % failed alerts, want 1', pg_temp.m3_sent(990000914, 'failed');
  end if;

  -- 915: inserted already failed (no trigger) -> the watch claims it; a later
  --      write that keeps status 'failed' (job 8 re-reading the reply) is no new outcome
  perform public.priority_push_watch();
  update public.priority_push_outbox set status = 'failed', status_code = 400 where id = 990000915;
  perform public.priority_push_watch();
  if pg_temp.m3_sent(990000915, 'failed') <> 1 then
    raise exception 'T9.1b 915 (watch first): % failed alerts, want 1', pg_temp.m3_sent(990000915, 'failed');
  end if;
  raise notice 'T9.1b trigger and watch alert each outcome once';
end
$t$;

-- T9.2 no no_writeback when Priority has the GR (a real row that has one; rolled back)
do $t$
declare
  v_o bigint;
begin
  select o.id into v_o
    from public.priority_push_outbox o
   where o.id not between 990000800 and 990000999
     and exists (select 1 from public.priority_goods_receipts g
                  where g.delivery_id = o.delivery_id and g.origin <> 'warehouse_bot')
   order by o.id desc
   limit 1;
  if v_o is null then
    raise notice 'T9.2 skipped: no outbox row has a Priority GR';
    return;
  end if;
  update public.priority_push_outbox
     set status = 'sent', sent_at = now() - interval '6 minutes',
         alert_kind = null, alerted_at = null, alert_tries = 0
   where id = v_o;
  perform public.priority_push_watch();
  if pg_temp.m3_sent(v_o, 'no_writeback') <> 0 then
    raise exception 'T9.2 outbox % alerted no_writeback although Priority has its GR', v_o;
  end if;
  raise notice 'T9.2 GR present -> no no_writeback (outbox %)', v_o;
end
$t$;

-- T9.3 held after 30 min, with hold_reason from priority_push_explain(), once
do $t$
declare
  v_exp    jsonb;
  v_reason text;
  v_want   text;
begin
  perform public.priority_push_watch();
  perform public.priority_push_watch();

  begin
    v_exp := public.priority_push_explain('00000000-0000-4000-8000-000000000904');
  exception when others then
    v_exp := null;
  end;
  select hold_reason into v_reason from public.priority_push_outbox where id = 990000904;
  v_want := v_exp ->> 'hold_reason';
  if v_reason is null
     or (v_want is not null and v_reason is distinct from left(v_want, 1000))
     or (v_exp is not null and v_want is null and v_reason not like 'not sent although nothing holds it (decision %')
     or (v_exp is null and v_reason not like 'held for more than % min; the reason could not be read:%') then
    raise exception 'T9.3 904 hold_reason %, want %', v_reason, coalesce(v_want, '(explain: ' || coalesce(v_exp ->> 'decision', 'error') || ')');
  end if;
  if pg_temp.m3_sent(990000904, 'held') <> 1 then
    raise exception 'T9.3 904: % held alerts, want 1', pg_temp.m3_sent(990000904, 'held');
  end if;
  if pg_temp.m3_body(990000904, 'held') ->> 'hold_reason' is distinct from v_reason then
    raise exception 'T9.3 904 body hold_reason: %', pg_temp.m3_body(990000904, 'held');
  end if;
  if (select alert_kind from public.priority_push_outbox where id = 990000904) is distinct from 'held' then
    raise exception 'T9.3 904 not claimed as held';
  end if;
  if pg_temp.m3_sent(990000905, 'held') <> 0 then
    raise exception 'T9.3 905 (queued 5 min ago) must not be alerted';
  end if;
  raise notice 'T9.3 held after 30 min, hold_reason "%", once', v_reason;
end
$t$;

-- T9.3b every row queued that long is alerted, whatever explain() says (job 8
--       acts on a due row within 15 s); Send again restarts the held clock
do $t$
declare
  v_exp    jsonb;
  v_reason text;
begin
  perform public.priority_push_watch();

  begin
    v_exp := public.priority_push_explain('00000000-0000-4000-8000-000000000912');
  exception when others then
    v_exp := null;
  end;
  select hold_reason into v_reason from public.priority_push_outbox where id = 990000912;
  if pg_temp.m3_sent(990000912, 'held') <> 1
     or (select alert_kind from public.priority_push_outbox where id = 990000912) is distinct from 'held' then
    raise exception 'T9.3b 912 (explain: %): % held alerts, want 1',
      v_exp ->> 'decision', pg_temp.m3_sent(990000912, 'held');
  end if;
  if v_reason is null
     or (v_exp ->> 'hold_reason' is not null and v_reason is distinct from left(v_exp ->> 'hold_reason', 1000))
     or (v_exp is not null and v_exp ->> 'hold_reason' is null
         and v_reason not like 'not sent although nothing holds it (decision ' || (v_exp ->> 'decision') || ')%') then
    raise exception 'T9.3b 912 hold_reason % (explain: %)', v_reason, v_exp;
  end if;
  if pg_temp.m3_sent(990000913, 'held') <> 0 then
    raise exception 'T9.3b 913 was put back by Send again 5 min ago: must not be alerted yet';
  end if;
  raise notice 'T9.3b 912 (explain: %) alerted held once; 913 (Send again 5 min ago) not yet',
    coalesce(v_exp ->> 'decision', 'error');
end
$t$;

-- T9.4 closed but never queued: alerted once per delivery
do $t$
declare
  b jsonb;
begin
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if (select count(*) from public.priority_push_alert_log
       where delivery_id = '00000000-0000-4000-8000-000000000906' and kind = 'not_queued') <> 1 then
    raise exception 'T9.4 906 has no not_queued alert-log row';
  end if;
  if (select count(*) from public.bot_webhook_log
       where event = 'priority_push_outcome' and kind = 'not_queued' and outbox_id is null
         and delivery_id = '00000000-0000-4000-8000-000000000906'
         and request_id is not null and created_at >= now()) <> 1 then
    raise exception 'T9.4 906: not exactly one not_queued alert';
  end if;
  select convert_from(q.body, 'UTF8')::jsonb into b
    from public.bot_webhook_log l join net.http_request_queue q on q.id = l.request_id
   where l.kind = 'not_queued' and l.delivery_id = '00000000-0000-4000-8000-000000000906'
     and l.created_at >= now();
  if b ->> 'document_number' is distinct from 'ZZM3-906'
     or (b ->> 'delivery_id')::uuid is distinct from '00000000-0000-4000-8000-000000000906'::uuid
     or b -> 'outbox_id' is distinct from 'null'::jsonb
     or b ->> 'error_text' is null then
    raise exception 'T9.4 906 body: %', b;
  end if;
  raise notice 'T9.4 not_queued once';
end
$t$;

-- T9.4b (controller ruling) a Test user's never-queued delivery is flagged
--       is_test in its not_queued alert, so the bot does not report it to the
--       office as real; a Prod user's, and 906's unknown receiver's, are not
create function pg_temp.m3_nq_body(p_delivery uuid) returns jsonb
language sql as $$
  select convert_from(q.body, 'UTF8')::jsonb
    from public.bot_webhook_log l
    join net.http_request_queue q on q.id = l.request_id
   where l.event = 'priority_push_outcome' and l.kind = 'not_queued'
     and l.outbox_id is null and l.delivery_id = p_delivery
     and l.created_at >= now()
   order by l.id desc
   limit 1
$$;

do $t$
begin
  insert into public.users (chat_id, nickname, env)
  values (990000000082, 'zz-m3-test-receiver', 'Test'),
         (990000000083, 'zz-m3-prod-receiver', 'Prod');
  -- English: זזזספקבדיקהזזז = "zzz test supplier zzz"
  insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
  values ('00000000-0000-4000-8000-000000000916', 'ZZM3-916', 'זזזספקבדיקהזזז', 990000000082, 'Complete', now() - interval '1 hour'),
         ('00000000-0000-4000-8000-000000000917', 'ZZM3-917', 'זזזספקבדיקהזזז', 990000000083, 'Complete', now() - interval '1 hour');

  perform public.priority_push_watch();
  perform public.priority_push_watch();

  if (select count(*) from public.bot_webhook_log
       where event = 'priority_push_outcome' and kind = 'not_queued' and outbox_id is null
         and delivery_id in ('00000000-0000-4000-8000-000000000916', '00000000-0000-4000-8000-000000000917')
         and request_id is not null and created_at >= now()) <> 2 then
    raise exception 'T9.4b 916 / 917: want exactly one not_queued alert each';
  end if;
  if pg_temp.m3_nq_body('00000000-0000-4000-8000-000000000916') -> 'is_test' is distinct from 'true'::jsonb then
    raise exception 'T9.4b 916 (Test receiver) not_queued body is_test: %',
      pg_temp.m3_nq_body('00000000-0000-4000-8000-000000000916') -> 'is_test';
  end if;
  if pg_temp.m3_nq_body('00000000-0000-4000-8000-000000000917') -> 'is_test' is distinct from 'false'::jsonb then
    raise exception 'T9.4b 917 (Prod receiver) not_queued body is_test: %',
      pg_temp.m3_nq_body('00000000-0000-4000-8000-000000000917') -> 'is_test';
  end if;
  if pg_temp.m3_nq_body('00000000-0000-4000-8000-000000000906') -> 'is_test' is distinct from 'false'::jsonb then
    raise exception 'T9.4b 906 (receiver not in users) not_queued body is_test: %',
      pg_temp.m3_nq_body('00000000-0000-4000-8000-000000000906') -> 'is_test';
  end if;
  raise notice 'T9.4b not_queued is_test: Test receiver true, Prod / unknown receiver false';
end
$t$;

-- T9.5 the bot did not take it: retried up to 3 times; a 2xx is final
do $t$
declare
  i integer;
begin
  -- 907: every send answered 502 - what Railway's edge answers while the bot is
  --      mid-deploy (any non-2xx is treated the same; 906 below uses 500)
  update public.priority_push_outbox set status = 'failed', status_code = 400 where id = 990000907;  -- send 1
  for i in 1..3 loop
    if pg_temp.m3_reply(990000907, null, 502) <> 1 then
      raise exception 'T9.5 907 round %: no pending alert to answer', i;
    end if;
    perform public.priority_push_watch();          -- reads the 502, clears the claim
    if (select alert_kind from public.priority_push_outbox where id = 990000907) is not null
       or (select alert_tries from public.priority_push_outbox where id = 990000907) <> i then
      raise exception 'T9.5 907 round %: claim not cleared / alert_tries %', i,
        (select alert_tries from public.priority_push_outbox where id = 990000907);
    end if;
    perform public.priority_push_watch();          -- the next tick re-sends
    if pg_temp.m3_sent(990000907, 'failed') <> i + 1 then
      raise exception 'T9.5 907 round %: % sends, want %', i, pg_temp.m3_sent(990000907, 'failed'), i + 1;
    end if;
  end loop;
  perform pg_temp.m3_reply(990000907, null, 502);  -- the 4th send fails too: no more tries
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if pg_temp.m3_sent(990000907, 'failed') <> 4
     or (select alert_tries from public.priority_push_outbox where id = 990000907) <> 3
     or (select alert_kind from public.priority_push_outbox where id = 990000907) is distinct from 'failed' then
    raise exception 'T9.5 907 after 3 retries: % sends, tries %', pg_temp.m3_sent(990000907, 'failed'),
      (select alert_tries from public.priority_push_outbox where id = 990000907);
  end if;
  if exists (select 1 from public.bot_webhook_log
              where outbox_id = 990000907 and created_at >= now() and status_code is distinct from 502) then
    raise exception 'T9.5 907: a reply status was not copied into bot_webhook_log';
  end if;

  -- 908: answered 200 -> final, no retry
  update public.priority_push_outbox set status = 'failed', status_code = 400 where id = 990000908;
  perform pg_temp.m3_reply(990000908, null, 200);
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if pg_temp.m3_sent(990000908, 'failed') <> 1
     or (select alert_tries from public.priority_push_outbox where id = 990000908) <> 0
     or not exists (select 1 from public.bot_webhook_log
                     where outbox_id = 990000908 and status_code = 200 and reply_error is null
                       and created_at >= now()) then
    raise exception 'T9.5 908: a 200 reply must be final and recorded';
  end if;

  -- 909: timed out -> counts as not taken, retried
  update public.priority_push_outbox set status = 'failed', status_code = 400 where id = 990000909;
  perform pg_temp.m3_reply(990000909, null, null, true);
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if pg_temp.m3_sent(990000909, 'failed') <> 2
     or not exists (select 1 from public.bot_webhook_log
                     where outbox_id = 990000909 and reply_error = 'timed out' and created_at >= now()) then
    raise exception 'T9.5 909: a timed-out alert must be recorded and re-sent';
  end if;

  -- 906 (not_queued, T9.4): answered 500 -> alerted again
  perform pg_temp.m3_reply(null, '00000000-0000-4000-8000-000000000906', 500);
  perform public.priority_push_watch();
  perform public.priority_push_watch();
  if (select count(*) from public.bot_webhook_log
       where event = 'priority_push_outcome' and kind = 'not_queued'
         and delivery_id = '00000000-0000-4000-8000-000000000906' and created_at >= now()) <> 2 then
    raise exception 'T9.5 906: a not_queued alert the bot refused must be sent again';
  end if;
  raise notice 'T9.5 retries: 502 x4 -> 3 retries then stop; 200 final; timeout retried; not_queued retried';
end
$t$;

-- T9.6 an error on one row does not stop the others
create function pg_temp.m3_boom() returns trigger
language plpgsql as $$
begin
  if new.id = 990000910 and new.alert_kind is distinct from old.alert_kind then
    raise exception 'zz m3 test: boom on outbox %', new.id;
  end if;
  return new;
end
$$;

do $t$
declare
  v_n integer;
begin
  -- 910 / 911: 'failed' rows that were never alerted (inserted, so no trigger
  -- ran): only the watch's step 2 picks them up. 910's claim raises.
  -- English: זזזספקבדיקהזזז = "zzz test supplier zzz"
  insert into public.deliveries (id, document_number, supplier_hebrew, received_by_chat_id, status, created_at)
  values ('00000000-0000-4000-8000-000000000910', 'ZZM3-910', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour'),
         ('00000000-0000-4000-8000-000000000911', 'ZZM3-911', 'זזזספקבדיקהזזז', 990000000081, 'Complete', now() - interval '1 hour');
  insert into public.priority_push_outbox
         (id, delivery_id, document_number, delivery_status, category, status, target,
          attempts, request_id, sent_at, queued_at, status_code, response_body)
  values (990000910, '00000000-0000-4000-8000-000000000910', 'ZZM3-910', 'Complete', 'non_meat', 'failed', 'make', 1, -990910, now() - interval '1 minute', now() - interval '2 minutes', 400, '{"ok":false,"error":"x"}'),
         (990000911, '00000000-0000-4000-8000-000000000911', 'ZZM3-911', 'Complete', 'non_meat', 'failed', 'make', 1, -990911, now() - interval '1 minute', now() - interval '2 minutes', 400, '{"ok":false,"error":"x"}');

  create trigger zz_m3_boom before update on public.priority_push_outbox
    for each row execute function pg_temp.m3_boom();
  v_n := public.priority_push_watch();
  drop trigger zz_m3_boom on public.priority_push_outbox;

  if v_n < 1 then
    raise exception 'T9.6 the watch returned % (it must finish and count 911)', v_n;
  end if;
  if pg_temp.m3_sent(990000911, 'failed') <> 1 then
    raise exception 'T9.6 911 was not alerted after 910 failed';
  end if;
  if pg_temp.m3_sent(990000910, 'failed') <> 0
     or (select alert_kind from public.priority_push_outbox where id = 990000910) is not null then
    raise exception 'T9.6 910 must stay unclaimed after its error';
  end if;
  if not exists (select 1 from public.bot_webhook_log
                  where event = 'priority_push_watch' and outbox_id = 990000910
                    and error like '%boom%' and created_at >= now()) then
    raise exception 'T9.6 910 error not logged';
  end if;
  perform public.priority_push_watch();             -- next tick: 910 goes out
  if pg_temp.m3_sent(990000910, 'failed') <> 1 then
    raise exception 'T9.6 910 not alerted once the error is gone';
  end if;
  raise notice 'T9.6 one bad row does not stop the others';
end
$t$;

-- T9.7 the digest: one post with items + orphan_counts; fake-Make rows left out
do $t$
declare
  b jsonb;
begin
  -- 805 (failed, T8.5) becomes a fake-Make row: the office digest must not list it
  update public.priority_push_outbox set target = 'test' where id = 990000805;
  perform public.priority_push_digest();
  if (select count(*) from public.bot_webhook_log
       where event = 'priority_push_outcome' and kind = 'digest' and outbox_id is null
         and request_id is not null and created_at >= now()) <> 1 then
    raise exception 'T9.7 not exactly one digest post';
  end if;
  b := pg_temp.m3_body(null, 'digest');
  if b ->> 'event' is distinct from 'priority_push_outcome' or b ->> 'kind' is distinct from 'digest'
     or jsonb_typeof(b -> 'items') is distinct from 'array'
     or not (b ? 'orphan_counts') then
    raise exception 'T9.7 digest body: %', left(b::text, 500);
  end if;
  if not exists (select 1 from jsonb_array_elements(b -> 'items') e
                  where (e ->> 'outbox_id')::bigint = 990000801) then
    raise exception 'T9.7 failed row 990000801 missing from the digest items';
  end if;
  if exists (select 1 from jsonb_array_elements(b -> 'items') e
              where (e ->> 'outbox_id')::bigint = 990000805) then
    raise exception 'T9.7 fake-Make (target test) row 990000805 is in the office digest';
  end if;
  raise notice 'T9.7 digest ok (% items, test rows left out)', jsonb_array_length(b -> 'items');
end
$t$;

-- T9.8 the cron jobs, privileges, RLS
do $t$
declare
  f text;
begin
  if not exists (select 1 from cron.job where jobname = 'priority-push-watch'
                    and schedule = '* * * * *' and command ilike '%public.priority_push_watch()%' and active) then
    raise exception 'T9.8 cron job priority-push-watch missing or wrong';
  end if;
  if not exists (select 1 from cron.job where jobname = 'priority-push-digest'
                    and schedule = '0 4,5 * * *' and command ilike '%public.priority_push_digest()%'
                    and command ilike '%Asia/Jerusalem%' and active) then
    raise exception 'T9.8 cron job priority-push-digest missing or wrong';
  end if;
  if not exists (select 1 from cron.job where jobname = 'priority-push-dispatch'
                    and schedule = '15 seconds' and active) then
    raise exception 'T9.8 job 8 priority-push-dispatch changed';
  end if;
  foreach f in array array['public.priority_push_watch()', 'public.priority_push_digest()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'T9.8 % is executable by anon/authenticated', f;
    end if;
    -- I9: only pg_cron (the owner) runs these; service_role may not call them over RPC
    if has_function_privilege('service_role', f, 'execute') then
      raise exception 'T9.8 % is executable by service_role', f;
    end if;
    if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')
       or (select proacl from pg_proc where oid = f::regprocedure) is null then
      raise exception 'T9.8 % is executable by PUBLIC', f;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.priority_push_alert_log'::regclass) then
    raise exception 'T9.8 RLS must be on for priority_push_alert_log';
  end if;
  raise notice 'T9.8 cron jobs, privileges, RLS ok';
  raise notice 'ALL M3 TESTS PASSED';
end
$t$;
