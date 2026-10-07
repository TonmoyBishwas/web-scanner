-- =============================================================================
-- 2026-10-08  priority_push_02_outcomes_explain  (OUR Priority-push objects)
-- =============================================================================
--
-- STATUS: APPLIED 2026-10-07 13:08:34 UTC with Tonmoy's OK, byte-exact via psycopg in one
--         transaction, recorded in supabase_migrations.schema_migrations as
--         20261007130834 priority_push_02_outcomes_explain (rollback copy in the row).
--         Post-apply: plan 1d4ccf3c… (unchanged), dispatch aea4b948…, M2 + M1 tests pass
--         without --setup, job 8 succeeding, explain on 43/45/53/54/253 as expected.
--         Needs 2026-10-08-priority-push-01-safety-test-harness.sql
--         (M1) applied first; the guard below refuses to run without it, and
--         refuses if priority_push_plan() / priority_push_dispatch() are no
--         longer exactly M1's versions.
--
-- WHY
--   * A reply is overwritten by the next send (dispatch sets status_code,
--     response_body, response_error back to NULL), so the evidence of what
--     Make answered is lost on any re-send.
--   * A held row (hold_same_invoice, hold_pre_enable, ...) stays 'queued' with
--     nothing recorded: nobody can see why it is not going to Priority.
--   * Nothing says which lines leave in a unit the client's builder will get
--     wrong (a line with no Priority item is labelled kg: "525 kg of bread").
--
-- WHAT THIS FILE DOES (OUR objects only; the client's wb_* are only READ)
--   Part 1
--   * priority_push_outbox  + alerted_at, alert_kind, alert_tries,
--                             worker_notified_at, hold_reason, unit_risk_lines
--   * priority_push_config  + hold_unit_risk (default false; NOT read by any
--                             function yet: unit-risk lines are sent, flagged
--                             and alerted, never held - spec decision)
--   * bot_webhook_log       + status_code, reply_error, outbox_id, kind
--   * priority_push_attempts  NEW  append-only: one row per request whose reply
--       was about to be overwritten (by a send, or by a guarded re-send)
--   * normalize_note_number(text)  NEW  IMMUTABLE: digits only
--       ('71:26189988' -> '7126189988', '*200160*' -> '200160', '' -> NULL)
--   * priority_push_archive_reply(bigint, text, text)  NEW: copies the row's
--       current request + reply into priority_push_attempts, once per request_id
--   * priority_push_dispatch()  REPLACED, starting from M1's body (M1's
--       "-- M1" test routing is kept unchanged); additive only:
--       - the previous reply is archived before a send overwrites it
--       - the body gains outbox_id and attempt
--       - unit_risk_lines is stored at send time from priority_push_explain()
--       - a held row gets plan()'s reason in hold_reason. plan() is STABLE and
--         cannot write, so dispatch writes what plan() returned; plan() itself
--         is NOT changed. hold_reason is cleared when the row leaves the queue.
--   Part 2 (appended by Task 7): priority_push_explain(uuid), at the end.
-- =============================================================================

-- No statement below may queue behind another session for more than 5 s (the
-- ALTER TABLEs below need ACCESS EXCLUSIVE). Past 5 s the statement errors, the
-- whole migration rolls back, and nothing is changed. Transaction-local, set
-- before the first lock, and outside every function body (so the md5 guard
-- below, which covers function bodies only, is not affected).
set local lock_timeout = '5s';

-- Job 8 takes this lock on every tick; holding it here makes job 8 skip its
-- ticks while this file runs instead of blocking on the ALTER TABLE locks.
select pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

