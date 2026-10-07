-- =============================================================================
-- 2026-10-08  priority_push_03_alerts_watch  (OUR Priority-push objects)
-- =============================================================================
--
-- STATUS: APPLIED 2026-10-07 13:21:44 UTC with Tonmoy's OK, byte-exact via psycopg in one
--         transaction, recorded as 20261007132144 priority_push_03_alerts_watch (rollback
--         copy in the row), right after the slice-3 bot (595f25b, Railway ee00026a) went
--         SUCCESS. Post-apply: M3/M2/M1 tests pass without --setup; cron jobs 57 watch /
--         58 digest active; baseline stamped 14 rows; no alert sent about the past.
--         It was applied only when ALL of these held:
--           1. M1 2026-10-08-priority-push-01-safety-test-harness.sql is applied;
--           2. M2 2026-10-08-priority-push-02-outcomes-explain.sql is applied
--              (outbox alerted_at / alert_kind / alert_tries / worker_notified_at /
--              hold_reason / unit_risk_lines, bot_webhook_log status_code /
--              reply_error / outbox_id / kind, priority_push_attempts,
--              priority_push_explain(uuid));
--           3. the bot build that answers event 'priority_push_outcome' on
--              /webhook/priority-receipt (bot/services/priority_alerts.py) is
--              LIVE on Railway (railway deployment list -> SUCCESS): slice 3's
--              bot must be live before M3. The bot live before slice 3 (716a0b2)
--              answers that event with 400 "priority_docno required" and sends
--              nothing, so every alert would be retried 3 times and then lost.
--         The guard below refuses to run without 1 and 2.
--
-- NO BEGIN / COMMIT IN THIS FILE: the apply runs it in one transaction,
--         and scripts/sql/run_sql_test.py runs it inside BEGIN ... ROLLBACK for
--         the tests. A COMMIT here would make a test run permanent.
--
-- WHY
--   Nobody hears about a failed, unconfirmed or expired push today. The bot has
--   a signed endpoint (/webhook/priority-receipt) that our own GR trigger
--   already uses; nothing in the database tells it about outbox outcomes.
--
-- WHAT THIS FILE DOES (OUR objects only; the client's tables are only READ)
--   Part A (Task 8)
--   * priority_push_config + no_writeback_minutes (5), held_alert_minutes (30)
--       (read by priority_push_watch(), part B)
--   * priority_push_error_class(status, status_code, response_body,
--       response_error)  NEW STABLE: one word for what Make / Priority answered:
--       supplier_missing ("חסר מס' ספק", missing supplier number; ASCII ' or
--       geresh ׳), item_missing ("חסר מק"ט", missing item number; ASCII " or
--       gershayim ״, raw or JSON-escaped), already_in_priority ("הכנסה לקובץ
--       נכשלה", writing to the file failed), make_crash (5xx), make_no_ok (2xx
--       without ok:true), no_reply (timeout / nothing back), other; NULL for a
--       delivered row or when nothing came back to classify.
--   * priority_push_notify_bot(outbox_id, kind, extra jsonb default null)  NEW:
--       the notify_bot_priority_receipt() pattern (bot_webhook_config URL +
--       vault secret in X-Webhook-Secret, a bot_webhook_log row, every error
--       logged and swallowed). Posts {event:'priority_push_outcome', kind, ...}.
--       `extra` is merged last: not_queued passes delivery_id + error_text,
--       the digest passes items + orphan_counts.
--   * priority_push_outcome_trg() + trg_priority_push_outcome  NEW: AFTER UPDATE
--       OF status ON priority_push_outbox. A NEW failed / unconfirmed / expired /
--       delivered status claims the row once (alerted_at, alert_kind = status,
--       alert_tries = 0, only when alert_kind differs) and posts that kind.
--       An 'unconfirmed' whose Priority GR is already there is skipped: job 8
--       turns it 'delivered' in the same run, and that is what gets posted.
--       The trigger runs inside job 8's transaction, so it never raises.
--   * BASELINE: rows that already had their outcome before this file are
--       stamped as alerted, so applying it sends nothing about the past (they
--       are listed by the daily digest and the needs-attention page instead).
--   * Privileges: notify_bot and the trigger function are revoked from PUBLIC,
--       anon, authenticated AND service_role (no RPC caller may post an office
--       alert); only the classifier is granted to service_role (M4's view).
--   * set local lock_timeout = 5 s before the first lock / ALTER, like M1 and M2.
--   Part B (Task 9) below.
--
-- WHAT THIS FILE DOES NOT DO
--   * It does not change priority_push_dispatch() (job 8) or priority_push_plan().
--   * It writes nothing to the client's objects (priority_goods_receipts is
--     only read; wb_* are not called here).
-- =============================================================================

-- Fail fast (5 s) instead of queueing behind another session's lock; the ALTER TABLE in A1 needs ACCESS EXCLUSIVE.
set local lock_timeout = '5s';

-- Job 8 takes this lock on every tick; holding it makes job 8 skip its ticks
-- while this file runs, instead of queueing behind the DDL locks below.
select pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

do $guard$
declare
  c text;
begin
  foreach c in array array['target', 'alerted_at', 'alert_kind', 'alert_tries',
                           'worker_notified_at', 'hold_reason', 'unit_risk_lines'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'priority_push_outbox'
                      and column_name = c) then
      raise exception 'priority_push_outbox.% is missing: apply M1 and M2 (2026-10-08-priority-push-01/02) first', c;
    end if;
  end loop;
  foreach c in array array['status_code', 'reply_error', 'outbox_id', 'kind'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'bot_webhook_log'
                      and column_name = c) then
      raise exception 'bot_webhook_log.% is missing: apply M2 (2026-10-08-priority-push-02) first', c;
    end if;
  end loop;
  if to_regprocedure('public.priority_push_explain(uuid)') is null then
    raise exception 'priority_push_explain(uuid) is missing: apply M2 (2026-10-08-priority-push-02) first';
  end if;
  if to_regclass('public.priority_push_attempts') is null then
    raise exception 'priority_push_attempts is missing: apply M2 (2026-10-08-priority-push-02) first';
  end if;
end
$guard$;

-- -----------------------------------------------------------------------------
-- A1. Config: how long before "no write-back" and "held" are alerted
-- -----------------------------------------------------------------------------
alter table public.priority_push_config
  add column if not exists no_writeback_minutes integer not null default 5,
  add column if not exists held_alert_minutes   integer not null default 30;
comment on column public.priority_push_config.no_writeback_minutes is
  '2026-10-08: priority_push_watch() alerts kind no_writeback when a sent / unconfirmed row has no Priority GR this many minutes after sent_at (slowest success seen: 14.5 s).';
comment on column public.priority_push_config.held_alert_minutes is
  '2026-10-08: priority_push_watch() alerts kind held when a queued / waiting row is still held this many minutes after queued_at.';

create index if not exists idx_bot_webhook_log_outbox_kind
  on public.bot_webhook_log (outbox_id, kind, id)
  where outbox_id is not null;

-- -----------------------------------------------------------------------------
-- A2. priority_push_error_class: what Make / Priority answered, in one word
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_error_class(
  p_status         text,
  p_status_code    integer,
  p_response_body  text,
  p_response_error text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $function$
declare
  v_txt text;
begin
  if p_status = 'delivered' then
    return null;
  end if;
  -- nothing came back (expired before a send, held, never sent)
  if p_status_code is null
     and coalesce(p_response_body, '') = ''
     and coalesce(p_response_error, '') = ''
     and coalesce(p_status, '') not in ('sent', 'unconfirmed') then
    return null;
  end if;

  -- the JSON "error" decoded (so \" reads as "), then the raw texts
  v_txt := coalesce(case when pg_input_is_valid(p_response_body, 'jsonb')
                         then p_response_body::jsonb ->> 'error' end, '')
           || ' ' || coalesce(p_response_body, '')
           || ' ' || coalesce(p_response_error, '');

  -- "חסר מס' ספק" (missing supplier number): ASCII ' or geresh ׳ (or ’ `)
  if v_txt ~ $re$חסר\s*(מס\\?['׳’`]?|מספר)\s*ספק$re$ then
    return 'supplier_missing';
  end if;
  -- "חסר מק"ט" (missing item number): ASCII " (raw or JSON \") or gershayim ״
  if v_txt ~ $re$חסר\s*מק\\?["״”'׳]?ט$re$ then
    return 'item_missing';
  end if;
  -- "הכנסה לקובץ נכשלה" (writing to the file failed): Priority already has it
  if v_txt ~ $re$הכנסה\s*לקובץ\s*נכשלה$re$ then
    return 'already_in_priority';
  end if;
  if p_status_code between 500 and 599 then
    return 'make_crash';
  end if;
  if p_status_code between 200 and 299 then
    return 'make_no_ok';
  end if;
  if p_status_code is null
     and (coalesce(p_status, '') in ('sent', 'unconfirmed')
          or coalesce(p_response_error, '') ~* 'time[d ]?\s*out|no reply') then
    return 'no_reply';
  end if;
  return 'other';
end
$function$;

comment on function public.priority_push_error_class(text, integer, text, text) is
  '2026-10-08: classifies an outbox reply: supplier_missing | item_missing | already_in_priority | make_crash | make_no_ok | no_reply | other; NULL when delivered or nothing came back. Hebrew matches accept ASCII and Hebrew punctuation (geresh, gershayim) and JSON-escaped quotes. Used by priority_push_notify_bot() and the digest.';

-- -----------------------------------------------------------------------------
-- A3. priority_push_notify_bot: one signed POST to the bot, always logged
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_notify_bot(
  p_outbox_id bigint,
  p_kind      text,
  p_extra     jsonb default null)
returns void
language plpgsql
security definer
set search_path = public, net, vault, pg_temp
as $function$
declare
  cfg    public.bot_webhook_config%rowtype;
  sec    text;
  req    bigint;
  o      public.priority_push_outbox%rowtype;
  d      public.deliveries%rowtype;
  v_did  uuid;
  v_json jsonb;
  v_gr   text;
  v_body jsonb;
begin
  if p_outbox_id is not null then
    select * into o from public.priority_push_outbox where id = p_outbox_id;
  end if;
  v_did := coalesce(o.delivery_id, nullif(p_extra ->> 'delivery_id', '')::uuid);
  if v_did is not null then
    select * into d from public.deliveries where id = v_did;
  end if;

  v_json := case when pg_input_is_valid(o.response_body, 'jsonb') then o.response_body::jsonb end;

  -- the Priority GR: the write-back row, else the scenario's ok:true reply,
  -- else a hand confirmation ('confirmed by hand: Priority draft GR... (by)')
  if v_did is not null then
    select g.docno into v_gr
      from public.priority_goods_receipts g
     where g.delivery_id = v_did
       and g.origin <> 'warehouse_bot'
     order by g.synced_at desc
     limit 1;
  end if;
  v_gr := coalesce(v_gr, v_json ->> 'docno',
                   substring(o.not_ready_reason from 'Priority draft ([^ ()]+)'));

  v_body := jsonb_build_object(
      'event',               'priority_push_outcome',
      'kind',                p_kind,
      'outbox_id',           p_outbox_id,
      'delivery_id',         v_did,
      'document_number',     coalesce(o.document_number, d.document_number),
      'supplier',            coalesce(d.supplier_hebrew, d.supplier_english),
      'supplier_vat',        d.supplier_vat,
      'category',            coalesce(o.category,
                                      case when v_did is not null
                                           then public.priority_push_delivery_category(v_did) end),
      'status',              o.status,
      'status_code',         o.status_code,
      'stage',               v_json ->> 'stage',
      'error_class',         case when p_kind in ('failed', 'unconfirmed', 'expired', 'no_writeback')
                                  then public.priority_push_error_class(o.status, o.status_code,
                                                                        o.response_body, o.response_error)
                             end,
      'error_text',          left(coalesce(v_json ->> 'error', o.response_error, o.response_body), 500),
      'unmapped_codes',      coalesce(to_jsonb(o.unmapped_codes), '[]'::jsonb),
      'unit_risk_lines',     coalesce(o.unit_risk_lines, '[]'::jsonb),
      'not_ready_reason',    o.not_ready_reason,
      'hold_reason',         o.hold_reason,
      'gr_docno',            v_gr,
      'received_by_chat_id', d.received_by_chat_id,
      'attempt',             o.attempts,
      'is_test',             coalesce(o.target = 'test', false))
    || coalesce(p_extra, '{}'::jsonb);
  -- extra keys add facts; they never rename the event
  v_body := v_body || jsonb_build_object('event', 'priority_push_outcome',
                                         'kind', p_kind, 'outbox_id', p_outbox_id);

  select * into cfg from public.bot_webhook_config
   where enabled order by updated_at desc, id limit 1;
  if not found then
    insert into public.bot_webhook_log(event, delivery_id, priority_docno, outbox_id, kind, error)
    values ('priority_push_outcome', v_did, v_gr, p_outbox_id, p_kind,
            'not sent: no enabled bot_webhook_config row');
    return;
  end if;

  select decrypted_secret into sec
    from vault.decrypted_secrets where name = cfg.secret_name limit 1;
  if sec is null or sec = '' then
    insert into public.bot_webhook_log(event, delivery_id, priority_docno, outbox_id, kind, error)
    values ('priority_push_outcome', v_did, v_gr, p_outbox_id, p_kind,
            'not sent: vault secret ' || cfg.secret_name || ' is missing (fail closed)');
    return;
  end if;

  -- 30 s, not the receipt's 8 s: the bot may send up to three WhatsApp
  -- messages (office x2 + worker, with a template fallback) before it answers,
  -- and a timeout counts as "not delivered" and is retried by the watch.
  select net.http_post(
    url := cfg.url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Webhook-Secret', sec
    ),
    body := v_body,
    timeout_milliseconds := 30000
  ) into req;

  insert into public.bot_webhook_log(event, delivery_id, priority_docno, request_id, outbox_id, kind)
  values ('priority_push_outcome', v_did, v_gr, req, p_outbox_id, p_kind);
exception when others then
  begin
    insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
    values ('priority_push_outcome', v_did, p_outbox_id, p_kind, left(sqlerrm, 500));
  exception when others then
    null;
  end;
end
$function$;

comment on function public.priority_push_notify_bot(bigint, text, jsonb) is
  '2026-10-08: POSTs {event:''priority_push_outcome'', kind, outbox_id, delivery_id, document_number, supplier, supplier_vat, category, status, status_code, stage, error_class, error_text, unmapped_codes, unit_risk_lines, not_ready_reason, hold_reason, gr_docno, received_by_chat_id, attempt, is_test} || extra to the bot (bot_webhook_config URL, vault secret in X-Webhook-Secret, 30 s). Logs one bot_webhook_log row (event priority_push_outcome, outbox_id, kind, request_id or error). Never raises.';

-- -----------------------------------------------------------------------------
-- A4. The outcome trigger: one alert per new outcome
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_outcome_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_id bigint;
begin
  if new.status is not distinct from old.status
     or new.status not in ('failed', 'unconfirmed', 'expired', 'delivered') then
    return null;
  end if;
  begin
    -- job 8 reads a reply back and confirms by write-back in the same run: an
    -- 'unconfirmed' whose Priority GR is already there turns 'delivered' a
    -- moment later, so only that 'delivered' is alerted
    if new.status = 'unconfirmed'
       and exists (select 1 from public.priority_goods_receipts g
                    where g.delivery_id = new.delivery_id
                      and g.origin <> 'warehouse_bot') then
      return null;
    end if;
    -- claim once: a row already alerted for this status is not alerted again
    -- (only priority_push_resend() clears the claim)
    update public.priority_push_outbox o
       set alerted_at  = now(),
           alert_kind  = new.status,
           alert_tries = 0
     where o.id = new.id
       and o.alert_kind is distinct from new.status
    returning o.id into v_id;
    if v_id is not null then
      perform public.priority_push_notify_bot(v_id, new.status);
    end if;
  exception when others then
    -- runs inside job 8's transaction: never let an alert stop the push
    begin
      insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
      values ('priority_push_outcome', new.delivery_id, new.id, new.status,
              left('outcome trigger: ' || sqlerrm, 500));
    exception when others then
      null;
    end;
  end;
  return null;
end
$function$;

comment on function public.priority_push_outcome_trg() is
  '2026-10-08: AFTER UPDATE OF status ON priority_push_outbox. A new failed / unconfirmed / expired / delivered status claims the row (alerted_at, alert_kind, alert_tries = 0) when alert_kind differs, then calls priority_push_notify_bot(id, status). An unconfirmed whose Priority GR already exists is skipped (job 8 makes it delivered in the same run). Never raises.';

drop trigger if exists trg_priority_push_outcome on public.priority_push_outbox;
create trigger trg_priority_push_outcome
  after update of status on public.priority_push_outbox
  for each row
  when (old.status is distinct from new.status
        and new.status in ('failed', 'unconfirmed', 'expired', 'delivered'))
  execute function public.priority_push_outcome_trg();

-- -----------------------------------------------------------------------------
-- A5. Baseline: nothing about the past is sent when this file is applied
-- -----------------------------------------------------------------------------
-- delivered: always (the receiver was told by the priority_receipt event);
-- failed / expired / sent / unconfirmed: when the send (or queueing) is more
-- than 1 hour old. Newer ones are left to the watch, so a push in flight
-- while this file runs is still watched. A sent / unconfirmed row with no
-- Priority GR is stamped no_writeback, so the watch's 5-minute check does not
-- fire for it either (live 2026-10-07: 46, 47, 53, 54).
update public.priority_push_outbox o
   set alerted_at = now(),
       alert_kind = case
                      when o.status in ('sent', 'unconfirmed')
                       and not exists (select 1 from public.priority_goods_receipts g
                                        where g.delivery_id = o.delivery_id
                                          and g.origin <> 'warehouse_bot')
                      then 'no_writeback'
                      else o.status
                    end
 where o.alert_kind is null
   and o.alerted_at is null
   and (o.status = 'delivered'
        or (o.status in ('failed', 'expired', 'sent', 'unconfirmed')
            and coalesce(o.sent_at, o.queued_at) < now() - interval '1 hour'));

-- -----------------------------------------------------------------------------
-- A6. Privileges: server-side only
-- -----------------------------------------------------------------------------
revoke execute on function public.priority_push_error_class(text, integer, text, text) from public, anon, authenticated;
-- the notify (posts office alerts through the signed bot webhook) and the
-- trigger function are never called over RPC: the trigger and job 8 run as the
-- owner, so the scanner's server key (service_role) must not run them either
revoke execute on function public.priority_push_notify_bot(bigint, text, jsonb)       from public, anon, authenticated, service_role;
revoke execute on function public.priority_push_outcome_trg()                         from public, anon, authenticated, service_role;
-- the needs-attention view (M4) may call the classifier; views run functions
-- with the caller's rights, and the scanner reads views as service_role
grant  execute on function public.priority_push_error_class(text, integer, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- A7. Report (read-only)
-- -----------------------------------------------------------------------------
do $report_a$
begin
  raise notice 'outbox rows by status / alert_kind after the baseline: %',
    (select coalesce(jsonb_object_agg(s.k, s.n), '{}'::jsonb)
       from (select o.status || ' / ' || coalesce(o.alert_kind, '-') as k, count(*) as n
               from public.priority_push_outbox o group by 1) s);
  raise notice 'bot_webhook_config enabled: %, its vault secret exists: %',
    exists (select 1 from public.bot_webhook_config where enabled),
    exists (select 1 from vault.secrets s join public.bot_webhook_config c
                on c.secret_name = s.name where c.enabled);
end
$report_a$;

-- =============================================================================
-- Part B (Task 9): the watch, the daily digest, and their cron jobs
-- =============================================================================
--   * priority_push_alert_log(delivery_id, kind)  NEW: one row per alert about
--       a delivery that has no outbox row (kind not_queued), so it is sent once.
--   * priority_push_watch()  NEW, pg_cron job 'priority-push-watch' every minute
--       (separate from job 8). Returns the number of alerts sent, -1 when
--       another run holds its lock. Each row is handled in its own
--       sub-transaction; an error is logged to bot_webhook_log
--       (event 'priority_push_watch') and the loop goes on. Steps:
--       0. retry: a row whose alert the bot did not take (step 5 cleared its
--          claim) is sent again with the same kind, while that kind still holds
--       1. no_writeback: sent / unconfirmed, sent_at older than
--          no_writeback_minutes, no Priority GR (origin <> 'warehouse_bot'),
--          once per send (alert_kind and this send's log rows)
--       2. failed / expired rows whose outcome was never alerted
--       3. held: queued / waiting longer than held_alert_minutes since it was
--          queued or last put back by Send again -> hold_reason (explain's, or
--          "the dispatcher is not sending" when nothing holds it), kind held once
--       4. not_queued: a closed delivery (Complete / Has Discrepancy) with no
--          outbox row -> once per delivery (priority_push_alert_log); flagged
--          is_test when its receiver is a Test user
--       5. bot replies: copies net._http_response (6 h TTL) into
--          bot_webhook_log.status_code / reply_error; an outcome alert the bot
--          did not answer 2xx (or timed out) gets its claim cleared and
--          alert_tries + 1 while alert_tries < 3, so the next tick re-sends it
--   * priority_push_digest()  NEW, pg_cron job 'priority-push-digest'
--       '0 4,5 * * *' GMT; only the run at 07:00 Asia/Jerusalem calls it, so
--       it is 07:00 Israel time in summer and after the clocks go back on
--       2026-10-25. One kind 'digest' POST with
--       items = the open problems and orphan_counts; nothing when all is clear.
--       Test receivers' never-queued deliveries are left out of the items.
--   * Every claim UPDATE in the watch re-checks the status the row was selected
--       with, so a row job 8 changed in between is not claimed under a stale
--       kind. The watch runs with lock_timeout = 5 s (function attribute).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- B1. priority_push_alert_log: alerts about deliveries that have no outbox row
-- -----------------------------------------------------------------------------
create table if not exists public.priority_push_alert_log (
  delivery_id uuid        not null references public.deliveries(id) on delete cascade,
  kind        text        not null,
  created_at  timestamptz not null default now(),
  primary key (delivery_id, kind)
);
alter table public.priority_push_alert_log enable row level security;
revoke all on table public.priority_push_alert_log from anon, authenticated;
comment on table public.priority_push_alert_log is
  '2026-10-08: one row per (delivery, kind) alert about a delivery that has no priority_push_outbox row (kind not_queued), so the watch alerts it once. Deleted by the watch only to retry an alert the bot did not take.';

-- -----------------------------------------------------------------------------
-- B2. priority_push_watch: the every-minute check
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_watch()
returns integer
language plpgsql
security definer
set search_path = public, net, pg_temp
set lock_timeout = '5s'     -- never wait long behind a lock while holding claimed rows; a row that times out is logged and skipped
as $function$
declare
  cfg       public.priority_push_config%rowtype;
  c_nw      interval;
  c_held    interval;
  r         record;
  v_id      bigint;
  v_did     uuid;
  v_kind    text;
  v_ok      boolean;
  v_explain jsonb;
  n         integer := 0;
begin
  -- one run at a time (cron every minute + any manual call)
  if not pg_try_advisory_xact_lock(hashtext('public.priority_push_watch')) then
    return -1;
  end if;

  select * into cfg from public.priority_push_config c where c.id = 1;
  c_nw   := make_interval(mins => coalesce(cfg.no_writeback_minutes, 5));
  c_held := make_interval(mins => coalesce(cfg.held_alert_minutes, 30));

  -- 0. Retry an alert the bot did not take (step 5 of an earlier tick cleared
  --    the claim): same kind again, while that kind still describes the row.
  for r in
    select o.id, o.status, o.delivery_id,
           (select l.kind from public.bot_webhook_log l
             where l.outbox_id = o.id and l.event = 'priority_push_outcome'
             order by l.id desc limit 1) as last_kind
      from public.priority_push_outbox o
     where o.alert_kind is null
       and o.alert_tries > 0
  loop
    begin
      v_ok := case
                when r.last_kind in ('failed', 'unconfirmed', 'expired', 'delivered')
                  then r.status = r.last_kind
                when r.last_kind = 'no_writeback'
                  then r.status in ('sent', 'unconfirmed')
                       and not exists (select 1 from public.priority_goods_receipts g
                                        where g.delivery_id = r.delivery_id
                                          and g.origin <> 'warehouse_bot')
                when r.last_kind = 'held'
                  then r.status in ('queued', 'waiting')
                else false
              end;
      if coalesce(v_ok, false) then
        update public.priority_push_outbox o
           set alerted_at = now(), alert_kind = r.last_kind      -- alert_tries kept: it counts the retries
         where o.id = r.id and o.alert_kind is null
           and o.status = r.status                    -- job 8 may have moved the row since the select
        returning o.id into v_id;
        if v_id is not null then
          perform public.priority_push_notify_bot(v_id, r.last_kind);
          n := n + 1;
        end if;
      else
        -- the row moved on: the checks below decide afresh
        update public.priority_push_outbox o
           set alert_tries = 0
         where o.id = r.id and o.alert_kind is null;
      end if;
    exception when others then
      begin
        insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
        values ('priority_push_watch', r.delivery_id, r.id, r.last_kind, left('retry: ' || sqlerrm, 500));
      exception when others then null;
      end;
    end;
  end loop;

  -- 1. No write-back: Make took it (or said nothing) and no GR came back.
  --    Once per send: alert_kind, plus this send's own log rows (so a later
  --    'unconfirmed' alert on the same send does not re-arm it).
  for r in
    select o.id, o.delivery_id
      from public.priority_push_outbox o
     where o.status in ('sent', 'unconfirmed')
       and o.sent_at < now() - c_nw
       and o.alert_kind is distinct from 'no_writeback'
       and not (o.alert_kind is null and o.alert_tries > 0)
       and not exists (select 1 from public.priority_goods_receipts g
                        where g.delivery_id = o.delivery_id
                          and g.origin <> 'warehouse_bot')
       and not exists (select 1 from public.bot_webhook_log l
                        where l.outbox_id = o.id
                          and l.event = 'priority_push_outcome'
                          and l.kind = 'no_writeback'
                          and l.created_at >= o.sent_at)
  loop
    begin
      update public.priority_push_outbox o
         set alerted_at = now(), alert_kind = 'no_writeback', alert_tries = 0
       where o.id = r.id and o.alert_kind is distinct from 'no_writeback'
         and o.status in ('sent', 'unconfirmed')       -- job 8 may have moved the row since the select
      returning o.id into v_id;
      if v_id is not null then
        perform public.priority_push_notify_bot(v_id, 'no_writeback');
        n := n + 1;
      end if;
    exception when others then
      begin
        insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
        values ('priority_push_watch', r.delivery_id, r.id, 'no_writeback', left(sqlerrm, 500));
      exception when others then null;
      end;
    end;
  end loop;

  -- 2. failed / expired whose outcome was never alerted (a hand UPDATE, or a
  --    trigger claim that errored)
  for r in
    select o.id, o.delivery_id, o.status
      from public.priority_push_outbox o
     where o.status in ('failed', 'expired')
       and o.alert_kind is distinct from o.status
       and not (o.alert_kind is null and o.alert_tries > 0)
  loop
    begin
      update public.priority_push_outbox o
         set alerted_at = now(), alert_kind = o.status, alert_tries = 0
       where o.id = r.id and o.alert_kind is distinct from o.status
         and o.status in ('failed', 'expired')         -- job 8 may have moved the row since the select
      returning o.id, o.status into v_id, v_kind;
      if v_id is not null then
        perform public.priority_push_notify_bot(v_id, v_kind);
        n := n + 1;
      end if;
    exception when others then
      begin
        insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
        values ('priority_push_watch', r.delivery_id, r.id, r.status, left(sqlerrm, 500));
      exception when others then null;
      end;
    end;
  end loop;

  -- 3. Held: still queued / waiting held_alert_minutes after it was queued or
  --    last put back by Send again (held_since, the same rule as M4's
  --    priority_push_attention_v). Job 8 acts on a due row within 15 s, so
  --    every row this old is alerted: with explain()'s hold_reason (written
  --    unchanged), or, when nothing holds it (send / send_unready / expired /
  --    already_in_priority), as "the dispatcher is not sending".
  for r in
    select o.id, o.delivery_id, o.status, o.hold_reason
      from public.priority_push_outbox o
     where o.status in ('queued', 'waiting')
       and greatest(o.queued_at,
                    (select max(a.created_at) from public.priority_push_attempts a
                      where a.outbox_id = o.id and a.reason = 'resend')) < now() - c_held
       and o.alert_kind is distinct from 'held'
       and not (o.alert_kind is null and o.alert_tries > 0)
  loop
    begin
      begin
        v_explain := public.priority_push_explain(r.delivery_id);
      exception when others then
        v_explain := jsonb_build_object(
          'decision', 'unknown',
          'hold_reason', left('held for more than ' || coalesce(cfg.held_alert_minutes, 30)
                              || ' min; the reason could not be read: ' || sqlerrm, 1000));
      end;
      update public.priority_push_outbox o
         set hold_reason = left(coalesce(
                 v_explain ->> 'hold_reason',
                 'not sent although nothing holds it (decision '
                 || coalesce(v_explain ->> 'decision', 'unknown') || '): still ' || r.status
                 || ' after more than ' || coalesce(cfg.held_alert_minutes, 30)
                 || ' min, so the dispatcher (pg_cron job priority-push-dispatch) is not sending it;'
                 || ' check cron.job_run_details, priority_push_config.url and the vault secret'
                 || coalesce(' (last recorded hold: ' || r.hold_reason || ')', '')), 1000),
             alerted_at  = now(),
             alert_kind  = 'held',
             alert_tries = 0
       where o.id = r.id and o.alert_kind is distinct from 'held'
         and o.status in ('queued', 'waiting')         -- job 8 may have moved the row since the select
      returning o.id into v_id;
      if v_id is not null then
        perform public.priority_push_notify_bot(v_id, 'held');
        n := n + 1;
      end if;
    exception when others then
      begin
        insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
        values ('priority_push_watch', r.delivery_id, r.id, 'held', left(sqlerrm, 500));
      exception when others then null;
      end;
    end;
  end loop;

  -- 4. Closed but never queued: the enqueue trigger writes an outbox row for
  --    every close (Test users and re-closes get 'skipped'), so a closed
  --    delivery without one means the enqueue failed. deliveries has no
  --    closed_at column, so created_at bounds the scan: the last 30 days, or
  --    everything since the push was switched on.
  for r in
    select d.id
      from public.deliveries d
     where d.status::text in ('Complete', 'Has Discrepancy')
       and (d.created_at > now() - interval '30 days' or d.created_at >= cfg.enabled_since)
       and not exists (select 1 from public.priority_push_outbox o where o.delivery_id = d.id)
       and not exists (select 1 from public.priority_push_alert_log a
                        where a.delivery_id = d.id and a.kind = 'not_queued')
  loop
    begin
      v_did := null;
      insert into public.priority_push_alert_log(delivery_id, kind)
      values (r.id, 'not_queued')
      on conflict do nothing
      returning delivery_id into v_did;
      if v_did is not null then
        perform public.priority_push_notify_bot(null, 'not_queued', jsonb_build_object(
          'delivery_id', r.id,
          -- no outbox row to read target from, so a Test receiver's delivery is
          -- flagged here (notify_bot merges extra after its own is_test default)
          'is_test', coalesce(
             (select u.env = 'Test'::public.user_env
                from public.users u
                join public.deliveries d2 on d2.received_by_chat_id = u.chat_id
               where d2.id = r.id), false),
          'error_text', coalesce(
             (select l.error from public.bot_webhook_log l
               where l.event = 'priority_push_enqueue' and l.delivery_id = r.id
               order by l.id desc limit 1),
             'closed in the warehouse, but no Priority outbox row was created')));
        n := n + 1;
      end if;
    exception when others then
      begin
        insert into public.bot_webhook_log(event, delivery_id, kind, error)
        values ('priority_push_watch', r.id, 'not_queued', left(sqlerrm, 500));
      exception when others then null;
      end;
    end;
  end loop;

  -- 5. What the bot answered (pg_net keeps replies 6 h). Every bot_webhook_log
  --    row gets its status; an outcome alert the bot did not take is retried.
  begin
    for r in
      update public.bot_webhook_log l
         set status_code = h.status_code,
             reply_error = case
                             when h.status_code between 200 and 299 then null
                             when h.timed_out then 'timed out'
                             when h.error_msg is not null then left(h.error_msg, 500)
                             when h.status_code is not null then left(coalesce(h.content, ''), 500)
                             else 'no status code'
                           end
        from net._http_response h
       where h.id = l.request_id
         and l.request_id is not null
         and l.status_code is null
         and l.reply_error is null
         and l.created_at > now() - interval '6 hours'
      returning l.id, l.event, l.kind, l.outbox_id, l.delivery_id, l.status_code
    loop
      if r.event = 'priority_push_outcome'
         and (r.status_code is null or r.status_code not between 200 and 299) then
        begin
          if r.outbox_id is not null and r.kind not in ('digest', 'not_queued') then
            update public.priority_push_outbox o
               set alerted_at = null, alert_kind = null, alert_tries = o.alert_tries + 1
             where o.id = r.outbox_id
               and o.alert_kind = r.kind          -- a newer alert supersedes this one
               and o.alert_tries < 3;
          elsif r.kind = 'not_queued' and r.delivery_id is not null
                and (select count(*) from public.bot_webhook_log l2
                      where l2.event = 'priority_push_outcome' and l2.kind = 'not_queued'
                        and l2.delivery_id = r.delivery_id) < 4 then
            delete from public.priority_push_alert_log a
             where a.delivery_id = r.delivery_id and a.kind = 'not_queued';
          end if;
        exception when others then
          begin
            insert into public.bot_webhook_log(event, delivery_id, outbox_id, kind, error)
            values ('priority_push_watch', r.delivery_id, r.outbox_id, r.kind,
                    left('reply ' || r.id || ': ' || sqlerrm, 500));
          exception when others then null;
          end;
        end;
      end if;
    end loop;
  exception when others then
    begin
      insert into public.bot_webhook_log(event, error)
      values ('priority_push_watch', left('reading bot replies: ' || sqlerrm, 500));
    exception when others then null;
    end;
  end;

  return n;
end
$function$;

comment on function public.priority_push_watch() is
  '2026-10-08: pg_cron job priority-push-watch, every minute. Alerts the bot (priority_push_notify_bot) once per kind: no_writeback (sent/unconfirmed, no Priority GR after no_writeback_minutes), unalerted failed/expired, held (queued/waiting held_alert_minutes after queueing or the last Send again; hold_reason from priority_push_explain, or "the dispatcher is not sending" when nothing holds it), not_queued (closed delivery with no outbox row; priority_push_alert_log; is_test when its receiver is a Test user). Copies the bot''s pg_net replies into bot_webhook_log and retries an alert the bot did not take (alert_tries < 3). Each row in its own sub-transaction; errors go to bot_webhook_log event priority_push_watch. Returns alerts sent, -1 if another run holds the lock.';

-- -----------------------------------------------------------------------------
-- B3. priority_push_digest: one morning summary of everything still open
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_digest()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items   jsonb;
  v_orphans jsonb;
begin
  -- the needs-attention view arrives with M4; read it dynamically so this
  -- function works before and after it exists. Fake-Make rows (target
  -- 'test') are left out: their alerts go to the tester only, and the
  -- digest goes to the office (M4's view has a target column; reading it
  -- through to_jsonb keeps this working if it ever loses it).
  if to_regclass('public.priority_push_attention_v') is not null then
    begin
      execute $q$
        select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at nulls last), '[]'::jsonb)
          from public.priority_push_attention_v v
         where v.problem not like 'orphan%'
           and (to_jsonb(v) ->> 'target') is distinct from 'test'
      $q$ into v_items;
      execute $q$
        select jsonb_build_object(
                 'class1', count(*) filter (where v.problem = 'orphan_class1'),
                 'class2', count(*) filter (where v.problem = 'orphan_class2'),
                 'class3', count(*) filter (where v.problem = 'orphan_class3'))
          from public.priority_push_attention_v v
      $q$ into v_orphans;
    exception when others then
      v_items := null;
      v_orphans := null;
    end;
  end if;

  if v_items is null then
    -- until M4: the outbox rows that need a person, plus closed-but-never-queued
    select coalesce(jsonb_agg(jsonb_build_object(
             'outbox_id',        o.id,
             'delivery_id',      o.delivery_id,
             'document_number',  o.document_number,
             'supplier',         coalesce(d.supplier_hebrew, d.supplier_english),
             'category',         o.category,
             'problem',          case when o.status in ('queued', 'waiting') then 'held'
                                      when o.alert_kind = 'no_writeback' then 'no_writeback'
                                      else o.status end,
             'reason_text',      coalesce(o.hold_reason, o.response_error, o.not_ready_reason),
             'status_code',      o.status_code,
             'error_class',      public.priority_push_error_class(o.status, o.status_code,
                                                                  o.response_body, o.response_error),
             'sent_at',          o.sent_at,
             'created_at',       o.queued_at,
             'receiver_chat_id', d.received_by_chat_id) order by o.queued_at), '[]'::jsonb)
      into v_items
      from public.priority_push_outbox o
      left join public.deliveries d on d.id = o.delivery_id
     where o.target is distinct from 'test'
       and (o.status in ('failed', 'unconfirmed', 'expired')
            or (o.status = 'sent' and o.alert_kind = 'no_writeback')
            or (o.status in ('queued', 'waiting') and o.alert_kind = 'held'));

    v_items := v_items || coalesce((
      select jsonb_agg(jsonb_build_object(
               'outbox_id',        null,
               'delivery_id',      d.id,
               'document_number',  d.document_number,
               'supplier',         coalesce(d.supplier_hebrew, d.supplier_english),
               'category',         public.priority_push_delivery_category(d.id),
               'problem',          'not_queued',
               'reason_text',      'closed in the warehouse, but no Priority outbox row was created',
               'status_code',      null,
               'error_class',      null,
               'sent_at',          null,
               'created_at',       a.created_at,
               'receiver_chat_id', d.received_by_chat_id) order by a.created_at)
        from public.priority_push_alert_log a
        join public.deliveries d on d.id = a.delivery_id
       where a.kind = 'not_queued'
         and not exists (select 1 from public.priority_push_outbox o where o.delivery_id = d.id)
         -- a Test receiver's delivery is not an office problem (its alert carries is_test)
         and not exists (select 1 from public.users u
                          where u.chat_id = d.received_by_chat_id
                            and u.env = 'Test'::public.user_env)),
      '[]'::jsonb);
    v_orphans := jsonb_build_object('class1', null, 'class2', null, 'class3', null);
  end if;

  if jsonb_array_length(v_items) = 0
     and coalesce((v_orphans ->> 'class1')::int, 0)
       + coalesce((v_orphans ->> 'class2')::int, 0)
       + coalesce((v_orphans ->> 'class3')::int, 0) = 0 then
    return;                                  -- all clear: no message
  end if;

  perform public.priority_push_notify_bot(null, 'digest',
            jsonb_build_object('items', v_items, 'orphan_counts', v_orphans));
exception when others then
  begin
    insert into public.bot_webhook_log(event, kind, error)
    values ('priority_push_watch', 'digest', left('digest: ' || sqlerrm, 500));
  exception when others then null;
  end;
end
$function$;

comment on function public.priority_push_digest() is
  '2026-10-08: pg_cron job priority-push-digest, 07:00 Israel time daily (cron 04:00 and 05:00 GMT, the command runs it only at 07:00 Asia/Jerusalem). One priority_push_notify_bot(NULL, ''digest'', {items, orphan_counts}) with the open problems from priority_push_attention_v (orphans counted, not listed; fake-Make target=test rows left out); before that view exists, from the outbox and priority_push_alert_log (orphan_counts values NULL; a Test receiver''s never-queued delivery is left out). Sends nothing when all is clear. Never raises.';

-- -----------------------------------------------------------------------------
-- B4. Privileges: server-side only
-- -----------------------------------------------------------------------------
-- Only pg_cron calls these (the jobs run as the owner), so service_role, the
-- scanner's server key, may not call them over RPC either: the watch posts
-- office alerts through priority_push_notify_bot(), which service_role cannot
-- execute (part A), and both functions are SECURITY DEFINER.
revoke execute on function public.priority_push_watch()  from public, anon, authenticated, service_role;
revoke execute on function public.priority_push_digest() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- B5. The two jobs (cron.schedule updates a job of the same name in place).
--     Job 8 'priority-push-dispatch' is not touched.
-- -----------------------------------------------------------------------------
select cron.schedule('priority-push-watch',  '* * * * *', 'select public.priority_push_watch()');
-- 07:00 Israel time all year: pg_cron runs in GMT, so the job wakes at 04:00 and
-- 05:00 GMT and only the run that falls on 07:00 in Asia/Jerusalem sends
-- (04:00 GMT in summer time, 05:00 GMT after the clocks go back on 2026-10-25).
select cron.schedule('priority-push-digest', '0 4,5 * * *',
  'select public.priority_push_digest() where extract(hour from now() at time zone ''Asia/Jerusalem'') = 7');

do $report_b$
begin
  raise notice 'cron jobs: %',
    (select jsonb_agg(jsonb_build_object('job', j.jobname, 'schedule', j.schedule, 'active', j.active) order by j.jobid)
       from cron.job j where j.jobname like 'priority-push-%');
  raise notice 'closed deliveries with no outbox row (each will be alerted once as not_queued): %',
    (select count(*) from public.deliveries d
      where d.status::text in ('Complete', 'Has Discrepancy')
        and d.created_at > now() - interval '30 days'
        and not exists (select 1 from public.priority_push_outbox o where o.delivery_id = d.id));
end
$report_b$;

-- =============================================================================
-- VERIFY after applying (SELECT-only)
-- =============================================================================
-- select jobid, jobname, schedule, active from cron.job where jobname like 'priority-push-%' order by jobid;
--   -> priority-push-dispatch '15 seconds', priority-push-watch '* * * * *', priority-push-digest '0 4,5 * * *'
-- select status, return_message, start_time from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'priority-push-watch')
--  order by start_time desc limit 5;                       -- succeeded, returns 0 on a quiet minute
-- select id, kind, outbox_id, delivery_id, request_id, status_code, reply_error, error, created_at
--   from public.bot_webhook_log where event in ('priority_push_outcome', 'priority_push_watch')
--  order by id desc limit 20;                              -- expect nothing right after the apply
-- select id, status, alert_kind, alerted_at, alert_tries from public.priority_push_outbox
--  where status in ('delivered', 'failed', 'expired', 'sent', 'unconfirmed')
--  order by id;                                            -- every outcome row stamped
