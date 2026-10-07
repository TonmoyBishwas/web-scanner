-- =============================================================================
-- Tests for 2026-10-08-priority-push-01-safety-test-harness.sql (M1)
-- =============================================================================
-- Run by telegram-warehouse-bot/scripts/sql/run_sql_test.py, which wraps this
-- file (and the --setup migration) in BEGIN ... ROLLBACK. Nothing is committed.
--
--   before M1 is applied:  run_sql_test.py <this file> --setup <M1 file>
--   after  M1 is applied:  run_sql_test.py <this file>
--   after  M2 is applied:  run_sql_test.py <this file>   (the target routing
--                          in priority_push_dispatch must survive M2)
--
-- Every URL used here is *.example.invalid (RFC 2606: never resolves), and
-- pg_net only sends committed requests, so not even a leaked request could
-- reach Make or the bot. The dispatcher's advisory lock is held (taken by the
-- M1 file's section 0 when it is the --setup, else by the setup block below),
-- so cron job 8 skips its ticks (returns 0) until the ROLLBACK, ~1-2 s.
--
-- Fixtures (all rolled back):
--   users       990000000801 (env Test), 990000000802 (env Prod)
--   deliveries  a1000000-0000-4000-8000-0000000000NN, document numbers M1TEST-*
--   priority_goods_receipts  one row, docno M1TEST-GR1 (T7b; origin 'priority', so
--               notify_bot_priority_receipt() does nothing)
-- =============================================================================

-- T0 schema ---------------------------------------------------------------------
do $t$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'priority_push_outbox'
                    and column_name = 'target') then
    raise exception 'FAIL T0: priority_push_outbox.target is missing (M1 not applied)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'priority_push_config'
                    and column_name = 'test_url') then
    raise exception 'FAIL T0: priority_push_config.test_url is missing';
  end if;
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'priority_push_config'
         and column_name = 'test_outcome') is distinct from '''ok''::text' then
    raise exception 'FAIL T0: priority_push_config.test_outcome default is not ''ok''';
  end if;
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'priority_push_outbox'
         and column_name = 'target') is distinct from '''make''::text' then
    raise exception 'FAIL T0: priority_push_outbox.target default is not ''make''';
  end if;
  raise notice 'PASS T0 schema';
end
$t$;

-- T1 constraints ------------------------------------------------------------------
do $t$
begin
  begin
    update public.priority_push_config set test_outcome = 'bogus' where id = 1;
    raise exception 'FAIL T1: test_outcome accepted bogus';
  exception when check_violation then
    null;
  end;
  begin
    update public.priority_push_outbox set target = 'other'
     where id = (select min(id) from public.priority_push_outbox);
    if found then
      raise exception 'FAIL T1: target accepted other';
    end if;
  exception when check_violation then
    null;
  end;
  raise notice 'PASS T1 constraints';
end
$t$;

-- setup ---------------------------------------------------------------------------
do $t$
begin
  -- job 8 cannot run while we hold this (pg_try_advisory_xact_lock -> 0);
  -- our own dispatch call below re-enters it (same session). With M1 as the
  -- --setup we already hold it (M1 section 0) and this re-enters too.
  perform pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

  update public.priority_push_config
     set url              = 'https://m1-make.example.invalid/hook',
         test_url         = null,
         test_outcome     = 'ok',
         enabled          = true,
         categories       = array['meat', 'non_meat'],
         send_unready     = true,
         po_grace_minutes = 0
   where id = 1;
  if not found then
    raise exception 'FAIL setup: priority_push_config row 1 is missing';
  end if;

  -- keep every real queued row out of this test's dispatch call
  update public.priority_push_outbox
     set next_check_at = now() + interval '1 hour'
   where status in ('queued', 'waiting');

  insert into public.users (chat_id, nickname, env)
  values (990000000801, 'm1-test-receiver', 'Test'),
         (990000000802, 'm1-prod-receiver', 'Prod')
  on conflict (chat_id) do update set env = excluded.env;
  raise notice 'setup done';
end
$t$;

-- T2 Test receiver, test_url NULL -> skipped exactly as before -------------------
do $t$
declare
  o record;