do $guard$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'priority_push_outbox'
                    and column_name = 'target')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'priority_push_config'
                       and column_name = 'test_url') then
    raise exception 'M2 refused: apply 2026-10-08-priority-push-01-safety-test-harness.sql (M1) first';
  end if;
  -- priority_push_explain() (part 2) mirrors plan() exactly as M1 leaves it, and
  -- the dispatch below is M1's body plus the "-- M2" lines. md5 values measured
  -- 2026-10-07 by running M1 (plan part 02, Task 4) inside BEGIN ... ROLLBACK.
  if md5(pg_get_functiondef('public.priority_push_plan()'::regprocedure))
     <> '1d4ccf3c3595dc943f74e581be309b3b' then
    raise exception 'M2 refused: priority_push_plan() is not M1''s version (md5 %); re-check priority_push_explain() against it first',
      md5(pg_get_functiondef('public.priority_push_plan()'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.priority_push_dispatch()'::regprocedure))
     <> '408deca54052b5ced70ee2ea79cd6547' then
    raise exception 'M2 refused: priority_push_dispatch() is not M1''s version (md5 %), or M2 is already applied; rebuild the dispatch below from the live body',
      md5(pg_get_functiondef('public.priority_push_dispatch()'::regprocedure));
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- columns
-- ---------------------------------------------------------------------------
alter table public.priority_push_outbox
  add column if not exists alerted_at         timestamptz,
  add column if not exists alert_kind         text,
  add column if not exists alert_tries        integer not null default 0,
  add column if not exists worker_notified_at timestamptz,
  add column if not exists hold_reason        text,
  add column if not exists unit_risk_lines    jsonb;
comment on column public.priority_push_outbox.alerted_at is
  '2026-10-08: when the office was last alerted about this row (one alert per alert_kind).';
comment on column public.priority_push_outbox.alert_kind is
  '2026-10-08: the kind of the last alert sent for this row (failed, unconfirmed, expired, delivered, no_writeback, held).';
comment on column public.priority_push_outbox.alert_tries is
  '2026-10-08: how many times the alert was re-sent because the bot did not answer 2xx (watch gives up at 3).';
comment on column public.priority_push_outbox.worker_notified_at is
  '2026-10-08: when the receiving worker got their one outcome line for this row.';
comment on column public.priority_push_outbox.hold_reason is
  '2026-10-08: why plan() is holding this queued row (plan()''s own reason text); NULL once the row leaves the queue.';
comment on column public.priority_push_outbox.unit_risk_lines is
  '2026-10-08: priority_push_explain(delivery)->unit_risk_lines at send time: lines the client''s builder will likely send in the wrong unit.';

alter table public.priority_push_config
  add column if not exists hold_unit_risk boolean not null default false;
comment on column public.priority_push_config.hold_unit_risk is
  '2026-10-08: reserved, NOT read by any function yet. Unit-risk lines are sent, flagged (priority_push_outbox.unit_risk_lines) and alerted, never held (spec decision, 2026-10-07). Setting it to true changes nothing.';

alter table public.bot_webhook_log
  add column if not exists status_code integer,
  add column if not exists reply_error text,
  add column if not exists outbox_id   bigint,
  add column if not exists kind        text;
comment on column public.bot_webhook_log.status_code is
  '2026-10-08: the bot''s HTTP answer, copied from net._http_response while it is kept (6 h).';
comment on column public.bot_webhook_log.reply_error is
  '2026-10-08: pg_net error / timeout text for the bot call, when there was no HTTP answer.';
comment on column public.bot_webhook_log.outbox_id is
  '2026-10-08: priority_push_outbox.id for event priority_push_outcome rows.';
comment on column public.bot_webhook_log.kind is
  '2026-10-08: outcome kind for event priority_push_outcome rows (failed, unconfirmed, expired, delivered, no_writeback, held, not_queued, digest).';

-- ---------------------------------------------------------------------------
-- priority_push_attempts: the replies a later send would otherwise overwrite
-- ---------------------------------------------------------------------------
create table if not exists public.priority_push_attempts (
  id               bigserial primary key,
  outbox_id        bigint references public.priority_push_outbox(id) on delete cascade,
  attempt          integer,
  request_id       bigint,
  sent_at          timestamptz,
  responded_at     timestamptz,
  status_code      integer,
  response_body    jsonb,
  response_error   text,
  not_ready_reason text,
  unmapped_codes   jsonb,
  archived_by      text,
  reason           text,
  created_at       timestamptz not null default now()
);
-- Deliberately NOT unique on (outbox_id, request_id): priority_push_resend /
-- priority_push_mark_found (M4) insert their own rows, and the same request can
-- be archived once per reason (resend, then mark_found). archive_reply below
-- skips a request that already has any row.
create index if not exists idx_priority_push_attempts_outbox
  on public.priority_push_attempts (outbox_id, request_id);
alter table public.priority_push_attempts enable row level security;
revoke all on table public.priority_push_attempts from anon, authenticated;
comment on table public.priority_push_attempts is
  '2026-10-08: append-only history of priority_push_outbox replies. attempt = the ordinal of that request for the outbox row (1 = first send). reason: reply_overwritten (dispatch, before a new send), resend (priority_push_resend) or mark_found (priority_push_mark_found).';

-- ---------------------------------------------------------------------------
-- normalize_note_number: digits only
-- ---------------------------------------------------------------------------
create or replace function public.normalize_note_number(p text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $function$
  select nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '');
$function$;
comment on function public.normalize_note_number(text) is
  '2026-10-08: a supplier note number reduced to its digits, so "71:26189988", "7126189988" and "*7126189988*" compare equal. NULL when there is no digit.';
revoke execute on function public.normalize_note_number(text) from public, anon, authenticated;
grant  execute on function public.normalize_note_number(text) to service_role;

-- ---------------------------------------------------------------------------
-- priority_push_archive_reply: keep the reply before it is overwritten
-- ---------------------------------------------------------------------------
create or replace function public.priority_push_archive_reply(
  p_outbox_id bigint, p_reason text, p_by text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_attempt integer;
begin
  -- the ordinal of the request being archived: 1 for the row's first send.
  -- count(distinct): a request archived twice (resend, then mark_found) is one send.
  select count(distinct a.request_id) + 1 into v_attempt
    from public.priority_push_attempts a
   where a.outbox_id = p_outbox_id;

  insert into public.priority_push_attempts
         (outbox_id, attempt, request_id, sent_at, responded_at, status_code,
          response_body, response_error, not_ready_reason, unmapped_codes,
          archived_by, reason)
  select o.id, v_attempt, o.request_id, o.sent_at, o.responded_at, o.status_code,
         case when o.response_body is null then null
              when pg_input_is_valid(o.response_body, 'jsonb') then o.response_body::jsonb
              else to_jsonb(o.response_body)          -- e.g. "Accepted"
         end,
         o.response_error, o.not_ready_reason, to_jsonb(o.unmapped_codes),
         p_by, p_reason
    from public.priority_push_outbox o
   where o.id = p_outbox_id
     and o.request_id is not null                     -- never sent: nothing to keep
     and not exists (select 1 from public.priority_push_attempts a
                      where a.outbox_id = o.id
                        and a.request_id = o.request_id);   -- already kept

  if not found then
    return null;                                      -- already archived, or never sent
  end if;
  return v_attempt;
end
$function$;
comment on function public.priority_push_archive_reply(bigint, text, text) is
  '2026-10-08: copies the outbox row''s current request + reply into priority_push_attempts, unless that request_id already has a row. Returns the attempt ordinal archived, or NULL when there was nothing new to archive. Called by priority_push_dispatch() before a send; priority_push_resend() / priority_push_mark_found() should call it too.';
-- internal: only our SECURITY DEFINER functions call it (Supabase's default
-- privileges would otherwise hand EXECUTE to service_role as well)
revoke execute on function public.priority_push_archive_reply(bigint, text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- priority_push_dispatch: full body. The base is M1's version (plan part 02,
-- Task 4; md5 checked by the guard above). Lines marked "-- M1" are M1's and
-- unchanged; every change made here is marked "-- M2".
-- ---------------------------------------------------------------------------
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
  v_attempt integer;  -- M2: ordinal of this send for the outbox row
  v_risk    jsonb;    -- M2: unit_risk_lines at send time
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
             next_check_at = null,
             hold_reason = null                                               -- M2
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');

    elsif p.decision in ('not_ready', 'error') then
      update public.priority_push_outbox o
         set status = 'waiting',
             not_ready_reason = case when p.decision = 'error' then 'error: ' || p.reason else p.reason end,
             unmapped_codes = p.codes,
             next_check_at = now() + make_interval(mins => cfg.recheck_minutes),
             hold_reason = null                                               -- M2
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');

    elsif p.decision = 'expired' then
      update public.priority_push_outbox o
         set status = 'expired',
             not_ready_reason = p.reason,
             unmapped_codes = p.codes,
             next_check_at = null,
             hold_reason = null                                               -- M2
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');

    -- M2: a held row is no longer silent. plan() is STABLE, so its reason is
    -- M2: written here; only when it changed, so a steady hold writes nothing.
    elsif p.decision in ('hold_local_draft', 'hold_not_closed', 'hold_same_invoice',   -- M2
                         'hold_pre_enable', 'hold_category', 'hold_pre_category',     -- M2
                         'wait_po') then                                              -- M2
      update public.priority_push_outbox o                                            -- M2
         set hold_reason = left(p.reason, 1000)                                       -- M2
       where o.id = p.outbox_id                                                       -- M2
         and o.status in ('queued', 'waiting')                                        -- M2
         and o.hold_reason is distinct from left(p.reason, 1000);                     -- M2

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
                   next_check_at  = null,
                   hold_reason    = null                                      -- M2
             where o.id = r.id;
            continue;
          end if;
        end if;

        -- M2: keep the previous request's reply before this send clears it.
        -- M2: never allowed to stop the send.
        begin                                                                 -- M2
          perform public.priority_push_archive_reply(r.id, 'reply_overwritten', 'priority_push_dispatch');  -- M2
        exception when others then                                            -- M2
          raise warning 'priority_push_dispatch: archiving outbox % failed: %', r.id, sqlerrm;  -- M2
        end;                                                                  -- M2
        select count(distinct a.request_id) + 1 into v_attempt                -- M2
          from public.priority_push_attempts a                                -- M2
         where a.outbox_id = r.id;                                            -- M2

        -- M2: which lines leave in a unit the client's builder will likely get
        -- M2: wrong. Never allowed to stop the send: NULL when explain fails
        -- M2: (or does not exist yet, between Task 6 and Task 7).
        begin                                                                 -- M2
          -- M2: explain returns JSON null for "lines could not be resolved"; store that as SQL NULL (unknown).
          v_risk := nullif(public.priority_push_explain(r.delivery_id) -> 'unit_risk_lines', 'null'::jsonb);  -- M2
        exception when others then                                            -- M2
          v_risk := null;                                                     -- M2
        end;                                                                  -- M2

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
              'received_by_chat_id', r.received_by_chat_id,
              'outbox_id', r.id,                                              -- M2
              'attempt', v_attempt),                                          -- M2
            timeout_milliseconds := c_timeout_ms) into req;
          update public.priority_push_outbox o
             set status = 'sent', request_id = req, attempts = o.attempts + 1,
                 sent_at = now(), responded_at = null, status_code = null, response_error = null,
                 response_body = null,
                 not_ready_reason = case when p.reason like 'sent although not ready%' then p.reason end,
                 unmapped_codes = p.codes, next_check_at = null,
                 category = r.category,
                 unit_risk_lines = v_risk,                                    -- M2
                 hold_reason = null                                           -- M2
           where o.id = r.id;
          n := n + 1;
        exception when others then
          update public.priority_push_outbox o
             set attempts = o.attempts + 1,
                 response_error = left(sqlerrm, 500),
                 status = case when o.attempts + 1 >= cfg.max_attempts then 'failed' else 'queued' end,
                 next_check_at = now() + make_interval(mins => cfg.recheck_minutes),
                 hold_reason = null                                           -- M2
           where o.id = r.id;
        end;
      end if;
    end if;
  end loop;
  return n;
end
$function$;
comment on function public.priority_push_dispatch() is
  'pg_cron job 8, every 15 s. Reads pg_net replies back AT MOST ONCE (2xx with the scenario''s {"ok":true} body delivered; 4xx failed; only a request that provably never left - DNS / TCP connect failure - is re-queued, up to max_attempts; timeout, 5xx, any other 2xx and anything else unconfirmed, never re-sent by itself), marks a long-silent sent row unconfirmed, confirms sent/unconfirmed rows by the scenario''s write-back (priority_goods_receipts), then (only when enabled, url set and the vault secret exists) applies priority_push_plan(): at most 20 sends per run, 120 s timeout. 2026-10-08 (M1): target=test rows go to priority_push_config.test_url signed with the bot secret, or become skipped when test_url is not set. 2026-10-08 (M2): the previous reply is archived in priority_push_attempts before a send; the body gains outbox_id + attempt; unit_risk_lines is stored at send; a held row records plan()''s reason in hold_reason.';
-- CREATE OR REPLACE keeps the ACL; re-assert it (postgres + service_role only).
revoke execute on function public.priority_push_dispatch() from public, anon, authenticated;
-- ---------------------------------------------------------------------------
-- Part 2: priority_push_explain(delivery_id) - the one answer to "will this
-- delivery go to Priority, and what will be wrong with it?"
--
-- * decision: what priority_push_plan() would decide for this delivery if its
--   outbox row were due now (rules copied from plan() as M1 leaves it,
--   including M1's per-target same-note guard; the guard at the top of this
--   file refuses to apply if plan() is not that version).
--   No outbox row yet = as if enqueued now (target 'test' for a Test receiver
--   while test_url is set, as M1's enqueue does). Answers plan() cannot give:
--   'skipped_test' (a Test receiver that enqueue skips, or a target 'test'
--   row that dispatch will mark skipped because test_url is not set),
--   'disabled' (push off: dispatch sends nothing), and plan()'s 'send' split
--   into 'send' / 'send_unready'. plan()'s 'expired', 'error' and 'not_ready'
--   come through unchanged (only reachable while send_unready is off, or when
--   the builder raises).
-- * hold_reason: plan()'s own reason text for every decision that is not a
--   send, so it equals what priority_push_dispatch() writes into
--   priority_push_outbox.hold_reason (and, for skipped_test, the outbox row's
--   response_error text).
-- * lines: one per delivery_items row, resolved with the client's own
--   wb_resolve_partname (as his builder does) and flagged with unit_risk:
--     no_item_defaults_kg  no Priority item: his builder labels it kg
--     unit_unknown         the note printed no unit (delivery_items.unit =
--                          'unknown', bot Task 16): nobody knows what the
--                          count is in, whatever the Priority item's unit
--     count_to_kg_item     our unit is not kg, the item is kg
--     kg_to_unit_item      our unit is kg, the item counts units (יח / יח')
--     packs_not_units      our unit is cartons / boxes / packs
--   (יח = "units" in the client's catalog; ק'ג = kg.)
--   A meat line with no unit counts as kg (meat is always weighed).
--   If resolving the lines raises, lines is [] but unit_risk_lines is JSON null
--   (unknown, not "none at risk") and lines_error holds the error text; on the
--   normal path lines_error is JSON null, so the key set never changes.
-- * outbox_id / outbox_status: extra keys, so a caller can tell a queued row
--   from a terminal one without a second query.
-- Reads the client's wb_gr_priority_body / wb_build_priority_gr_full /
-- wb_resolve_partname (all STABLE); never writes anything.
-- ---------------------------------------------------------------------------
create or replace function public.priority_push_explain(p_delivery_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
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
          left join lateral public.wb_resolve_partname(di.item_code, v_vat) r on true
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
comment on function public.priority_push_explain(uuid) is
  '2026-10-08: read-only. What priority_push_plan() would decide for this delivery and why (decision, hold_reason = plan()''s reason text), its readiness (the client''s wb_gr_priority_body + the vat_sku rule), supplier resolution, every line with its Priority item, units and unit_risk (no_item_defaults_kg / unit_unknown / count_to_kg_item / kg_to_unit_item / packs_not_units), and is_test. unit_risk_lines is JSON null and lines_error holds the error text when the lines could not be resolved (unknown, not none). Works with or without an outbox row. Used by the bot''s readiness check, the scanner''s /api/priority-status, priority_push_watch() and dispatch (unit_risk_lines at send).';
revoke execute on function public.priority_push_explain(uuid) from public, anon, authenticated;
grant  execute on function public.priority_push_explain(uuid) to service_role;
