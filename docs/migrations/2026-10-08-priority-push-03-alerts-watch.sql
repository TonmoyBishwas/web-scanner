-- =============================================================================
-- 2026-10-08  priority_push_03_alerts_watch  (OUR Priority-push objects)
-- =============================================================================
--
-- STATUS: NOT APPLIED. Applied with mcp__supabase__apply_migration only after
--         Tonmoy's OK, and only when ALL of these hold:
--           1. M1 2026-10-08-priority-push-01-safety-test-harness.sql is applied;
--           2. M2 2026-10-08-priority-push-02-outcomes-explain.sql is applied
--              (outbox alerted_at / alert_kind / alert_tries / worker_notified_at /
--              hold_reason / unit_risk_lines, bot_webhook_log status_code /
--              reply_error / outbox_id / kind, priority_push_attempts,
--              priority_push_explain(uuid));
--           3. the bot build that answers event 'priority_push_outcome' on
--              /webhook/priority-receipt (bot/services/priority_alerts.py) is
--              LIVE on Railway (railway deployment list -> SUCCESS). The bot live
--              on 2026-10-07 (bb5d6d3) answers that event with 400 "priority_docno
--              required" and sends nothing, so every alert would be retried 3
--              times and then lost.
--         The guard below refuses to run without 1 and 2.
--
-- NO BEGIN / COMMIT IN THIS FILE: apply_migration runs it in one transaction,
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
