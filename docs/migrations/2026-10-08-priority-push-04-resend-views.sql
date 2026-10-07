-- 2026-10-08 — priority push 04: guarded "Send again", "Mark as found", needs-attention view
--
-- STATUS: NOT APPLIED yet. The controller applies it, only after Tonmoy's OK, byte-exact via
--         psycopg in ONE transaction (no BEGIN / COMMIT in this file: scripts/sql/run_sql_test.py
--         runs it inside BEGIN ... ROLLBACK for the tests), and records it in
--         supabase_migrations.schema_migrations as priority_push_04_resend_views. It is NOT
--         applied through mcp apply_migration. Requires M1-M3 live.
--
-- Test: docs/migrations/tests/2026-10-08-priority-push-04-resend-views.test.sql
-- Spec:  telegram-warehouse-bot/docs/superpowers/specs/2026-10-07-priority-push-dependable-design.md §3
--
-- Needs M1–M3 live: priority_push_outbox.target / alerted_at / alert_kind / alert_tries /
-- hold_reason, priority_push_config.no_writeback_minutes / held_alert_minutes,
-- priority_push_attempts, normalize_note_number(text), priority_push_explain(uuid),
-- priority_push_archive_reply(bigint, text, text) (M2), priority_push_error_class(text, integer,
-- text, text) (M3).
--
-- Adds (all ours):
--   priority_push_resend()      an operator's "Send again". Refuses unless every safety check
--                               passes; archives the last reply into priority_push_attempts and
--                               puts the row back to 'queued' for job 8.
--   priority_push_mark_found()  an operator's "Priority has it as GR…": status 'delivered'.
--                               It never calls the client's wb_mark_gr_synced.
--   priority_push_attention_v   one row per problem: failed / unconfirmed / no write-back / held /
--                               not queued / orphan deliveries by class (spec §5).
-- delivery_gaps_v is NOT here: it reads M5's delivery_items columns, so M5 creates it.
--
-- Nothing here sends by itself, edits a client object or changes job 8. Both functions take
-- job 8's advisory lock first, so a click never interleaves with a dispatch run.

