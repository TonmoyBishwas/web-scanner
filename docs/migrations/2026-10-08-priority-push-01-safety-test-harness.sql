-- =============================================================================
-- 2026-10-08  priority_push_01_safety_test_harness   (M1, OUR objects only)
-- =============================================================================
--
-- STATUS: applied with mcp__supabase__apply_migration (name
--         priority_push_01_safety_test_harness) ONLY after Tonmoy's OK.
--         Test: tests/2026-10-08-priority-push-01-safety-test-harness.test.sql
--
-- Spec: telegram-warehouse-bot/docs/superpowers/specs/
--       2026-10-07-priority-push-dependable-design.md ("Testing" step 2,
--       "Security clean-up").
--
-- WHAT THIS FILE DOES
--   0. Guards: sets lock_timeout = 5 s (no statement queues behind another
--      session longer than that; past it the migration rolls back whole),
--      holds the dispatcher's advisory lock for the whole migration
--      (cron job 8 skips its ticks instead of blocking on the ALTERs below),
--      and REFUSES to run if any of the three functions it replaces whole has
--      changed since its 2026-10-07 live definition (md5), so nobody's later
--      change is silently undone.
--   1. priority_push_outbox.target ('make' | 'test'), default 'make'. Every
--      existing row and every Prod receiver's row stays 'make'.
--   2. priority_push_config.test_url / test_outcome. test_url is the bot's
--      fake Make (POST /webhook/priority-push-test); test_outcome is the reply
--      it plays: ok | reject_supplier | crash | accepted | silent, picked by
--      the tester before each run.
--   3. priority_push_enqueue()  REPLACED: a users.env = 'Test' receiver's
--      delivery is queued with target = 'test' instead of 'skipped' - ONLY
--      while test_url is set. test_url NULL (the default) = unchanged.
--   4. priority_push_plan()     REPLACED: the same-note guard
--      (hold_same_invoice) compares a row only with rows of the SAME target,
--      and a test row ignores real Priority receipts. Without this a test row
--      the fake marked 'delivered' would hold the real delivery of the same
--      supplier note for 90 days. No other decision changes.
--   5. priority_push_dispatch() REPLACED: a target = 'test' row is posted to
--      test_url, signed with the BOT webhook secret (bot_webhook_config.
--      secret_name in vault) - never to the Make URL, never with the Make
--      secret. A test row whose test_url was cleared after it was queued is
--      set 'skipped' and nothing is posted. The master switch still applies:
--      enabled = false or a blank Make URL sends nothing, test rows included.
--   6. finance_resend(uuid) loses EXECUTE for PUBLIC / anon / authenticated
--      (it was callable with the anon key). service_role keeps its own grant.
--
-- Nothing here sends anything by itself: with test_url NULL and 0 Test users
-- (2026-10-07) every live path behaves exactly as before.
--
-- ARM   (Tonmoy's OK first):
--   update public.priority_push_config
--      set test_url = 'https://web-production-f2759.up.railway.app/webhook/priority-push-test'
--    where id = 1;
-- PICK a reply before each run:
--   update public.priority_push_config set test_outcome = 'crash' where id = 1;
-- DISARM:
--   update public.priority_push_config set test_url = null where id = 1;
-- =============================================================================

-- 0. guards ---------------------------------------------------------------------
-- No statement below may queue behind another session for more than 5 s (the
-- ALTER TABLEs below need ACCESS EXCLUSIVE; a long reader or writer on
-- priority_push_outbox / priority_push_config would otherwise hold them - and
-- everything behind them - up). Past 5 s the statement errors, the whole
-- migration rolls back, and nothing is changed. Transaction-local, set before
-- the first lock, and outside every function body (so the md5 guard below,
-- which covers function bodies only, is not affected).
set local lock_timeout = '5s';

-- Take the dispatcher's lock FIRST and keep it to the end of this transaction.
-- From here on job 8 gets pg_try_advisory_xact_lock = false and returns 0
-- without touching a table. Without this, a job 8 tick that starts after the
-- ALTERs below holds the lock while it waits on them, and the test file's own
-- pg_advisory_xact_lock would then wait on job 8: a deadlock.
select pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

-- Sections 3-5 replace three functions WHOLE, from their live definitions read
-- 2026-10-07. Refuse if any of them has changed since (or M1 is already in).
do $guard$
declare
  r record;
begin
  for r in
    select x.fn, x.md5_expected,
           md5(pg_get_functiondef(('public.' || x.fn || '()')::regprocedure)) as md5_live
      from (values ('priority_push_enqueue',  'd77afae69c67d57466287282f0202015'),
                   ('priority_push_plan',     'd5e50df73cf79280fd676bb3ca465dca'),
                   ('priority_push_dispatch', '5ec65912d892e26564eb9a7815d000b2')) as x(fn, md5_expected)
  loop
    if r.md5_live <> r.md5_expected then
      raise exception 'M1 refused: public.%() is not its 2026-10-07 definition (md5 % <> %); it was changed since, or M1 is already applied. Re-apply only the -- M1 lines to its live definition.',
        r.fn, r.md5_live, r.md5_expected;
    end if;
  end loop;
end
$guard$;

-- 1. outbox target ------------------------------------------------------------
alter table public.priority_push_outbox
  add column if not exists target text not null default 'make'
    constraint priority_push_outbox_target_check check (target in ('make', 'test'));
comment on column public.priority_push_outbox.target is
  '2026-10-08: make = the client''s Make webhook (priority_push_config.url); test = the bot''s fake Make (priority_push_config.test_url), for users.env = Test receivers only.';

-- 2. config: the fake Make ------------------------------------------------------
alter table public.priority_push_config
  add column if not exists test_url text,
  add column if not exists test_outcome text not null default 'ok'
    constraint priority_push_config_test_outcome_check
    check (test_outcome in ('ok', 'reject_supplier', 'crash', 'accepted', 'silent'));
comment on column public.priority_push_config.test_url is
  '2026-10-08: the bot''s fake Make (POST /webhook/priority-push-test). Set = Test receivers'' deliveries are queued with target test and posted here; NULL = they are skipped as before.';
comment on column public.priority_push_config.test_outcome is
  '2026-10-08: the reply the fake Make plays: ok (200 ok:true, docno TEST-...), reject_supplier (400 createHeader missing supplier), crash (500 Scenario failed to complete.), accepted (200 Accepted), silent (no reply within the 120 s timeout).';

-- 3. enqueue --------------------------------------------------------------------
-- Live definition read 2026-10-07 with pg_get_functiondef; changes marked M1.
CREATE OR REPLACE FUNCTION public.priority_push_enqueue()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_env      public.user_env;
  v_reason   text;
  v_cat      text;
  v_gr       text;
  v_status   text;
  v_target   text := 'make';   -- M1
  v_test_url text;             -- M1
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status::text not in ('Complete', 'Has Discrepancy') then
    return new;
  end if;

  select u.env into v_env from public.users u where u.chat_id = new.received_by_chat_id;
  -- M1: a Test receiver goes to the fake Make while test_url is set; with no
  -- test_url it is skipped exactly as before.
  if coalesce(v_env, 'Prod'::public.user_env) = 'Test'::public.user_env then
    select nullif(btrim(c.test_url), '') into v_test_url
      from public.priority_push_config c
     where c.id = 1;
    if v_test_url is not null then
      v_target := 'test';
    else
      v_reason := 'skipped: Test user ' || coalesce(new.received_by_chat_id::text, '?');
    end if;
  end if;

  v_cat := public.priority_push_delivery_category(new.id);

  select g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?') || ')'
    into v_gr
    from public.priority_goods_receipts g
   where g.delivery_id = new.id
     and g.origin <> 'warehouse_bot'
   order by g.synced_at desc
   limit 1;

  v_status := case when v_reason is not null              then 'skipped'
                   when v_gr is not null                  then 'already_in_priority'
                   when old.status::text = 'In Progress'  then 'queued'
                   else 'skipped' end;
  if v_status = 'already_in_priority' then
    v_reason := 'not sent: Priority already has GR ' || v_gr;
  elsif v_status = 'skipped' and v_reason is null then
    v_reason := 'skipped: status change ' || old.status::text || ' -> ' || new.status::text
                || ' on an already-closed delivery with no outbox row; never sent by itself'
                || ' (to send it on purpose set status ''queued'' and released_at)';
  end if;

  insert into public.priority_push_outbox as o
         (delivery_id, document_number, delivery_status, category, status, response_error,
          target)                                                            -- M1
  values (new.id, new.document_number, new.status::text, v_cat, v_status, v_reason,
          v_target)                                                          -- M1
  on conflict (delivery_id) do update
     set delivery_status = excluded.delivery_status,
         category        = coalesce(o.category, excluded.category);
  return new;