begin
  insert into public.deliveries (id, document_number, received_by_chat_id)
  values ('a1000000-0000-4000-8000-000000000001', 'M1TEST-T2', 990000000801);
  update public.deliveries set status = 'Complete'
   where id = 'a1000000-0000-4000-8000-000000000001';

  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000001';
  if not found then
    raise exception 'FAIL T2: no outbox row';
  end if;
  if o.status <> 'skipped' or o.target <> 'make'
     or o.response_error is distinct from 'skipped: Test user 990000000801' then
    raise exception 'FAIL T2: got status=% target=% reason=%', o.status, o.target, o.response_error;
  end if;
  raise notice 'PASS T2 Test receiver without test_url is skipped (target make)';
end
$t$;

-- T3 Test receiver, test_url set -> queued, target test ---------------------------
do $t$
declare
  o record;
begin
  update public.priority_push_config
     set test_url = 'https://m1-bot.example.invalid/webhook/priority-push-test'
   where id = 1;

  insert into public.deliveries (id, document_number, received_by_chat_id)
  values ('a1000000-0000-4000-8000-000000000002', 'M1TEST-T3', 990000000801);
  update public.deliveries set status = 'Complete'
   where id = 'a1000000-0000-4000-8000-000000000002';

  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000002';
  if not found then
    raise exception 'FAIL T3: no outbox row';
  end if;
  if o.status <> 'queued' or o.target <> 'test' or o.response_error is not null then
    raise exception 'FAIL T3: got status=% target=% reason=%', o.status, o.target, o.response_error;
  end if;

  -- a re-close never changes status or target
  update public.deliveries set status = 'Has Discrepancy'
   where id = 'a1000000-0000-4000-8000-000000000002';
  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000002';
  if o.status <> 'queued' or o.target <> 'test' or o.delivery_status <> 'Has Discrepancy' then
    raise exception 'FAIL T3 re-close: got status=% target=% delivery_status=%',
      o.status, o.target, o.delivery_status;
  end if;
  raise notice 'PASS T3 Test receiver with test_url is queued (target test)';
end
$t$;

-- T4 Prod receiver, test_url set -> queued, target make ---------------------------
do $t$
declare
  o record;
begin
  insert into public.deliveries (id, document_number, received_by_chat_id)
  values ('a1000000-0000-4000-8000-000000000003', 'M1TEST-T4', 990000000802);
  update public.deliveries set status = 'Complete'
   where id = 'a1000000-0000-4000-8000-000000000003';

  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000003';
  if not found or o.status <> 'queued' or o.target <> 'make' then
    raise exception 'FAIL T4: got status=% target=%', o.status, o.target;
  end if;
  raise notice 'PASS T4 Prod receiver is queued (target make)';
end
$t$;

-- T5 dispatch routes each row to its own URL with its own secret ------------------
do $t$
declare
  v_bot_sec  text;
  v_make_sec text;
  o          record;
  q          record;
begin
  -- a category the config sends, so the plan reaches 'send' (send_unready is on)
  update public.priority_push_outbox set category = 'non_meat'
   where delivery_id in ('a1000000-0000-4000-8000-000000000002',
                         'a1000000-0000-4000-8000-000000000003');

  perform public.priority_push_dispatch();

  select ds.decrypted_secret into v_bot_sec
    from vault.decrypted_secrets ds
   where ds.name = (select b.secret_name from public.bot_webhook_config b
                     where b.enabled order by b.updated_at desc, b.id limit 1);
  select ds.decrypted_secret into v_make_sec
    from vault.decrypted_secrets ds
   where ds.name = (select c.secret_name from public.priority_push_config c where c.id = 1);
  if coalesce(v_bot_sec, '') = '' or coalesce(v_make_sec, '') = '' then
    raise exception 'FAIL T5 precondition: a vault secret is missing (values not printed)';
  end if;

  -- the test row -> the fake Make, bot secret
  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000002';
  if o.status <> 'sent' or o.request_id is null then
    raise exception 'FAIL T5 test row: status=% request_id=% not_ready=% err=%',
      o.status, o.request_id, o.not_ready_reason, o.response_error;
  end if;
  select * into q from net.http_request_queue where id = o.request_id;
  if not found then
    raise exception 'FAIL T5 test row: request % not in net.http_request_queue', o.request_id;
  end if;
  if q.url <> 'https://m1-bot.example.invalid/webhook/priority-push-test' then
    raise exception 'FAIL T5 test row went to %', q.url;
  end if;
  if (q.headers ->> 'X-Webhook-Secret') is distinct from v_bot_sec then
    raise exception 'FAIL T5 test row is not signed with the bot webhook secret (values not printed)';
  end if;
  if (q.headers ->> 'X-Webhook-Secret') = v_make_sec then
    raise exception 'FAIL T5 test row carries the Make secret (values not printed)';
  end if;
  if (convert_from(q.body, 'UTF8')::jsonb ->> 'delivery_id') <> 'a1000000-0000-4000-8000-000000000002' then
    raise exception 'FAIL T5 test row body has the wrong delivery_id';
  end if;

  -- the Prod row -> Make, Make secret (unchanged behaviour)
  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000003';
  if o.status <> 'sent' or o.request_id is null then
    raise exception 'FAIL T5 make row: status=% request_id=%', o.status, o.request_id;
  end if;
  select * into q from net.http_request_queue where id = o.request_id;
  if q.url <> 'https://m1-make.example.invalid/hook'
     or (q.headers ->> 'X-Webhook-Secret') is distinct from v_make_sec then
    raise exception 'FAIL T5 make row went to % or carries the wrong secret (values not printed)', q.url;
  end if;

  if (select count(*) from net.http_request_queue
       where url = 'https://m1-bot.example.invalid/webhook/priority-push-test') <> 1 then
    raise exception 'FAIL T5: expected exactly one request to the fake Make';
  end if;
  raise notice 'PASS T5 dispatch: test row -> test_url + bot secret, make row -> Make URL + Make secret';
