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