exception when others then
  begin
    insert into public.bot_webhook_log (event, delivery_id, error)
    values ('priority_push_enqueue', new.id, left(sqlerrm, 500));
  exception when others then
    null;
  end;
  return new;
end
$function$;

-- 4. plan -----------------------------------------------------------------------
-- Live definition read 2026-10-07 with pg_get_functiondef; changes marked M1.
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

      -- 2026-10-04: only a mapping made for THIS supplier is trusted. A line
      -- the client's resolver matched by a guess (another supplier's code, or
      -- a code that merely equals a PARTNAME) is treated as unmapped.
      select array_agg(distinct coalesce(l ->> 'SRC_CODE', '?'))
        into v_guessed
        from jsonb_array_elements(
               coalesce(public.wb_build_priority_gr_full(rw.delivery_id) -> 'TRANSORDER_P', '[]'::jsonb)) l
       where (l ->> 'METHOD') is distinct from 'vat_sku';
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

-- 5. dispatch -------------------------------------------------------------------
-- Live definition read 2026-10-07 with pg_get_functiondef; changes marked M1.
-- M2 (2026-10-08-priority-push-02-outcomes-explain.sql) must start from THIS
-- body (or the live one after M1) so the target routing below survives.
CREATE OR REPLACE FUNCTION public.priority_push_dispatch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'vault', 'pg_temp'
AS $function$
declare
  cfg     public.priority_push_config%rowtype;
  v_found boolean;
  sec     text;
  p       record;
  r       record;
  req     bigint;
  n       integer := 0;
  v_url   text;   -- M1: where this row goes (Make, or the fake Make for target 'test')
  v_sec   text;   -- M1: the secret that goes with v_url
  c_timeout_ms constant integer  := 120000;
  c_no_reply   constant interval := interval '10 minutes';
  c_never_left constant text     := 'could(n.t| not) (resolve host|connect to server)|connection refused';