end
$t$;

-- T6 test_url cleared after queueing -> the row is skipped, nothing is posted ------
do $t$
declare
  o record;
begin
  insert into public.deliveries (id, document_number, received_by_chat_id)
  values ('a1000000-0000-4000-8000-000000000006', 'M1TEST-T6', 990000000801);
  update public.deliveries set status = 'Complete'
   where id = 'a1000000-0000-4000-8000-000000000006';
  update public.priority_push_outbox set category = 'non_meat'
   where delivery_id = 'a1000000-0000-4000-8000-000000000006';

  update public.priority_push_config set test_url = null where id = 1;
  perform public.priority_push_dispatch();

  select * into o from public.priority_push_outbox
   where delivery_id = 'a1000000-0000-4000-8000-000000000006';
  if o.target <> 'test' or o.status <> 'skipped' or o.request_id is not null
     or o.response_error is distinct from
        'skipped: test row not sent - priority_push_config.test_url is not set' then
    raise exception 'FAIL T6: got target=% status=% request_id=% reason=%',
      o.target, o.status, o.request_id, o.response_error;
  end if;

  update public.priority_push_config
     set test_url = 'https://m1-bot.example.invalid/webhook/priority-push-test'
   where id = 1;
  raise notice 'PASS T6 a test row with no test_url is skipped, nothing posted';
end
$t$;

-- T7 the same-note guard compares rows of the same target only --------------------
do $t$
declare
  v_ids uuid[] := array['a1000000-0000-4000-8000-000000000007',   -- Test, will be 'delivered'
                        'a1000000-0000-4000-8000-000000000008',   -- Prod, same note
                        'a1000000-0000-4000-8000-000000000009',   -- Test, same note
                        'a1000000-0000-4000-8000-000000000010']::uuid[];  -- Prod, same note
  v_chat bigint[] := array[990000000801, 990000000802, 990000000801, 990000000802];
  v_dec  text;
begin
  for i in 1..4 loop
    insert into public.deliveries (id, document_number, received_by_chat_id)
    values (v_ids[i], 'M1TEST-SAME', v_chat[i]);
    update public.deliveries set status = 'Complete' where id = v_ids[i];
  end loop;
  -- the fake answered ok for the first test row
  update public.priority_push_outbox set status = 'delivered'
   where delivery_id = v_ids[1];

  select p.decision into v_dec from public.priority_push_plan() p where p.delivery_id = v_ids[2];
  if v_dec = 'hold_same_invoice' then
    raise exception 'FAIL T7: a delivered TEST row holds the real delivery of the same note';
  end if;

  select p.decision into v_dec from public.priority_push_plan() p where p.delivery_id = v_ids[3];
  if v_dec is distinct from 'hold_same_invoice' then
    raise exception 'FAIL T7: a second test row of the same note was not held (got %)', v_dec;
  end if;

  select p.decision into v_dec from public.priority_push_plan() p where p.delivery_id = v_ids[4];
  if v_dec is distinct from 'hold_same_invoice' then
    raise exception 'FAIL T7: a second real row of the same note was not held (got %)', v_dec;
  end if;
  raise notice 'PASS T7 same-note guard: test and real rows never hold each other; each world still holds';