-- Fail fast (5 s) instead of queueing behind another session's lock. Transaction-local, set
-- before the first statement and outside every function body, like M1, M2 and M3.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. priority_push_resend
-- ---------------------------------------------------------------------------
create or replace function public.priority_push_resend(
  p_outbox_id             bigint,
  p_by                    text,
  p_priority_checked      boolean,
  p_make_checked          boolean,
  p_release_guard         boolean default false,
  p_override_known_reject boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o          public.priority_push_outbox%rowtype;
  v_found    boolean;
  v_refused  text;
  v_detail   text;
  v_created  timestamptz;
  v_note     text;
  v_class    text;
  v_explain  jsonb;
  v_cycle    integer;
begin
  if nullif(btrim(coalesce(p_by, '')), '') is null then
    raise exception 'priority_push_resend: p_by (who pressed Send again) is required';
  end if;

  -- The key priority_push_dispatch() takes with pg_try_advisory_xact_lock: while we
  -- hold it, job 8 skips its tick, so the checks below cannot race a send.
  perform pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

  select * into o from public.priority_push_outbox where id = p_outbox_id for update;
  v_found := found;

  -- 1. only a row Make refused or never confirmed
  if not v_found or o.status not in ('unconfirmed', 'failed') then
    v_refused := 'not_resendable_status';
    v_detail  := 'status is ' || coalesce(o.status, 'missing (no such outbox row)');
  -- 2. Priority's write-back already landed for this delivery
  elsif exists (select 1 from public.priority_goods_receipts g
                 where g.delivery_id = o.delivery_id
                   and g.origin <> 'warehouse_bot') then
    v_refused := 'already_in_priority';
    v_detail  := (select 'Priority has ' || g.docno || ' (' || coalesce(g.statdes, '?') || ')'
                    from public.priority_goods_receipts g
                   where g.delivery_id = o.delivery_id and g.origin <> 'warehouse_bot'
                   order by g.synced_at desc limit 1);
  -- 3. the last request has not left pg_net yet: Make may still get it
  elsif o.request_id is not null
        and exists (select 1 from net.http_request_queue q where q.id = o.request_id) then
    v_refused := 'request_in_flight';
    v_detail  := 'pg_net request ' || o.request_id || ' is still queued';
  -- 4. the operator declares both client-side checks (Priority search, Make history)
  elsif not (coalesce(p_priority_checked, false) and coalesce(p_make_checked, false)) then
    v_refused := 'checks_not_confirmed';
    v_detail  := 'both "I searched Priority" and "I checked the Make history" are required';
  end if;

  -- 5. another delivery with the same NORMALISED note number is on its way or in Priority.
  --    Same sibling rule as M1's priority_push_plan() hold_same_invoice (same target; a queued /
  --    waiting sibling counts only when it was queued first; Priority GRs only for target 'make'),
  --    but on normalize_note_number(): plan() compares btrim() only, so '71:…' / '*…*' slip past it.
  if v_refused is null and not coalesce(p_release_guard, false) then
    select d.created_at,
           public.normalize_note_number(coalesce(d.document_number, o.document_number))
      into v_created, v_note
      from public.deliveries d
     where d.id = o.delivery_id;
    if v_note is not null then
      select 'delivery ' || d2.id || ' (note ' || coalesce(d2.document_number, o2.document_number, '?')
             || ', outbox ' || o2.id || ' ' || o2.status || ')'
        into v_detail
        from public.priority_push_outbox o2
        join public.deliveries d2 on d2.id = o2.delivery_id
       where o2.delivery_id <> o.delivery_id
         and o2.target = o.target
         and public.normalize_note_number(coalesce(d2.document_number, o2.document_number)) = v_note
         and d2.created_at between v_created - interval '90 days' and v_created + interval '90 days'
         and (o2.status in ('sent', 'unconfirmed', 'delivered', 'already_in_priority')
              or (o2.status in ('queued', 'waiting')
                  and (o2.queued_at, o2.id) < (o.queued_at, o.id)))
       order by o2.queued_at, o2.id
       limit 1;
      if v_detail is null and o.target = 'make' then
        select 'Priority ' || g.docno || ' (BOOKNUM ' || coalesce(g.booknum, '?') || ', '
               || coalesce(g.statdes, '?') || ')'
          into v_detail
          from public.priority_goods_receipts g
         where public.normalize_note_number(g.booknum) = v_note
           and g.origin <> 'warehouse_bot'
           and g.delivery_id is distinct from o.delivery_id
           and coalesce(g.curdate, g.synced_at) >= v_created - interval '90 days'
         order by g.synced_at desc
         limit 1;
      end if;
      if v_detail is not null then
        v_refused := 'sibling_in_flight';
      end if;
    end if;
  end if;

  -- 6. the stored reject would simply repeat (spec §3): a supplier Priority does not know
  --    → the same 400; unmapped items → the same Make 500 plus an empty header.
  --    The reply is read with M3's priority_push_error_class(), the classifier the office
  --    alert uses, so the page and the alert never disagree about what Priority said.
  if v_refused is null and not coalesce(p_override_known_reject, false) then
    v_class := public.priority_push_error_class(o.status, o.status_code, o.response_body, o.response_error);
    if o.status_code between 400 and 499
       and (v_class = 'supplier_missing' or coalesce(o.not_ready_reason, '') ~ 'supplier_unmatched') then
      begin
        v_explain := public.priority_push_explain(o.delivery_id);
      exception when others then
        v_explain := null;               -- cannot tell: treat as not fixed
      end;
      if not coalesce((v_explain ->> 'supplier_resolved')::boolean, false) then
        v_refused := 'known_reject_supplier';
        v_detail  := 'Priority refused the supplier last time and it still does not resolve to a Priority supplier';
      end if;
    end if;
    if v_refused is null
       and ((o.status_code >= 500 and coalesce(o.not_ready_reason, '') ~ 'items_unmapped')
            or (o.status_code between 400 and 499 and v_class = 'item_missing')) then
      if v_explain is null then
        begin
          v_explain := public.priority_push_explain(o.delivery_id);
        exception when others then
          v_explain := null;
        end;
      end if;
      if v_explain is null
         or (jsonb_typeof(v_explain -> 'unmapped_codes') = 'array'
             and jsonb_array_length(v_explain -> 'unmapped_codes') > 0) then
        v_refused := 'known_reject_items';
        v_detail  := 'items still not mapped for this supplier: '
                     || coalesce((v_explain -> 'unmapped_codes')::text, '(explain failed)');
      end if;
    end if;
  end if;

  if v_refused is not null then
    return jsonb_build_object('ok', false, 'refused', v_refused, 'outbox_id', p_outbox_id,
                              'attempt', null, 'status', o.status, 'detail', v_detail);
  end if;

  -- Accepted: keep the reply the next send would overwrite, then re-queue for job 8.
  -- M2's helper: one archive row per (outbox_id, request_id) (it skips a request that
  -- already has a row), attempt = that request's ordinal. When job 8 later
  -- re-sends, its own 'reply_overwritten' archive of the same request is a no-op.
  perform public.priority_push_archive_reply(o.id, 'resend', btrim(p_by));

  update public.priority_push_outbox
     set status        = 'queued',
         next_check_at = null,
         attempts      = 0,
         alerted_at    = null,
         alert_kind    = null,
         alert_tries   = 0,
         released_at   = case when coalesce(p_release_guard, false) then now() else released_at end
   where id = o.id;

  -- attempt = which send of this outbox row comes next (2 after the first Send again, 3 after
  -- the second): the same count(distinct request_id) + 1 that M2's dispatch puts in the body
  select count(distinct a.request_id) + 1 into v_cycle
    from public.priority_push_attempts a
   where a.outbox_id = o.id;

  return jsonb_build_object('ok', true, 'refused', null, 'outbox_id', o.id,
                            'attempt', v_cycle, 'status', 'queued', 'detail', null);