begin
  if not pg_try_advisory_xact_lock(hashtext('public.priority_push_dispatch')) then
    return 0;
  end if;

  select * into cfg from public.priority_push_config c where c.id = 1;
  v_found := found;

  update public.priority_push_outbox o
     set status_code    = h.status_code,
         response_body  = left(h.content, 1000),
         response_error = case
                            when o.status = 'delivered' then o.response_error
                            when h.status_code between 200 and 299 and not h.confirmed
                            then 'HTTP ' || h.status_code || ' without the scenario''s {"ok":true} confirmation'
                                 || ' (body in response_body); it may have created a Priority draft'
                                 || ' - check Priority before re-sending'
                            else coalesce(h.error_msg,
                                          case when h.status_code is null or h.status_code >= 300
                                               then left(h.content, 500) end)
                          end,
         responded_at   = coalesce(h.created, now()),
         status         = case
                            when o.status = 'delivered'                        then 'delivered'
                            when h.confirmed                                   then 'delivered'
                            when h.status_code between 400 and 499             then 'failed'
                            when o.status = 'sent' and h.never_left
                                 and o.attempts < coalesce(cfg.max_attempts, 3) then 'queued'
                            when o.status = 'sent' and h.never_left            then 'failed'
                            else 'unconfirmed'
                          end,
         next_check_at  = case
                            when o.status = 'sent' and h.never_left
                                 and o.attempts < coalesce(cfg.max_attempts, 3)
                            then now() + make_interval(mins => coalesce(cfg.recheck_minutes, 10))
                          end
    from (select hr.id, hr.status_code, hr.content, hr.error_msg, hr.created,
                 (hr.status_code is null
                  and hr.timed_out is not true
                  and coalesce(hr.error_msg ~* c_never_left, false)) as never_left,
                 (hr.status_code between 200 and 299
                  and coalesce(case when pg_input_is_valid(hr.content, 'jsonb')
                                    then (hr.content::jsonb -> 'ok') = 'true'::jsonb
                               end, false)) as confirmed
            from net._http_response hr) h
   where h.id = o.request_id
     and o.status in ('sent', 'unconfirmed', 'delivered')
     and o.responded_at is null;

  update public.priority_push_outbox o
     set status         = 'unconfirmed',
         response_error = 'no reply read back ' || c_no_reply::text || ' after sending (pg_net request '
                          || coalesce(o.request_id::text, '?')
                          || ' has no reply row and is no longer queued); it may have reached the webhook'
                          || ' - check Priority before re-sending',
         next_check_at  = null
   where o.status = 'sent'
     and o.responded_at is null
     and coalesce(o.sent_at, o.queued_at) < now() - c_no_reply
     and not exists (select 1 from net._http_response h where h.id = o.request_id)
     and not exists (select 1 from net.http_request_queue q where q.id = o.request_id);

  update public.priority_push_outbox o
     set status         = 'delivered',
         response_error = left('confirmed by write-back: Priority has GR ' || w.gr
                               || ' (was ' || o.status || coalesce(': ' || o.response_error, '') || ')',
                               1000),
         next_check_at  = null
    from (select o2.id,
                 (select g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?') || ')'
                    from public.priority_goods_receipts g
                   where g.delivery_id = o2.delivery_id
                     and g.origin <> 'warehouse_bot'
                   order by g.synced_at desc
                   limit 1) as gr
            from public.priority_push_outbox o2
           where o2.status in ('sent', 'unconfirmed')) w
   where w.id = o.id
     and w.gr is not null
     and o.status in ('sent', 'unconfirmed');

  if not v_found or not cfg.enabled or nullif(btrim(cfg.url), '') is null then
    return 0;
  end if;

  select ds.decrypted_secret
    into sec
    from vault.decrypted_secrets ds
   where ds.name = cfg.secret_name
   limit 1;
  if sec is null or sec = '' then
    return 0;
  end if;

  for p in select * from public.priority_push_plan() loop
    if p.decision = 'already_in_priority' then
      update public.priority_push_outbox o
         set status = 'already_in_priority',
             response_error = p.reason,
             next_check_at = null
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');

    elsif p.decision in ('not_ready', 'error') then
      update public.priority_push_outbox o
         set status = 'waiting',
             not_ready_reason = case when p.decision = 'error' then 'error: ' || p.reason else p.reason end,
             unmapped_codes = p.codes,
             next_check_at = now() + make_interval(mins => cfg.recheck_minutes)
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');

    elsif p.decision = 'expired' then
      update public.priority_push_outbox o
         set status = 'expired',
             not_ready_reason = p.reason,
             unmapped_codes = p.codes,
             next_check_at = null
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');

    elsif p.decision = 'send' then
      select o.id, o.delivery_id, o.document_number, o.delivery_status,
             coalesce(o.category, public.priority_push_delivery_category(o.delivery_id)) as category,
             o.target,                                                        -- M1
             d.supplier_hebrew, d.supplier_vat, d.received_by_chat_id
        into r
        from public.priority_push_outbox o
        join public.deliveries d on d.id = o.delivery_id
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');
      if found then
        -- M1: pick the destination. 'make' = the client's Make webhook with the
        -- Make secret (unchanged). 'test' = the bot's fake Make with the bot
        -- webhook secret; the Make URL and the Make secret never go there.
        v_url := cfg.url;
        v_sec := sec;
        if r.target = 'test' then
          v_url := nullif(btrim(cfg.test_url), '');
          v_sec := null;
          if v_url is not null then
            select ds.decrypted_secret
              into v_sec
              from vault.decrypted_secrets ds
             where ds.name = coalesce((select b.secret_name
                                         from public.bot_webhook_config b
                                        where b.enabled
                                        order by b.updated_at desc, b.id
                                        limit 1),
                                      'bot_webhook_secret')
             limit 1;
          end if;
          if v_url is null or v_sec is null or v_sec = '' then
            update public.priority_push_outbox o
               set status         = 'skipped',
                   response_error = 'skipped: test row not sent - '
                                    || case when v_url is null
                                            then 'priority_push_config.test_url is not set'
                                            else 'the bot webhook secret is missing in vault' end,
                   next_check_at  = null
             where o.id = r.id;
            continue;
          end if;
        end if;
        begin
          select net.http_post(
            url := v_url,                                                     -- M1 (was cfg.url)
            headers := jsonb_build_object('Content-Type', 'application/json',
                                          'X-Webhook-Secret', v_sec),         -- M1 (was sec)
            body := jsonb_build_object(
              'event', 'delivery_closed',
              'delivery_id', r.delivery_id,
              'document_number', r.document_number,
              'status', r.delivery_status,
              'category', r.category,
              'supplier_name', r.supplier_hebrew,
              'supplier_vat', r.supplier_vat,
              'received_by_chat_id', r.received_by_chat_id),
            timeout_milliseconds := c_timeout_ms) into req;
          update public.priority_push_outbox o
             set status = 'sent', request_id = req, attempts = o.attempts + 1,
                 sent_at = now(), responded_at = null, status_code = null, response_error = null,
                 response_body = null,
                 not_ready_reason = case when p.reason like 'sent although not ready%' then p.reason end,
                 unmapped_codes = p.codes, next_check_at = null,
                 category = r.category
           where o.id = r.id;
          n := n + 1;
        exception when others then
          update public.priority_push_outbox o
             set attempts = o.attempts + 1,
                 response_error = left(sqlerrm, 500),
                 status = case when o.attempts + 1 >= cfg.max_attempts then 'failed' else 'queued' end,
                 next_check_at = now() + make_interval(mins => cfg.recheck_minutes)
           where o.id = r.id;
        end;
      end if;
    end if;
  end loop;
  return n;
end
$function$;

-- 6. grants ---------------------------------------------------------------------
-- CREATE OR REPLACE keeps a function's ACL; these re-assert it (live 2026-10-07:
-- postgres + service_role only) so a future re-create cannot widen it.
revoke execute on function public.priority_push_enqueue()  from public, anon, authenticated;
revoke execute on function public.priority_push_plan()     from public, anon, authenticated;
revoke execute on function public.priority_push_dispatch() from public, anon, authenticated;

-- finance_resend(uuid) is SECURITY DEFINER and posts invoice OCR to the finance
-- webhook; until now anyone holding the anon key could call it over PostgREST.
-- service_role has its own explicit grant and keeps it.
revoke execute on function public.finance_resend(uuid) from public, anon, authenticated;