end
$t$;

-- T7b a test row skips the Priority-receipt same-note check; a make row does not ---
-- M1's second plan() change (`if v_dup is null and rw.target = 'make'`). The
-- fixture is a Priority receipt whose BOOKNUM (the supplier's note number) equals
-- both deliveries' document number. It has origin 'priority' (not
-- 'priority_push') so notify_bot_priority_receipt() returns at once and posts
-- nothing, and delivery_id NULL (a receipt linked to no delivery).
do $t$
declare
  v_test uuid := 'a1000000-0000-4000-8000-000000000011';   -- Test receiver, target test
  v_make uuid := 'a1000000-0000-4000-8000-000000000012';   -- Prod receiver, target make
  o      record;
  v_dec  text;
  v_why  text;
begin
  update public.priority_push_config
     set test_url = 'https://m1-bot.example.invalid/webhook/priority-push-test'
   where id = 1;

  insert into public.priority_goods_receipts (doc, docno, booknum, origin, statdes)
  values (990000000901, 'M1TEST-GR1', 'M1TEST-GRNOTE', 'priority', 'draft');

  insert into public.deliveries (id, document_number, received_by_chat_id)
  values (v_test, 'M1TEST-GRNOTE', 990000000801),
         (v_make, 'M1TEST-GRNOTE', 990000000802);
  update public.deliveries set status = 'Complete' where id in (v_test, v_make);

  select * into o from public.priority_push_outbox where delivery_id = v_test;
  if not found or o.status <> 'queued' or o.target <> 'test' then
    raise exception 'FAIL T7b precondition: test row has status=% target=%', o.status, o.target;
  end if;
  select * into o from public.priority_push_outbox where delivery_id = v_make;
  if not found or o.status <> 'queued' or o.target <> 'make' then
    raise exception 'FAIL T7b precondition: make row has status=% target=%', o.status, o.target;
  end if;

  select p.decision into v_dec from public.priority_push_plan() p where p.delivery_id = v_test;
  if v_dec is null then
    raise exception 'FAIL T7b: the plan has no decision for the test row';
  end if;
  if v_dec = 'hold_same_invoice' then
    raise exception 'FAIL T7b: a real Priority receipt with the same note holds a TEST row';
  end if;

  select p.decision, p.reason into v_dec, v_why
    from public.priority_push_plan() p where p.delivery_id = v_make;
  if v_dec is distinct from 'hold_same_invoice' then
    raise exception 'FAIL T7b: the make row was not held by the Priority receipt of the same note (got %)', v_dec;
  end if;
  if v_why not like '%GR M1TEST-GR1%' then
    raise exception 'FAIL T7b: the make row was held, but not because of the Priority receipt: %', v_why;
  end if;
  raise notice 'PASS T7b same note in Priority: a test row is not held, a make row still is';
end
$t$;

-- T8 grants ---------------------------------------------------------------------
do $t$
begin
  if has_function_privilege('anon', 'public.finance_resend(uuid)', 'EXECUTE') then
    raise exception 'FAIL T8: anon can still execute finance_resend';
  end if;
  if has_function_privilege('authenticated', 'public.finance_resend(uuid)', 'EXECUTE') then
    raise exception 'FAIL T8: authenticated can still execute finance_resend';
  end if;
  if exists (select 1
               from pg_proc p, aclexplode(p.proacl) a
              where p.oid = 'public.finance_resend(uuid)'::regprocedure
                and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'FAIL T8: PUBLIC can still execute finance_resend';
  end if;
  if not has_function_privilege('service_role', 'public.finance_resend(uuid)', 'EXECUTE') then
    raise exception 'FAIL T8: service_role lost finance_resend';
  end if;
  if has_function_privilege('anon', 'public.priority_push_dispatch()', 'EXECUTE')
     or has_function_privilege('anon', 'public.priority_push_plan()', 'EXECUTE')
     or has_function_privilege('anon', 'public.priority_push_enqueue()', 'EXECUTE') then
    raise exception 'FAIL T8: anon can execute a priority_push function';
  end if;
  raise notice 'PASS T8 grants';
end
$t$;

do $t$ begin raise notice 'ALL PASS 2026-10-08-priority-push-01-safety-test-harness'; end $t$;