end
$$;

comment on function public.priority_push_resend(bigint, text, boolean, boolean, boolean, boolean) is
  '2026-10-08 (M4): operator "Send again" from the needs-attention page. Refuses with '
  'not_resendable_status | already_in_priority | request_in_flight | checks_not_confirmed | '
  'sibling_in_flight | known_reject_supplier | known_reject_items. On accept archives the last reply '
  '(priority_push_attempts reason=resend) and re-queues the row; released_at only with p_release_guard.';

revoke execute on function public.priority_push_resend(bigint, text, boolean, boolean, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.priority_push_resend(bigint, text, boolean, boolean, boolean, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. priority_push_mark_found
-- ---------------------------------------------------------------------------
create or replace function public.priority_push_mark_found(
  p_outbox_id bigint,
  p_docno     text,
  p_by        text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o         public.priority_push_outbox%rowtype;
  v_found   boolean;
  v_docno   text := upper(regexp_replace(coalesce(p_docno, ''), '\s', '', 'g'));
  v_refused text;
begin
  if nullif(btrim(coalesce(p_by, '')), '') is null then
    raise exception 'priority_push_mark_found: p_by (who confirmed it) is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.priority_push_dispatch'));

  select * into o from public.priority_push_outbox where id = p_outbox_id for update;
  v_found := found;

  -- a superset of the scanner's parseDocno (^[A-Z0-9][A-Z0-9/-]{2,39}$), so nothing the page
  -- accepts is refused here
  if v_docno !~ '^[A-Z0-9][A-Z0-9_/-]{2,39}$' then
    v_refused := 'docno_invalid';
  -- held rows (queued / waiting) may be marked too: the advisory lock keeps job 8 off them
  elsif not v_found
        or o.status not in ('failed', 'unconfirmed', 'sent', 'expired', 'queued', 'waiting') then
    v_refused := 'not_markable_status';
  elsif o.request_id is not null
        and exists (select 1 from net.http_request_queue q where q.id = o.request_id) then
    v_refused := 'request_in_flight';
  end if;

  if v_refused is not null then
    return jsonb_build_object('ok', false, 'refused', v_refused, 'outbox_id', p_outbox_id,
                              'docno', nullif(v_docno, ''), 'status', o.status);
  end if;

  -- keep the last reply (no-op when it was already archived, e.g. by an earlier Send again,
  -- or when the row was never sent)
  perform public.priority_push_archive_reply(o.id, 'mark_found', btrim(p_by));

  -- 'delivered' fires trg_priority_push_outcome (M3) like any other delivery.
  update public.priority_push_outbox
     set status           = 'delivered',
         not_ready_reason = 'confirmed by hand: Priority draft ' || v_docno || ' (' || btrim(p_by) || ')',
         next_check_at    = null
   where id = o.id;

  return jsonb_build_object('ok', true, 'refused', null, 'outbox_id', o.id,
                            'docno', v_docno, 'status', 'delivered', 'previous_status', o.status);
end
$$;

comment on function public.priority_push_mark_found(bigint, text, text) is
  '2026-10-08 (M4): operator "Mark as found": the office found the receipt in Priority by hand. '
  'Sets status delivered with not_ready_reason ''confirmed by hand: Priority draft <GR> (<by>)''. '
  'Refuses docno_invalid | not_markable_status | request_in_flight. Never calls wb_mark_gr_synced.';

revoke execute on function public.priority_push_mark_found(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.priority_push_mark_found(bigint, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. priority_push_attention_v
-- ---------------------------------------------------------------------------
-- security_invoker: the scanner reads it as service_role, which may read every table below.
-- The view calls normalize_note_number (M2) as the invoker, so service_role keeps EXECUTE on it.
grant execute on function public.normalize_note_number(text) to service_role;

create or replace view public.priority_push_attention_v
with (security_invoker = true) as
with cfg as (
  select coalesce(max(c.no_writeback_minutes), 5) as no_writeback_minutes,
         coalesce(max(c.held_alert_minutes), 30)  as held_alert_minutes
    from public.priority_push_config c
   where c.id = 1
),
ob as (
  select o.id, o.delivery_id, o.status, o.status_code, o.sent_at, o.queued_at, o.target,
         o.response_body, o.response_error, o.not_ready_reason, o.hold_reason,
         coalesce(o.category, public.priority_push_delivery_category(o.delivery_id)) as category,
         coalesce(d.document_number, o.document_number)                          as doc,
         d.supplier_hebrew, d.received_by_chat_id, d.created_at                  as delivery_created_at,
         coalesce(o.response_body, '') || ' ' || coalesce(o.response_error, '')  as reply_text,
         (select g.docno
            from public.priority_goods_receipts g
           where g.delivery_id = o.delivery_id and g.origin <> 'warehouse_bot'
           order by g.synced_at desc
           limit 1)                                                               as gr_docno,
         -- a row put back by Send again starts its "held" clock at the re-send
         greatest(o.queued_at,
                  (select max(a.created_at)
                     from public.priority_push_attempts a
                    where a.outbox_id = o.id and a.reason = 'resend'))            as held_since
    from public.priority_push_outbox o
    join public.deliveries d on d.id = o.delivery_id
   where o.status in ('failed', 'expired', 'unconfirmed', 'sent', 'queued', 'waiting')
),
ob2 as (
  select ob.*,
         case
           when ob.status in ('failed', 'expired') then 'failed'
           when ob.status = 'unconfirmed'
                and coalesce(ob.sent_at, ob.queued_at) < now() - make_interval(mins => cfg.no_writeback_minutes)
             then 'unconfirmed'
           when ob.status = 'sent'
                and coalesce(ob.sent_at, ob.queued_at) < now() - make_interval(mins => cfg.no_writeback_minutes)
             then 'no_writeback'
           when ob.status in ('queued', 'waiting')
                and ob.held_since < now() - make_interval(mins => cfg.held_alert_minutes)
             then 'held'
         end as problem,
         -- M3's classifier, the one the office alert carries (supplier_missing | item_missing |
         -- already_in_priority | make_crash | make_no_ok | no_reply | other). A queued row re-queued
         -- by Send again still holds its old reply, so held rows get no class.
         case
           when ob.status in ('queued', 'waiting') then null
           else public.priority_push_error_class(ob.status, ob.status_code, ob.response_body, ob.response_error)
         end as error_class
    from ob
   cross join cfg
),
outbox_rows as (
  select ob2.id                    as outbox_id,
         ob2.delivery_id,
         ob2.doc                   as document_number,
         ob2.supplier_hebrew       as supplier,
         ob2.category,
         ob2.problem,
         case
           when ob2.problem = 'failed' and ob2.gr_docno is not null then
             'Priority already has ' || ob2.gr_docno || ' for this delivery. Use Mark as found with that number; do not send again.'
           when ob2.status = 'expired' then
             'Never sent: ' || coalesce(ob2.not_ready_reason, 'the receipt could not be built')
             || '. Send again is not available for this row; tell Tonmoy.'
           when ob2.error_class = 'supplier_missing' then
             'Priority refused note ' || coalesce(ob2.doc, '?') || ': the supplier is not set up in Priority. '
             || 'No draft was created. Open the supplier in Priority, then Send again.'
           when ob2.error_class = 'item_missing' then
             'Priority refused note ' || coalesce(ob2.doc, '?') || ': an item on it is not set up in Priority. '
             || 'A draft header may already exist: search Priority for BOOKNUM ' || coalesce(ob2.doc, '?')
             || ' in any status, including draft (טיוטא), and link the item before any re-send.'
           when ob2.error_class = 'already_in_priority' then
             'Priority refused note ' || coalesce(ob2.doc, '?') || ' as already filed. Search Priority for BOOKNUM '
             || coalesce(ob2.doc, '?') || ' in any status, including draft (טיוטא), then use Mark as found.'
           when ob2.problem = 'failed' then
             'Make or Priority refused note ' || coalesce(ob2.doc, '?')
             || coalesce(' (HTTP ' || ob2.status_code || ')', '') || ': '
             || coalesce(left(nullif(btrim(ob2.reply_text), ''), 200), 'no detail recorded')
             || '. Check the Make history before any re-send.'
           when ob2.error_class = 'make_crash' then
             'Make crashed while building note ' || coalesce(ob2.doc, '?') || '. A draft header may already exist: '
             || 'search Priority for BOOKNUM ' || coalesce(ob2.doc, '?')
             || ' in any status, including draft (טיוטא), before any re-send.'
           when ob2.error_class = 'make_no_ok' then
             'Make took note ' || coalesce(ob2.doc, '?') || ' but no receipt came back. Check the Make history and '
             || 'Priority for BOOKNUM ' || coalesce(ob2.doc, '?') || ' (any status) before any re-send.'
           when ob2.problem = 'unconfirmed' then
             'No answer from Make for note ' || coalesce(ob2.doc, '?') || '. Check Priority and the Make history for BOOKNUM '
             || coalesce(ob2.doc, '?') || ' before any re-send.'
           when ob2.problem = 'no_writeback' then
             'Sent ' || to_char(ob2.sent_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
             || ' (Israel) and Priority has not confirmed note ' || coalesce(ob2.doc, '?')
             || '. Check the Make history and Priority for BOOKNUM ' || coalesce(ob2.doc, '?') || ' before any re-send.'
           when ob2.problem = 'held' then
             'Held, not sent: ' || coalesce(ob2.hold_reason, ob2.not_ready_reason, 'waiting for its turn to be sent')
         end                       as reason_text,
         ob2.status_code,
         ob2.error_class,
         ob2.sent_at,
         ob2.delivery_created_at   as created_at,
         ob2.received_by_chat_id   as receiver_chat_id,
         ob2.target,
         ob2.status                as outbox_status,
         ob2.gr_docno
    from ob2
   where ob2.problem is not null
),
not_queued as (
  select null::bigint              as outbox_id,
         d.id                      as delivery_id,
         d.document_number,
         d.supplier_hebrew         as supplier,
         public.priority_push_delivery_category(d.id) as category,
         'not_queued'::text        as problem,
         'Closed in the warehouse (' || d.status::text || ') but never queued for Priority, so nothing was sent. '
         || 'The enqueue step failed (bot_webhook_log event priority_push_enqueue); tell Tonmoy.' as reason_text,
         null::integer             as status_code,
         null::text                as error_class,
         null::timestamptz         as sent_at,
         d.created_at,
         d.received_by_chat_id     as receiver_chat_id,
         null::text                as target,
         null::text                as outbox_status,
         null::text                as gr_docno
    from public.deliveries d
   where d.status in ('Complete', 'Has Discrepancy')
     and not exists (select 1 from public.priority_push_outbox o where o.delivery_id = d.id)
     -- a Test receiver's never-queued delivery is not an office problem: its not_queued
     -- alert goes to the tester (is_test), and M3's digest fallback leaves it out the same way
     and not exists (select 1 from public.users u
                      where u.chat_id = d.received_by_chat_id
                        and u.env = 'Test'::public.user_env)
),
-- bot_unreachable (spec component 1, watch step 5): the office alert for this row never
-- reached the bot - M3's watch used up its 3 retries and the bot's last answer was not 2xx.
-- Nobody was told by WhatsApp, so the page (and the next digest) says so next to the row's
-- own problem row. No outbox_status / gr_docno: the page offers no button on it.
bot_unreachable as (
  select o.id                      as outbox_id,
         o.delivery_id,
         coalesce(d.document_number, o.document_number) as document_number,
         d.supplier_hebrew         as supplier,
         coalesce(o.category, public.priority_push_delivery_category(o.delivery_id)) as category,
         'bot_unreachable'::text   as problem,
         'The office alert (' || l.kind || ') for note '
         || coalesce(d.document_number, o.document_number, '?') || ' never reached the bot: it answered '
         || coalesce('HTTP ' || l.status_code, l.reply_error, 'nothing')
         || ' to all 4 tries (last ' || to_char(l.created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
         || ' Israel). Nobody was told on WhatsApp: deal with the note''s own row on this page, '
         || 'and tell Tonmoy if the bot is down.' as reason_text,
         l.status_code,
         null::text                as error_class,
         o.sent_at,
         d.created_at,
         d.received_by_chat_id     as receiver_chat_id,
         o.target,
         null::text                as outbox_status,
         null::text                as gr_docno
    from public.priority_push_outbox o
    join public.deliveries d on d.id = o.delivery_id
    join lateral (select l2.kind, l2.status_code, l2.reply_error, l2.created_at
                    from public.bot_webhook_log l2
                   where l2.outbox_id = o.id and l2.event = 'priority_push_outcome'
                   order by l2.id desc
                   limit 1) l on true
   where o.alert_tries >= 3
     and o.alert_kind = l.kind
     and l.kind in ('failed', 'unconfirmed', 'expired', 'no_writeback', 'held')
     and (l.status_code is not null or l.reply_error is not null)
     and (l.status_code is null or l.status_code not between 200 and 299)
),
ip as (
  select d.id, d.document_number, d.supplier_hebrew, d.created_at, d.received_by_chat_id,
         public.normalize_note_number(d.document_number) as note_key,
         array(select s.token from public.scan_sessions s
                where s.data ->> 'receipt_id' = d.id::text)  as tokens
    from public.deliveries d
   where d.status = 'In Progress'
     and d.created_at < now() - interval '2 hours'
     -- class 4 (a Priority GR is linked, e.g. 5121aaaa / GR26000036): never listed, never touched
     and not exists (select 1 from public.priority_goods_receipts g where g.delivery_id = d.id)
),
ip2 as (
  select ip.*,
         -- class 3 evidence: goods physically handled for THIS delivery
         (   exists (select 1 from public.pallets p where p.receipt_id = ip.id)
          or exists (select 1 from public.box_inventory b
                      where ip.note_key is not null
                        and public.normalize_note_number(b.invoice_number) = ip.note_key
                        and b.created_at >= ip.created_at
                        and not exists (select 1 from public.pallets p2
                                         where p2.id = b.pallet_id
                                           and p2.receipt_id is not null and p2.receipt_id <> ip.id))
          or exists (select 1 from public.carton_labels c
                      where c.session_token = any (ip.tokens)
                         or (ip.note_key is not null
                             and public.normalize_note_number(c.document_number) = ip.note_key
                             and c.created_at >= ip.created_at
                             and not exists (select 1 from public.scan_sessions s2
                                              where s2.token = c.session_token)))
          or exists (select 1 from public.scanner_events e
                      where e.token = any (ip.tokens)
                        and e.kind = 'ui'
                        and e.event in ('scan_detected', 'count_submit', 'confirm_pallet', 'pallet_completed',
                                        'identical_created', 'labels_saved', 'create_barcode'))
          or exists (select 1 from public.non_meat_inventory n
                      where ip.note_key is not null
                        and public.normalize_note_number(n.invoice_number) = ip.note_key
                        and n.created_at >= ip.created_at
                        -- stock a closed (or any other) delivery's pallet accounts for is not ours
                        and not exists (select 1 from public.pallets p3
                                         where p3.id = n.pallet_id
                                           and p3.receipt_id is not null and p3.receipt_id <> ip.id)
                        and not (n.pallet_id is null
                                 and exists (select 1 from public.deliveries s3
                                              where s3.id <> ip.id
                                                and s3.status <> 'In Progress'
                                                and public.normalize_note_number(s3.document_number) = ip.note_key)))
         )                                                         as has_goods,
         -- a manual capture is not proof of goods (class 3) but rules out class 1
         exists (select 1 from public.scanner_events e
                  where e.token = any (ip.tokens) and e.kind = 'ui' and e.event = 'manual_capture')
                                                                   as has_capture,
         (   exists (select 1 from public.delivery_po_links l where l.delivery_id = ip.id)
          or exists (select 1 from public.po_line_outcomes l where l.delivery_id = ip.id))
                                                                   as has_client_rows,
         exists (select 1 from public.priority_push_outbox o where o.delivery_id = ip.id)
                                                                   as has_outbox,
         -- an unlinked Priority receipt with this note could be linked to this row by the client
         exists (select 1 from public.priority_goods_receipts g
                  where ip.note_key is not null
                    and public.normalize_note_number(g.booknum) = ip.note_key
                    and g.delivery_id is null)                     as has_unlinked_gr,
         exists (select 1 from public.deliveries s
                  where s.id <> ip.id
                    and ip.note_key is not null
                    and public.normalize_note_number(s.document_number) = ip.note_key
                    and (s.status <> 'In Progress' or s.created_at > ip.created_at))
                                                                   as has_newer_or_closed_sibling,
         (select u.nickname from public.users u where u.chat_id = ip.received_by_chat_id limit 1)
                                                                   as receiver_name
    from ip
),
ip3 as (
  select ip2.*,
         case
           when ip2.has_goods then 'orphan_class3'
           when ip2.created_at < now() - interval '48 hours'
                and not ip2.has_capture
                and not ip2.has_client_rows
                and not ip2.has_outbox
                and not ip2.has_unlinked_gr
                and ip2.has_newer_or_closed_sibling then 'orphan_class1'
           else 'orphan_class2'
         end as problem
    from ip2
),
orphans as (
  select null::bigint              as outbox_id,
         ip3.id                    as delivery_id,
         ip3.document_number,
         ip3.supplier_hebrew       as supplier,
         public.priority_push_delivery_category(ip3.id) as category,
         ip3.problem,
         case ip3.problem
           when 'orphan_class3' then
             'Goods were scanned or labelled for note ' || coalesce(ip3.document_number, '?') || ' (opened '
             || to_char(ip3.created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') || ' Israel by '
             || coalesce(ip3.receiver_name, 'an unknown receiver') || ') but the receipt was never finished, '
             || 'so they are in neither stock nor Priority. Ask the receiver to finish it. Never delete it.'
           when 'orphan_class1' then
             'Superseded copy of note ' || coalesce(ip3.document_number, '?') || ' (opened '
             || to_char(ip3.created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI')
             || ' Israel): nothing was booked and a newer or closed copy exists. A clean-up candidate; '
             || 'nothing to do in Priority.'
           else
             'Note ' || coalesce(ip3.document_number, '?') || ' was opened '
             || to_char(ip3.created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') || ' Israel by '
             || coalesce(ip3.receiver_name, 'an unknown receiver')
             || ' and never finished; nothing was scanned or booked. Ask whether these goods arrived.'
             || case when ip3.has_client_rows
                     then ' The client has purchase-order rows on it: ask him before any clean-up.'
                     else '' end
         end                       as reason_text,
         null::integer             as status_code,
         null::text                as error_class,
         null::timestamptz         as sent_at,
         ip3.created_at,
         ip3.received_by_chat_id   as receiver_chat_id,
         null::text                as target,
         null::text                as outbox_status,
         null::text                as gr_docno
    from ip3
)
select * from outbox_rows
union all
select * from not_queued
union all
select * from bot_unreachable
union all
select * from orphans;

comment on view public.priority_push_attention_v is
  '2026-10-08 (M4): everything not (yet) in Priority that a person must look at, one row per problem: '
  'failed | unconfirmed | no_writeback | held | not_queued | bot_unreachable | orphan_class1 | orphan_class2 | orphan_class3. '
  'bot_unreachable = the office alert never reached the bot (M3 retries used up); it has no outbox_status, so no button. '
  'Read by the scanner page /priority/attention and the daily digest. Expired outbox rows show as failed '
  '(outbox_status = expired). Deliveries with a linked Priority GR (class 4) are never listed.';

revoke all on public.priority_push_attention_v from public, anon, authenticated;
grant select on public.priority_push_attention_v to service_role;
