-- =============================================================================
-- 2026-10-08  priority_push_02_outcomes_explain  (OUR Priority-push objects)
-- =============================================================================
--
-- STATUS: NOT APPLIED. Applied with mcp__supabase__apply_migration only after
--         Tonmoy's OK. Needs 2026-10-08-priority-push-01-safety-test-harness.sql
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
set search_path = public
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
          v_risk := public.priority_push_explain(r.delivery_id) -> 'unit_risk_lines';  -- M2
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
