-- =============================================================================
-- 2026-10-01  priority_push_autofire  (OUR Priority-push outbox: fix + harden)
-- =============================================================================
--
-- STATUS: NOT APPLIED. Tonmoy applies this file by hand (see "HOW TO APPLY").
--         Nothing in this file switches the push on: priority_push_config.url
--         stays NULL and enabled stays false until the client (Mevaser) gives
--         his Make webhook URL and his go-ahead.
--
-- WHAT IS WRONG TODAY (read live 2026-10-01, SELECT-only)
--   1. priority_push_enqueue() (trigger trg_priority_push_enqueue, AFTER UPDATE
--      OF status ON deliveries) inserts NEW.category, but deliveries has no
--      category column. Every close since 2026-09-23 raised 42703 and the
--      blanket `exception when others then return new` swallowed it, so
--      priority_push_outbox has 0 rows after 5 qualifying closes.
--   2. Its ON CONFLICT re-queues a row (any status except sent/delivered) when
--      the delivery status changes again. The client's wb_apply_priority_gr
--      flips deliveries.status draft -> 'In Progress' -> 'Complete', so a
--      re-close could queue a second Priority draft.
--   3. priority_push_dispatch() sends `X-Webhook-Secret: coalesce(sec, '')`:
--      it FAILS OPEN. The vault secret 'priority_push_secret' was never created.
--   4. No readiness gate (the client's wb_gr_priority_body ->> 'ready'), no
--      duplicate guard (priority_goods_receipts), no wait for the PO pick, and
--      4xx answers are retried like 5xx.
--   5. It is not AT MOST ONCE. dispatch() posts with an 8 s timeout and puts a
--      timeout / 5xx back to 'queued'. The client's Make scenario
--      ("קבלות סחורה מספק", blueprint read 2026-10-01) creates the Priority
--      draft header first, then makes one Priority call PER LINE, then calls
--      wb_mark_gr_synced, and only then answers - longer than 8 s for more than
--      a few lines. A timeout or a 5xx does NOT mean "nothing was created":
--      Make keeps running. When that run created the header but did not reach
--      wb_mark_gr_synced, the duplicate guard sees nothing and the re-send
--      creates a SECOND Priority draft - which cannot be undone from here.
--
-- WHAT THIS FILE DOES (OUR objects only)
--   * priority_push_config  + po_grace_minutes, recheck_minutes, max_wait_days,
--                             categories (default {meat}), enabled_since,
--                             category_since (jsonb: category -> switch-on time)
--   * priority_push_outbox  + next_check_at, not_ready_reason, unmapped_codes,
--                             released_at, response_body
--   * priority_push_config_enabled_since()  NEW  BEFORE UPDATE trigger function:
--       enabled false -> true sets enabled_since = now() and stamps every
--       category in categories with now(); a category ADDED while enabled is
--       stamped with now() (one removed loses its stamp); enabled = false clears
--       both. Neither can be edited by hand.
--   * priority_push_delivery_category(uuid) NEW  STABLE helper: the category of
--       a delivery = its pallets ('meat' wins), else the invoice OCR archive
--       (invoice_ocr_results.category). 15 of the 24 closes in the last 30
--       days have NO pallets rows (non-meat count path), so pallets alone
--       would leave it NULL; all 24 have an invoice_ocr_results category.
--   * priority_push_enqueue()   REPLACED: derives the category, never changes
--       the status of an existing row (no re-queue), records a delivery that
--       Priority already has as 'already_in_priority', and logs any failure to
--       bot_webhook_log (event 'priority_push_enqueue') instead of swallowing it.
--       It queues ('queued') ONLY on a real close, old status 'In Progress'. A
--       change between Complete and Has Discrepancy on a delivery that has no
--       outbox row (it closed before this file, or its enqueue failed) inserts
--       an inert 'skipped' row, so it can never be sent by itself (the 09-23
--       repair script flips Has Discrepancy -> Complete; add_delivery_extra_lines
--       flips a closed delivery to Has Discrepancy).
--       It still never blocks the bot's close.
--   * MARKER rows: every delivery that is closed when this file runs gets one
--       inert outbox row - 'skipped' ("closed before autofire" / Test user) or
--       'already_in_priority'. Nothing is sent for them; they only make sure an
--       old delivery has a row, so a later status change cannot queue it.
--   * priority_push_plan()      NEW: STABLE, side-effect free. Returns one
--       decision per due outbox row - including hold_same_invoice: a second
--       deliveries row for a supplier note already in Priority (the bot forks
--       them) is never sent by itself. Safe to run any time:
--         select * from public.priority_push_plan();
--   * priority_push_dispatch()  REPLACED: advisory lock (one run at a time);
--       reads replies back AT MOST ONCE (see READ-BACK below): only a request
--       that provably never left (DNS / TCP connect failure) is re-sent by
--       itself; a 2xx counts as delivered only with the scenario's
--       {"ok":true} body; a timeout, a 5xx, any other 2xx or anything unclear
--       becomes 'unconfirmed' and waits for a person; the scenario's
--       write-back (wb_mark_gr_synced) confirms a row. Request timeout 120 s
--       (was 8 s). Returns 0 unless
--       enabled AND url set; FAILS CLOSED when the vault secret is
--       missing/empty; then applies priority_push_plan().
--   * vault secret 'priority_push_secret' created ONCE (random 32 bytes, hex)
--     if it does not exist. Its value is handed to the client with the enable
--     step (see LATER below). Never printed by this file.
--   * EXECUTE on every priority_push_* function revoked from PUBLIC, anon and
--     authenticated (PUBLIC held EXECUTE, so revoking anon alone did nothing).
--     The owner (postgres, which runs cron job 8) and service_role keep it.
--
-- WHAT THIS FILE DOES NOT DO
--   * It does not set url or enabled. It does not touch cron job 8
--     'priority-push-dispatch' (every minute) - it keeps calling dispatch(),
--     which returns 0 while url is NULL / enabled is false.
--   * NO SEND BACKFILL: deliveries that already closed get only the inert
--     marker rows above; none is queued, and none is ever sent by itself.
--   * The client's objects are only READ (priority_goods_receipts,
--     delivery_po_links) or CALLED (wb_gr_priority_body - STABLE, read-only).
--     No wb_* function, priority_* / prit_* table, delivery_po_links,
--     catalog_products, sku_crosswalk or sync_runs object is created, altered
--     or written.
--   * The webhook payload is unchanged: {event:'delivery_closed', delivery_id,
--     document_number, status, category, supplier_name, supplier_vat,
--     received_by_chat_id} + header X-Webhook-Secret.
--
-- priority_push_plan() DECISIONS (first match wins; candidates are outbox rows
-- with status 'queued' or 'waiting' whose next_check_at is NULL or past)
--   already_in_priority  priority_goods_receipts has a row for the delivery with
--                        origin <> 'warehouse_bot' ('priority_push' from
--                        wb_mark_gr_synced, or 'priority' - a pull through
--                        wb_apply_priority_gr rewrites origin to 'priority').
--                        A cancelled GR (statdes 'מבוטלת', "cancelled") counts
--                        too: a re-send after a cancellation is done by hand.
--                        dispatch: status 'already_in_priority' (terminal).
--   hold_local_draft     only a local 'warehouse_bot' GR row exists (a push by
--                        hand may be in flight).           dispatch: untouched
--   hold_not_closed      the delivery is no longer Complete / Has Discrepancy.
--                                                            dispatch: untouched
--   hold_same_invoice    the SAME supplier note (document_number = Priority's
--                        BOOKNUM) is already in Priority, or on its way, under
--                        ANOTHER deliveries row - and released_at is NULL:
--                        a. another outbox row whose delivery has this
--                           document_number is sent / unconfirmed / delivered /
--                           already_in_priority, or is queued / waiting and was
--                           queued before this one (two forks closing together
--                           send only the first); or
--                        b. priority_goods_receipts has a row with origin <>
--                           'warehouse_bot', booknum = this document_number and
--                           a different (or no) delivery_id - which also sees a
--                           receipt the office typed into Priority by hand, once
--                           the client's pull has brought it in.
--                        The bot forks deliveries for one note on purpose: a
--                        re-photographed note whose delivery already closed (it
--                        only looks for In Progress ones of the last 48 h), and
--                        the "Separate delivery" button. Read live 2026-10-01:
--                        251068506 (two Complete forks), 261048511 (GR26000036
--                        on one fork, the other Has Discrepancy), IN264171048.
--                        Matched on document_number ALONE (trimmed), within 90
--                        days either side of this delivery: the forks of
--                        251068506 carry different supplier_vat values (an OCR
--                        difference), so a supplier match would miss a real
--                        fork. A different supplier's note with the same number
--                        is held too - the safe direction; release it by hand
--                        (LATER).                           dispatch: untouched
--   hold_pre_enable      queued_at < config.enabled_since (or enabled_since is
--                        NULL, i.e. the push is off) and released_at is NULL.
--                        Rows queued while the push was off are NEVER sent by
--                        themselves when it is switched on.  dispatch: untouched
--   hold_category        the category is not in config.categories (default
--                        {meat}; non-meat is held, not dropped). dispatch: untouched
--   hold_pre_category    queued_at < the time its category was switched on
--                        (config.category_since) and released_at is NULL.
--                        Rows held by category are NEVER sent by themselves
--                        when the category is switched on later - the same
--                        rule as hold_pre_enable.               dispatch: untouched
--   wait_po              no delivery_po_links row yet and the row is younger
--                        than po_grace_minutes.             dispatch: untouched
--   -- at most 20 rows per run get past this point (holds never use the budget,
--   -- so held rows cannot starve newer ones) --
--   expired              not ready (or error) and queued (or released, if later)
--                        more than max_wait_days ago.       dispatch: 'expired'
--   error                wb_gr_priority_body raised. dispatch: 'waiting',
--                        not_ready_reason 'error: ...', recheck later
--   not_ready            body->>'ready' is not true. reason = not_ready_reason,
--                        codes = unmapped_codes. dispatch: 'waiting', recheck
--                        after recheck_minutes
--   send                 ready.            dispatch: POST, status 'sent'
--
-- OUTBOX status values after this file: queued, waiting, sent, delivered,
-- failed, unconfirmed, skipped (Test user / closed before autofire /
-- Complete <-> Has Discrepancy with no row - response_error says which),
-- already_in_priority, expired. Only queued and waiting rows are ever sent;
-- sent is in flight. No other status is ever sent by itself (a late reply or
-- the write-back can still turn sent / unconfirmed into delivered or failed);
-- a row leaves them only by hand (LATER).
-- status is plain text with no CHECK constraint (read live 2026-10-01: the
-- outbox has only its primary key, UNIQUE (delivery_id) and the deliveries
-- FK), so the new values need no DDL.
--
-- READ-BACK - AT MOST ONCE (dispatch step 1; each pg_net reply is read once).
-- A Priority draft, once created, cannot be undone from here, so a request is
-- re-sent by itself ONLY when it provably never reached the webhook.
--   reply to a 'sent' row (net._http_response)               new status
--   -------------------------------------------------------  ------------------
--   2xx whose body is valid JSON with "ok" = JSON true       delivered
--     (the scenario's own confirmation)
--   any other 2xx: Make's default "Accepted", empty body,    unconfirmed
--     non-JSON, "ok" false / missing / a string               (not re-sent)
--   4xx                                                      failed (not re-sent)
--   no HTTP status, timed_out not true, and error_msg is a   queued again after
--     DNS / TCP connect failure: libcurl strerror            recheck_minutes while
--     "Couldn't resolve host name" / "Couldn't connect to    attempts <
--     server" (older libcurl), "Could not resolve hostname"  max_attempts, else
--     / "Could not connect to server" (libcurl 8.10+), or    failed
--     "Connection refused" (see c_never_left)
--   anything else: timed out (120 s), 5xx, 3xx, any other   unconfirmed
--     error or an empty error                                (not re-sent)
--   no reply 10 minutes after sent_at AND the request is no  unconfirmed
--     longer in net.http_request_queue (reply lost/expired)
--   a late reply to such an 'unconfirmed' row (same rules)   confirmed 2xx
--                                                            delivered, 4xx
--                                                            failed, else stays
--   'sent' or 'unconfirmed', and priority_goods_receipts     delivered
--     now has a row for the delivery with origin <>          (response_error
--     'warehouse_bot' (the scenario's wb_mark_gr_synced;     'confirmed by
--     the same predicate as plan()'s duplicate guard)        write-back: ...')
--   Every reply body (first 1000 chars) is kept in response_body; status_code
--   and response_error are kept as before (an unconfirmed 2xx gets an
--   explanatory response_error). The JSON test never raises: the body is cast
--   to jsonb only when pg_input_is_valid(content, 'jsonb') is true, and "ok"
--   is compared as jsonb (= 'true'::jsonb), never cast to boolean.
--
-- THE CLIENT'S SCENARIO and what each answer means (blueprint
-- "קבלות סחורה מספק" read 2026-10-01; Make's own replies from its webhook docs):
--   200 {"ok":true,"reason":"created_draft","docno":...}   draft with every
--       line, wb_mark_gr_synced ran                             -> delivered
--   400 {"ok":false,...,"stage":"createHeader"}  Priority refused the header;
--       nothing created                                         -> failed
--   400 {"ok":false,...,"stage":"createLines","failed_docno":...}  a line was
--       refused and the draft deleted again (DeleteForm)        -> failed
--   400 "Queue is full" / 429 "Too many requests" / 410 Gone   Make refused
--       the call; nothing ran                                   -> failed
--   500 "Scenario failed to complete."  a module without an error handler
--       failed (a Supabase call, DeleteForm, wb_mark_gr_synced): a draft MAY
--       exist                                                   -> unconfirmed
--   200 "Accepted"  Make's default reply: the run ended without reaching its
--       Webhook response (the "all lines in?" filter stopped it - a draft with
--       missing lines MAY exist), ran over Make's 180 s, or Make only queued
--       the call. NOT a confirmation                            -> unconfirmed
--   no reply within 120 s  Make keeps running; a draft MAY exist -> unconfirmed
--   The scenario does not check readiness itself; plan() does that first.
--
-- LIMITS (pg_net 0.20.3 live; read from its source 2026-10-01)
--   * pg_net deletes a batch of requests from net.http_request_queue and writes
--     their replies in ONE transaction, committed when every request of the
--     batch has finished. If the pg_net worker or the database restarts while a
--     request is in flight, that delete rolls back and pg_net sends the request
--     AGAIN (same request id) - below anything this file can see or stop. Only
--     a guard inside the client's scenario closes that (e.g. stop when
--     priority_goods_receipts already has an origin 'priority_push' row for the
--     delivery). Rare; the 120 s timeout widens the window.
--   * The same batching means a send can wait for the batch in flight
--     (<= 120 s), and other pg_net calls in this database (the finance
--     webhook) can wait that long while a push is in flight.
--   * "delivered" from a reply depends on the scenario's Webhook response body
--     staying {"ok":true,...}. If the client changes that body (or Make
--     answers for it), every success reads back as 'unconfirmed' until step
--     (1c) sees the wb_mark_gr_synced write-back and confirms it - safe, but
--     VERIFY 11 fills up. A scenario that answers {"ok":true} WITHOUT having
--     created the draft would be believed; the blueprint read 2026-10-01 only
--     answers it after wb_mark_gr_synced.
--
-- HOW TO APPLY
--   Supabase dashboard -> project vkeqzvwnqkuuwurgjjkd -> SQL Editor -> New
--   query -> paste this WHOLE file -> Run. It is one transaction (begin ...
--   commit): any error rolls everything back. It is re-runnable (create or
--   replace, add column if not exists, the secret only if missing, a marker
--   only for a closed delivery that has no outbox row).
--   Then run the commented VERIFY queries at the end (all SELECT-only).
--
-- LATER - only with the client's go-ahead (each send creates a real Priority
-- draft, and deleting a Supabase delivery does not undo it - GR26000032):
--   -- hand the secret to the client (run it yourself; do not paste it in chat logs):
--   --   select decrypted_secret from vault.decrypted_secrets where name = 'priority_push_secret';
--   -- switch on (enabled_since and category_since are stamped automatically by the trigger):
--   --   update public.priority_push_config set url = '<his Make webhook URL>', enabled = true where id = 1;
--   -- push non-meat too (only if he confirms).
--   -- WARNING: this does NOT send the non-meat rows queued while non_meat was off.
--   -- They move from hold_category to hold_pre_category and wait for a release by
--   -- hand, because the duplicate guard cannot see a receipt the office typed into
--   -- Priority by hand (origin 'priority' rows carry no delivery_id; hold_same_invoice
--   -- sees one by its BOOKNUM only once the client's pull has brought it in). Review
--   -- them before and after the switch:
--   --   select p.outbox_id, o.document_number, o.queued_at, p.decision, p.reason
--   --     from public.priority_push_plan() p
--   --     join public.priority_push_outbox o on o.id = p.outbox_id
--   --    where p.decision in ('hold_category', 'hold_pre_category')
--   --    order by o.queued_at;
--   --   update public.priority_push_config set categories = '{meat,non_meat}' where id = 1;
--   -- released_at lifts EVERY hold at once - hold_same_invoice included. Before ANY
--   -- release below, check that no other delivery of the same supplier note is in
--   -- Priority or on its way (Priority: BOOKNUM = document_number, ANY status):
--   --   select o.id, o.document_number, o2.id as other_outbox, o2.delivery_id as other_delivery,
--   --          o2.status as other_status, g.docno as gr_for_same_note, g.origin, g.statdes
--   --     from public.priority_push_outbox o
--   --     join public.deliveries d on d.id = o.delivery_id
--   --     left join public.deliveries d2
--   --            on btrim(d2.document_number) = btrim(d.document_number) and d2.id <> d.id
--   --     left join public.priority_push_outbox o2 on o2.delivery_id = d2.id
--   --     left join public.priority_goods_receipts g
--   --            on btrim(g.booknum) = btrim(d.document_number) and g.origin <> 'warehouse_bot'
--   --           and g.delivery_id is distinct from d.id
--   --    where o.id in (<ids>);
--   -- send a held row on purpose, one by one, after checking in Priority that it is not there:
--   --   select * from public.priority_push_plan() where decision in ('hold_pre_enable', 'hold_pre_category');
--   --   update public.priority_push_outbox set released_at = now() where id in (<ids>);
--   -- send a hold_same_invoice row on purpose - ONLY when it is genuinely a SECOND
--   -- delivery of goods under the same supplier note (Priority then gets a second
--   -- draft with the same BOOKNUM), or a different supplier whose note number is the
--   -- same. Otherwise leave it held: the goods are already in the first draft.
--   --   select p.outbox_id, o.document_number, o.queued_at, p.reason
--   --     from public.priority_push_plan() p
--   --     join public.priority_push_outbox o on o.id = p.outbox_id
--   --    where p.decision = 'hold_same_invoice';
--   --   update public.priority_push_outbox set released_at = now() where id in (<ids>);
--   -- send a 'skipped' delivery on purpose (a marker "closed before autofire", or a
--   -- Complete <-> Has Discrepancy change with no outbox row) - NEVER a Test-user row:
--   --   select id, document_number, delivery_status, category, response_error, queued_at
--   --     from public.priority_push_outbox where status = 'skipped' order by queued_at;
--   --   update public.priority_push_outbox
--   --      set status = 'queued', released_at = now(), response_error = null
--   --    where id in (<ids>) and status = 'skipped'
--   --      and response_error not like 'skipped: Test user%';
--   -- re-send an 'unconfirmed' row on purpose - ONLY AFTER checking in Priority
--   -- (קבלות סחורה מספק / DOCUMENTS_P: the supplier, BOOKNUM = the row's
--   -- document_number, ANY status incl. טיוטא) that NO draft exists for it, and
--   -- that pg_net no longer holds its request (still_in_pg_net must be false):
--   --   select o.id, o.document_number, o.attempts, o.sent_at, o.status_code,
--   --          o.response_error, left(o.response_body, 200) as body,
--   --          exists (select 1 from net.http_request_queue q where q.id = o.request_id) as still_in_pg_net
--   --     from public.priority_push_outbox o where o.status = 'unconfirmed' order by o.sent_at;
--   --   update public.priority_push_outbox
--   --      set status = 'queued', released_at = now(), next_check_at = null
--   --    where id in (<ids>) and status = 'unconfirmed';
--   -- plan() runs its duplicate guard again before the send. attempts is NOT
--   -- reset by this update: a row already at max_attempts whose re-send then
--   -- provably never leaves (DNS / connect failure) goes straight to 'failed'
--   -- with no automatic retry. To allow those retries again, ALSO set
--   -- attempts = 0 in the same update:
--   --      set status = 'queued', released_at = now(), next_check_at = null, attempts = 0
--   -- (attempts then no longer counts the earlier sends - response_error /
--   -- response_body of the old send are overwritten by the new one anyway).
--   -- The same update with status = 'failed' re-sends a failed row once its
--   -- cause is fixed (a 4xx: Make or Priority refused it, nothing was created;
--   -- or the DNS / connect retries ran out - then set attempts = 0 too).
--   -- If Priority DOES have the draft, do not re-send - record it instead:
--   --   update public.priority_push_outbox
--   --      set status = 'delivered', response_error = 'confirmed by hand: Priority draft <DOCNO>'
--   --    where id = <id> and status = 'unconfirmed';
--   -- kill switch (stops new sends on the next minute; in-flight replies are still read back):
--   --   update public.priority_push_config set enabled = false where id = 1;
--   Note: switching off and on again re-stamps enabled_since and every category's
--   category_since, so rows queued before the re-enable are held again and need
--   released_at to go out.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Pre-flight: stop (and roll back) if the live schema is not what this
--    file was written against. Read-only checks.
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.priority_push_outbox') is null
     or to_regclass('public.priority_push_config') is null then
    raise exception 'priority_push_outbox / priority_push_config missing - apply migration priority_push_outbox first';
  end if;
  if not exists (select 1 from public.priority_push_config where id = 1) then
    raise exception 'priority_push_config row id=1 missing';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.priority_push_outbox'::regclass
                    and contype = 'u'
                    and pg_get_constraintdef(oid) = 'UNIQUE (delivery_id)') then
    raise exception 'priority_push_outbox has no UNIQUE (delivery_id) - ON CONFLICT would fail';
  end if;
  if to_regprocedure('public.wb_gr_priority_body(uuid, text)') is null then
    raise exception 'client function public.wb_gr_priority_body(uuid, text) not found - its signature changed; stop and re-read it';
  end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception 'pg_net net.http_post(text, jsonb, jsonb, jsonb, integer) not found';
  end if;
  -- The read-back's no-raise JSON test needs pg_input_is_valid (Postgres 16+;
  -- the project runs 17.6 as read 2026-10-01).
  if to_regprocedure('pg_catalog.pg_input_is_valid(text, text)') is null then
    raise exception 'pg_input_is_valid(text, text) not found (Postgres < 16?) - the read-back JSON test needs it';
  end if;
  -- The read-back is plpgsql, so a missing column would only fail at run time
  -- (every minute, in cron job 8). Check the pg_net columns it uses now.
  if to_regclass('net.http_request_queue') is null
     or (select count(*) from information_schema.columns
          where table_schema = 'net' and table_name = '_http_response'
            and column_name in ('id', 'status_code', 'content', 'timed_out', 'error_msg', 'created')) <> 6 then
    raise exception 'pg_net net.http_request_queue / net._http_response(id, status_code, content, timed_out, error_msg, created) not as expected - re-read pg_net before applying';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'vault.decrypted_secrets not found';
  end if;
  if to_regclass('public.bot_webhook_log') is null
     or to_regclass('public.invoice_ocr_results') is null
     or to_regclass('public.delivery_po_links') is null
     or to_regclass('public.priority_goods_receipts') is null then
    raise exception 'a table this file reads is missing';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
alter table public.priority_push_config
  add column if not exists po_grace_minutes integer not null default 5,
  add column if not exists recheck_minutes  integer not null default 10,
  add column if not exists max_wait_days    integer not null default 7,
  add column if not exists categories       text[]  not null default '{meat}',
  add column if not exists enabled_since    timestamptz,
  add column if not exists category_since   jsonb   not null default '{}'::jsonb;

comment on column public.priority_push_config.po_grace_minutes is
  'Minutes after the close to wait for a purchase-order answer (a delivery_po_links row) before sending.';
comment on column public.priority_push_config.recheck_minutes is
  'Minutes between readiness re-checks of a waiting row; also the back-off before re-sending a request that provably never reached the webhook (DNS / TCP connect failure). A timeout or 5xx is never re-sent (status unconfirmed).';
comment on column public.priority_push_config.max_attempts is
  'Sends per outbox row. Only a request that provably never left (DNS / TCP connect failure, or net.http_post raised) is re-sent by itself, up to this many sends, then failed. A timeout or 5xx is never re-sent (status unconfirmed).';
comment on column public.priority_push_config.max_wait_days is
  'A row still not ready this many days after queued_at becomes expired.';
comment on column public.priority_push_config.categories is
  'Delivery categories that are sent (meat / non_meat). Others are held in the outbox, not dropped.';
comment on column public.priority_push_config.enabled_since is
  'Set by trigger when enabled flips false->true, cleared when disabled. Rows queued before it are held (hold_pre_enable) unless released_at is set.';
comment on column public.priority_push_config.category_since is
  'Set by trigger: {category: time it was switched on}. Stamped for every category when enabled flips false->true, for a category added while enabled, cleared when disabled. Rows queued before their category''s time are held (hold_pre_category) unless released_at is set.';

alter table public.priority_push_outbox
  add column if not exists next_check_at    timestamptz,
  add column if not exists not_ready_reason text,
  add column if not exists unmapped_codes   text[],
  add column if not exists released_at      timestamptz,
  add column if not exists response_body    text;

comment on column public.priority_push_outbox.next_check_at is
  'Not considered by the dispatcher before this time (waiting re-check, or the back-off before re-sending a request that never left: DNS / connect failure). NULL = due now.';
comment on column public.priority_push_outbox.response_body is
  'Body of the webhook reply (net._http_response.content, first 1000 chars), any status. The client''s scenario answers 200 {"ok":true,"reason":"created_draft","docno":...} after wb_mark_gr_synced - only that body makes a 2xx delivered; any other 2xx (e.g. Make''s default "Accepted") is unconfirmed.';
comment on column public.priority_push_outbox.not_ready_reason is
  'Why the client gate wb_gr_priority_body said not ready (supplier_unmatched, items_unmapped, nothing_received, error: ...).';
comment on column public.priority_push_outbox.unmapped_codes is
  'Item codes wb_gr_priority_body could not map to a Priority PARTNAME.';
comment on column public.priority_push_outbox.released_at is
  'Set by hand to send a row on purpose that is otherwise never sent by itself: queued before the push was enabled (hold_pre_enable) or before its category was switched on (hold_pre_category), another delivery of the same supplier note already in Priority (hold_same_invoice), or a skipped / unconfirmed / failed row put back to queued. It lifts ALL of those holds at once. max_wait_days counts from it.';

create index if not exists idx_priority_push_outbox_due
  on public.priority_push_outbox (queued_at)
  where status in ('queued', 'waiting');

-- -----------------------------------------------------------------------------
-- 2. enabled_since and category_since are automatic
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_config_enabled_since()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.enabled and not coalesce(old.enabled, false) then
    -- switched on now: the push and every category it sends start now
    new.enabled_since  := now();
    new.category_since := (select coalesce(jsonb_object_agg(s.c, to_jsonb(now())), '{}'::jsonb)
                             from (select distinct c from unnest(new.categories) c
                                    where c is not null) s);
  elsif not new.enabled then
    -- off: nothing is "since"
    new.enabled_since  := null;
    new.category_since := '{}'::jsonb;
  else
    -- stays on: not editable by hand. A category already on keeps its time;
    -- one added now starts now; one removed loses its time (re-adding it
    -- starts it again, so rows queued meanwhile stay held).
    new.enabled_since  := old.enabled_since;
    new.category_since := (select coalesce(jsonb_object_agg(s.c, coalesce(old.category_since -> s.c,
                                                                          to_jsonb(now()))),
                                           '{}'::jsonb)
                             from (select distinct c from unnest(new.categories) c
                                    where c is not null) s);
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create or replace trigger trg_priority_push_config_enabled_since
  before update on public.priority_push_config
  for each row execute function public.priority_push_config_enabled_since();

-- -----------------------------------------------------------------------------
-- 3. Category of a delivery (deliveries has no category column)
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_delivery_category(p_delivery_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(
    (select pl.category
       from public.pallets pl
      where pl.receipt_id = p_delivery_id
      order by (pl.category = 'meat') desc, pl.created_at
      limit 1),
    (select i.category
       from public.invoice_ocr_results i
      where i.delivery_id = p_delivery_id
      order by i.created_at desc
      limit 1));
$function$;

comment on function public.priority_push_delivery_category(uuid) is
  'Category of a delivery for the Priority push: its pallets (meat wins), else invoice_ocr_results.category. NULL if neither exists.';

-- -----------------------------------------------------------------------------
-- 4. Enqueue: fixed category, no re-queue, failures logged
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_env    public.user_env;
  v_reason text;
  v_cat    text;
  v_gr     text;
  v_status text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status::text not in ('Complete', 'Has Discrepancy') then
    return new;
  end if;

  -- Test users are never sent (same gate as the finance webhook) - unchanged.
  select u.env into v_env from public.users u where u.chat_id = new.received_by_chat_id;
  v_reason := case when coalesce(v_env, 'Prod'::public.user_env) = 'Test'::public.user_env
                   then 'skipped: Test user ' || coalesce(new.received_by_chat_id::text, '?') end;

  v_cat := public.priority_push_delivery_category(new.id);

  -- Priority already has it (a push by hand, or a pull that just re-closed it).
  select g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?') || ')'
    into v_gr
    from public.priority_goods_receipts g
   where g.delivery_id = new.id
     and g.origin <> 'warehouse_bot'
   order by g.synced_at desc
   limit 1;

  -- Only a real close (In Progress -> Complete / Has Discrepancy) is queued.
  -- Complete <-> Has Discrepancy reaches this INSERT only when the delivery has
  -- no outbox row: it closed before this file (and missed its marker) or its
  -- enqueue failed. Its queued_at would be now(), past enabled_since, so a
  -- 'queued' row would be sent by itself - insert it inert ('skipped') instead.
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

  -- One row per delivery. A later status change (e.g. the client's draft->final
  -- pull, or Complete <-> Has Discrepancy) only refreshes delivery_status; it
  -- NEVER changes the row's status, so it never re-queues the row.
  insert into public.priority_push_outbox as o
         (delivery_id, document_number, delivery_status, category, status, response_error)
  values (new.id, new.document_number, new.status::text, v_cat, v_status, v_reason)
  on conflict (delivery_id) do update
     set delivery_status = excluded.delivery_status,
         category        = coalesce(o.category, excluded.category);
  return new;
exception when others then
  -- Never block the bot's close, but never hide the failure either.
  begin
    insert into public.bot_webhook_log (event, delivery_id, error)
    values ('priority_push_enqueue', new.id, left(sqlerrm, 500));
  exception when others then
    null;
  end;
  return new;
end
$function$;

-- -----------------------------------------------------------------------------
-- 4b. Marker rows for every delivery that is closed NOW (not a send backfill).
--     Without a row, an old delivery's next Complete <-> Has Discrepancy change
--     (or a re-open and re-close) would reach the INSERT above. With one, the
--     ON CONFLICT path keeps it inert. Nothing here is ever queued or sent.
--     ON CONFLICT DO NOTHING: re-running the file leaves every existing row alone.
-- -----------------------------------------------------------------------------
insert into public.priority_push_outbox
       (delivery_id, document_number, delivery_status, category, status, response_error)
select d.id,
       d.document_number,
       d.status::text,
       public.priority_push_delivery_category(d.id),
       case when m.test_user            then 'skipped'
            when m.gr is not null       then 'already_in_priority'
            else 'skipped' end,
       case when m.test_user            then 'skipped: Test user ' || coalesce(d.received_by_chat_id::text, '?')
            when m.gr is not null       then 'not sent: Priority already has GR ' || m.gr
            else 'skipped: closed before autofire (marker from migration 2026-10-01); never sent by itself'
                 || ' (to send it on purpose set status ''queued'' and released_at)' end
  from public.deliveries d
  cross join lateral (
    select exists (select 1 from public.users u
                    where u.chat_id = d.received_by_chat_id
                      and u.env = 'Test'::public.user_env) as test_user,
           (select g.docno || ' (origin ' || g.origin || ', ' || coalesce(g.statdes, '?') || ')'
              from public.priority_goods_receipts g
             where g.delivery_id = d.id
               and g.origin <> 'warehouse_bot'
             order by g.synced_at desc
             limit 1) as gr) m
 where d.status::text in ('Complete', 'Has Discrepancy')
on conflict (delivery_id) do nothing;

-- -----------------------------------------------------------------------------
-- 5. Plan: what the dispatcher would do now. STABLE = cannot write anything.
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_plan()
returns table (outbox_id bigint, delivery_id uuid, decision text, reason text, codes text[])
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
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

    -- (1) Duplicate guard: Priority already has a receipt for this delivery.
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

    -- (2) A local draft row exists: a push by hand may be in flight.
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

    -- (3) The delivery was re-opened after it was queued.
    if rw.delivery_status_now is null
       or rw.delivery_status_now not in ('Complete', 'Has Discrepancy') then
      decision := 'hold_not_closed';
      reason   := 'delivery status is now ' || coalesce(rw.delivery_status_now, 'missing')
                  || '; sent only while Complete / Has Discrepancy';
      return next;
      continue;
    end if;

    -- (3b) The same supplier note is (or is about to be) in Priority under
    --      ANOTHER delivery row: a second draft for one BOOKNUM cannot be
    --      undone from here. Keyed on document_number alone (see the header).
    if v_doc is not null and rw.released_at is null then
      -- a. another delivery of this note already went (or is going) out
      select 'outbox row ' || o2.id || ' (delivery ' || o2.delivery_id || ', status ' || o2.status || ')'
        into v_dup
        from public.priority_push_outbox o2
        join public.deliveries d2 on d2.id = o2.delivery_id
       where o2.id <> rw.id
         and o2.delivery_id <> rw.delivery_id
         and btrim(coalesce(d2.document_number, o2.document_number)) = v_doc
         and d2.created_at between rw.delivery_created_at - interval '90 days'
                               and rw.delivery_created_at + interval '90 days'
         and (o2.status in ('sent', 'unconfirmed', 'delivered', 'already_in_priority')
              or (o2.status in ('queued', 'waiting')
                  and (o2.queued_at, o2.id) < (rw.queued_at, rw.id)))
       order by o2.queued_at, o2.id
       limit 1;
      -- b. Priority already has a receipt for this note (BOOKNUM) that is not
      --    this delivery's - a push for another fork, or typed by the office
      if v_dup is null then
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

    -- (4) Queued while the push was off: never sent by itself.
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

    -- (5) Category not switched on (default: meat only).
    v_cat := coalesce(rw.category, public.priority_push_delivery_category(rw.delivery_id));
    if v_cat is null or not (v_cat = any (cfg.categories)) then
      decision := 'hold_category';
      reason   := 'category ' || coalesce(v_cat, 'unknown') || ' is not in priority_push_config.categories '
                  || cfg.categories::text;
      return next;
      continue;
    end if;

    -- (6) Queued before its category was switched on: never sent by itself
    --     (same rule as (4); a missing time counts as "not switched on yet").
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

    -- (7) Give the worker po_grace_minutes to answer the purchase-order question.
    if not exists (select 1 from public.delivery_po_links l where l.delivery_id = rw.delivery_id)
       and rw.queued_at > now() - make_interval(mins => cfg.po_grace_minutes) then
      decision := 'wait_po';
      reason   := 'no purchase-order answer yet (no delivery_po_links row); waiting until '
                  || to_char((rw.queued_at + make_interval(mins => cfg.po_grace_minutes)) at time zone 'Asia/Jerusalem',
                             'HH24:MI') || ' (Israel)';
      return next;
      continue;
    end if;

    -- (8) Readiness, by the client's own read-only gate. Bounded per run;
    --     rows beyond the budget are evaluated on a later run.
    if v_evaluated >= c_batch then
      continue;
    end if;
    v_evaluated := v_evaluated + 1;

    v_failed := null;
    v_ready  := false;
    v_reason := null;
    v_codes  := null;
    begin
      v_body  := public.wb_gr_priority_body(rw.delivery_id);
      v_ready := coalesce((v_body ->> 'ready')::boolean, false);
      if not v_ready then
        v_reason := coalesce(v_body ->> 'not_ready_reason', 'not ready (no not_ready_reason given)');
        if jsonb_typeof(v_body -> 'unmapped_codes') = 'array' then
          v_codes := array(select jsonb_array_elements_text(v_body -> 'unmapped_codes'));
        end if;
      end if;
    exception when others then
      v_failed := left(sqlerrm, 500);
    end;

    -- Expiry counts from the later of queued_at and released_at, so a row
    -- released by hand gets its own max_wait_days instead of expiring at once.
    if (v_failed is not null or not v_ready)
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
      reason   := 'ready (category ' || v_cat || ')';
    end if;
    return next;
  end loop;
end
$function$;

comment on function public.priority_push_plan() is
  'Side-effect-free preview of priority_push_dispatch(): one decision per due outbox row (already_in_priority, hold_local_draft, hold_not_closed, hold_same_invoice, hold_pre_enable, hold_category, hold_pre_category, wait_po, expired, error, not_ready, send). Calls the client''s wb_gr_priority_body read-only.';

-- -----------------------------------------------------------------------------
-- 6. Dispatch: read back, gate, fail closed, apply the plan
-- -----------------------------------------------------------------------------
create or replace function public.priority_push_dispatch()
returns integer
language plpgsql
security definer
set search_path = public, net, vault, pg_temp
as $function$
declare
  cfg     public.priority_push_config%rowtype;
  v_found boolean;
  sec     text;
  p       record;
  r       record;
  req     bigint;
  n       integer := 0;
  -- The client's scenario answers only after the header, one Priority call per
  -- line (~1-2 s each) and wb_mark_gr_synced; Make itself waits at most 180 s
  -- for its Webhook response module.
  c_timeout_ms constant integer  := 120000;
  -- A 'sent' row with no reply this long after sent_at, whose request pg_net no
  -- longer holds, is unconfirmed. >= 2 x the timeout (a request can first wait
  -- for the pg_net batch in flight, then run its own 120 s) plus slack.
  c_no_reply   constant interval := interval '10 minutes';
  -- error_msg that proves the request never left (no HTTP status, not timed
  -- out). pg_net 0.20.3 writes libcurl's curl_easy_strerror(): "Couldn't
  -- resolve host name" / "Couldn't connect to server" (older libcurl), "Could
  -- not resolve hostname" / "Could not connect to server" (libcurl 8.10+).
  -- "Connection refused" is curl's error-buffer wording, kept in case pg_net
  -- switches to it. Matched case-insensitively (~*).
  c_never_left constant text     := 'could(n.t| not) (resolve host|connect to server)|connection refused';
begin
  -- One dispatcher at a time (cron every minute + any manual call).
  if not pg_try_advisory_xact_lock(hashtext('public.priority_push_dispatch')) then
    return 0;
  end if;

  select * into cfg from public.priority_push_config c where c.id = 1;
  v_found := found;

  -- (1) Read back pg_net's replies - AT MOST ONCE. A request is re-sent by
  --     itself ONLY when it provably never reached the webhook (no HTTP status,
  --     not timed out, a DNS / TCP connect failure): queued again after
  --     recheck_minutes while attempts < max_attempts, else failed.
  --     A 2xx is 'delivered' ONLY when its body is the scenario's own
  --     confirmation: valid JSON whose "ok" is the JSON boolean true (the
  --     scenario answers 200 {"ok":true,"reason":"created_draft","docno":...}
  --     after wb_mark_gr_synced). Any other 2xx - Make's default "Accepted",
  --     an empty body, non-JSON, "ok" false / missing / a string - proves
  --     nothing -> unconfirmed. The JSON test cannot raise: the cast to jsonb
  --     runs only when pg_input_is_valid() says the text is valid jsonb, and
  --     "ok" is compared as jsonb, never cast.
  --     4xx -> failed (with the client's scenario a 400 means the header was
  --     refused or the draft was deleted again). Anything else - timed out,
  --     5xx, 3xx, any other error - -> unconfirmed: Make may still have created
  --     the draft, so it is NEVER re-sent by itself.
  --     Also read: a late reply to an 'unconfirmed' row from step (1b) (same
  --     rules: confirmed 2xx -> delivered, 4xx -> failed, else it stays
  --     unconfirmed), and the reply to a row step (1c) already confirmed (stays
  --     delivered; only the reply is kept).
  --     responded_at = net._http_response.created, which pg_net stamps when its
  --     batch STARTS, i.e. about when the request left, not when the reply came.
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

  -- (1b) No reply long after the send, and pg_net no longer holds the request
  --      (pg_net 0.20.3 removes a request from net.http_request_queue in the
  --      same transaction that writes its reply, so "neither" means the reply
  --      was lost or expired after pg_net.ttl) -> unconfirmed: it may have
  --      reached Make. While the request is still queued (worker behind or
  --      down) the row stays 'sent': pg_net will still send it, so it must not
  --      look re-sendable to a person.
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

  -- (1c) Confirmation by write-back: the scenario's wb_mark_gr_synced wrote the
  --      receipt (origin 'priority_push'). Same predicate and text as the
  --      duplicate guard in plan() and enqueue (origin <> 'warehouse_bot').
  --      priority_goods_receipts is only READ.
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

  -- (2) Off until the client's URL is set and enabled.
  if not v_found or not cfg.enabled or nullif(btrim(cfg.url), '') is null then
    return 0;
  end if;

  -- (3) FAIL CLOSED: no secret, no send.
  select ds.decrypted_secret
    into sec
    from vault.decrypted_secrets ds
   where ds.name = cfg.secret_name
   limit 1;
  if sec is null or sec = '' then
    return 0;
  end if;

  -- (4) Apply the plan. hold_* and wait_po leave the row untouched.
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
             d.supplier_hebrew, d.supplier_vat, d.received_by_chat_id
        into r
        from public.priority_push_outbox o
        join public.deliveries d on d.id = o.delivery_id
       where o.id = p.outbox_id
         and o.status in ('queued', 'waiting');
      if found then
        begin
          select net.http_post(
            url := cfg.url,
            headers := jsonb_build_object('Content-Type', 'application/json',
                                          'X-Webhook-Secret', sec),
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
                 not_ready_reason = null, unmapped_codes = null, next_check_at = null,
                 category = r.category
           where o.id = r.id;
          n := n + 1;
        exception when others then
          -- net.http_post raised, or the update did: the subtransaction rolled
          -- back the pg_net queue insert too, so nothing was sent - re-queue is safe.
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

comment on function public.priority_push_dispatch() is
  'pg_cron job 8, every minute. Reads pg_net replies back AT MOST ONCE (2xx with the scenario''s {"ok":true} body delivered; 4xx failed; only a request that provably never left - DNS / TCP connect failure - is re-queued, up to max_attempts; timeout, 5xx, any other 2xx and anything else unconfirmed, never re-sent by itself), marks a long-silent sent row unconfirmed, confirms sent/unconfirmed rows by the scenario''s write-back (priority_goods_receipts), then (only when enabled, url set and the vault secret exists) applies priority_push_plan(): at most 20 sends per run, 120 s timeout.';

-- -----------------------------------------------------------------------------
-- 7. The shared secret, created once
-- -----------------------------------------------------------------------------
do $secret$
begin
  if not exists (select 1 from vault.secrets where name = 'priority_push_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'priority_push_secret',
      'X-Webhook-Secret sent by priority_push_dispatch() to the client''s Make goods-receipt webhook');
  end if;
end
$secret$;

-- -----------------------------------------------------------------------------
-- 8. Privileges: server-side only
-- -----------------------------------------------------------------------------
revoke execute on function public.priority_push_enqueue()                from public, anon, authenticated;
revoke execute on function public.priority_push_dispatch()               from public, anon, authenticated;
revoke execute on function public.priority_push_plan()                   from public, anon, authenticated;
revoke execute on function public.priority_push_delivery_category(uuid)  from public, anon, authenticated;
revoke execute on function public.priority_push_config_enabled_since()   from public, anon, authenticated;
grant  execute on function public.priority_push_dispatch()               to service_role;
grant  execute on function public.priority_push_plan()                   to service_role;
grant  execute on function public.priority_push_delivery_category(uuid)  to service_role;

-- -----------------------------------------------------------------------------
-- 9. Report (read-only). The push must still be off.
-- -----------------------------------------------------------------------------
do $report$
declare
  c public.priority_push_config%rowtype;
begin
  select * into c from public.priority_push_config where id = 1;
  raise notice 'priority_push_config: url %, enabled %, enabled_since %, categories %, category_since %',
    case when c.url is null then 'NULL' else 'SET' end, c.enabled, c.enabled_since, c.categories, c.category_since;
  if c.enabled and c.enabled_since is null then
    raise notice 'enabled is already true but enabled_since is NULL: every row is held (hold_pre_enable) until the push is switched off and on again';
  end if;
  raise notice 'outbox rows by status (markers included): %',
    (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
       from (select o.status, count(*) as n from public.priority_push_outbox o group by o.status) s);
  raise notice 'closed deliveries with NO outbox row (expect 0): %',
    (select count(*) from public.deliveries d
      where d.status::text in ('Complete', 'Has Discrepancy')
        and not exists (select 1 from public.priority_push_outbox o where o.delivery_id = d.id));
  raise notice 'vault secret priority_push_secret exists: %',
    exists (select 1 from vault.secrets where name = 'priority_push_secret');
end
$report$;

commit;

-- =============================================================================
-- VERIFY after applying (all SELECT-only; run them one by one in the SQL editor)
-- =============================================================================
--
-- -- 1. The enqueue no longer reads NEW.category; all five functions exist,
-- --    SECURITY DEFINER where expected, plan() is STABLE ('s').
-- select pg_get_functiondef('public.priority_push_enqueue()'::regprocedure) ~* 'new\.category' as still_broken;  -- expect false
-- select p.oid::regprocedure as fn, p.provolatile, p.prosecdef, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like 'priority_push%' order by 1;           -- expect 5 rows
--
-- -- 1b. The at-most-once dispatcher is the one in place: 120 s timeout, no 8 s,
-- --     write-back confirmation present; the outbox has response_body.
-- select pg_get_functiondef('public.priority_push_dispatch()'::regprocedure) ~ 'c_timeout_ms\s+constant integer\s+:= 120000' as timeout_120s,  -- expect true
--        pg_get_functiondef('public.priority_push_dispatch()'::regprocedure) ~ 'timeout_milliseconds := 8000' as old_8s,                 -- expect false
--        pg_get_functiondef('public.priority_push_dispatch()'::regprocedure) ~ 'confirmed by write-back' as write_back,                  -- expect true
--        pg_get_functiondef('public.priority_push_dispatch()'::regprocedure) ~ 'pg_input_is_valid\(hr\.content' as ok_body_check;          -- expect true
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'priority_push_outbox' and column_name = 'response_body';   -- 1 row, text
--
-- -- 2. Not callable from the browser roles.
-- select f, has_function_privilege('anon', f, 'execute') as anon,
--           has_function_privilege('authenticated', f, 'execute') as authenticated,
--           has_function_privilege('service_role', f, 'execute') as service_role
--   from unnest(array['public.priority_push_dispatch()', 'public.priority_push_plan()',
--                     'public.priority_push_enqueue()', 'public.priority_push_delivery_category(uuid)',
--                     'public.priority_push_config_enabled_since()']) f;               -- anon/authenticated false
--
-- -- 3. The push is still OFF.
-- select url, enabled, enabled_since, categories, category_since, po_grace_minutes,
--        recheck_minutes, max_wait_days, max_attempts, secret_name
--   from public.priority_push_config;      -- expect url NULL, enabled false, enabled_since NULL, {meat}, {}, 5, 10, 7, 3
--
-- -- 4. The secret exists - by NAME only (never select decrypted_secret here).
-- select name, description, created_at from vault.secrets where name = 'priority_push_secret';   -- 1 row
--
-- -- 5. Triggers in place and enabled ('O').
-- select tgrelid::regclass, tgname, tgenabled from pg_trigger
--  where tgname in ('trg_priority_push_enqueue', 'trg_priority_push_config_enabled_since');     -- 2 rows
--
-- -- 5b. The plan holds a second delivery of a note already in Priority.
-- select pg_get_functiondef('public.priority_push_plan()'::regprocedure) ~ 'hold_same_invoice' as same_invoice_guard;  -- expect true
--
-- -- 6. The plan runs and writes nothing (it is STABLE). Right after the apply it
-- --    returns no rows (the markers of check 10 are not queued); later, while the
-- --    push is off, every due row shows hold_pre_enable, already_in_priority, or
-- --    hold_same_invoice (a second deliveries row for a note already in Priority -
-- --    read 2026-10-01, fork e8f1d706 of 261048511 would show it, against GR26000036).
-- select * from public.priority_push_plan();
--
-- -- 7. Categories resolve for recent closes (pallets first, else the invoice OCR archive).
-- select d.document_number, d.status, public.priority_push_delivery_category(d.id) as category
--   from public.deliveries d
--  where d.created_at > now() - interval '14 days' and d.status <> 'In Progress'
--  order by d.created_at desc;              -- no NULLs expected
--
-- -- 8. The dispatcher keeps running every minute and sends nothing.
-- select status, return_message, start_time from cron.job_run_details
--  where jobid = 8 order by start_time desc limit 5;      -- succeeded, '1 row'
-- select count(*) from public.priority_push_outbox
--  where request_id is not null or status in ('sent', 'delivered', 'unconfirmed');   -- 0 while the push is off
--
-- -- 9. After the next real close (In Progress -> Complete / Has Discrepancy):
-- select id, delivery_id, document_number, delivery_status, category, status, attempts,
--        response_error, not_ready_reason, unmapped_codes, next_check_at, released_at, queued_at
--   from public.priority_push_outbox order by queued_at desc;
-- --    Prod user -> status 'queued', category filled; Test user (e.g. chat 972528331573)
-- --    -> 'skipped' with response_error 'skipped: Test user ...'.
-- select * from public.bot_webhook_log where event = 'priority_push_enqueue' order by created_at desc;  -- expect empty
--
-- -- 10. Every delivery that was closed when the file ran has an inert marker row,
-- --     and none of them is queued. Read 2026-10-01: 42 closed deliveries ->
-- --     35 'skipped: closed before autofire', 6 'skipped: Test user', 1 'already_in_priority'
-- --     (more if deliveries closed between that read and the apply).
-- select o.status,
--        regexp_replace(o.response_error,
--          '^(skipped: Test user|skipped: closed before autofire|not sent: Priority already has GR).*$', '\1') as why,
--        count(*)
--   from public.priority_push_outbox o group by 1, 2 order by 1, 2;
-- select count(*) from public.deliveries d
--  where d.status in ('Complete', 'Has Discrepancy')
--    and not exists (select 1 from public.priority_push_outbox o where o.delivery_id = d.id);   -- expect 0
-- select count(*) from public.priority_push_outbox where status in ('queued', 'waiting');     -- expect 0 right after the apply
--
-- -- 11. Once the push is live: every sent row Priority has NOT confirmed by
-- --     write-back (no priority_goods_receipts row with origin <> 'warehouse_bot').
-- --     'sent' a few minutes old = in flight (still_in_pg_net true = not answered
-- --     yet). 'unconfirmed' = check Priority, then LATER "re-send an unconfirmed
-- --     row" - this includes every 2xx without the {"ok":true} body (e.g. Make's
-- --     "Accepted"; body_says_ok false). 'delivered' here = the scenario said
-- --     {"ok":true} but no write-back row exists (wb_mark_gr_synced failed or
-- --     the row was removed) - check Priority too.
-- select o.id, o.document_number, o.status, o.attempts, o.sent_at, o.status_code,
--        case when pg_input_is_valid(o.response_body, 'jsonb')
--             then (o.response_body::jsonb -> 'ok') = 'true'::jsonb end as body_says_ok,
--        o.response_error, left(o.response_body, 200) as body,
--        exists (select 1 from net.http_request_queue q where q.id = o.request_id) as still_in_pg_net
--   from public.priority_push_outbox o
--  where o.status in ('sent', 'unconfirmed', 'delivered')
--    and not exists (select 1 from public.priority_goods_receipts g
--                     where g.delivery_id = o.delivery_id and g.origin <> 'warehouse_bot')
--    and coalesce(o.response_error, '') not like 'confirmed by hand%'
--  order by o.sent_at;
-- --     (body_says_ok reads the stored 1000-char copy: NULL for a longer body,
-- --      which the dispatcher judged on the full reply.)
--
-- -- 12. Read-back outcomes so far: status x HTTP status x whether the body was the
-- --     scenario's {"ok":true} x the first words of the error. Expect a 2xx row
-- --     that is delivered to have body_says_ok true, unless its error starts
-- --     'confirmed by write-back' / 'confirmed by hand'; every other 2xx row is
-- --     unconfirmed (body_says_ok false / NULL).
-- select o.status, o.status_code,
--        case when pg_input_is_valid(o.response_body, 'jsonb')
--             then (o.response_body::jsonb -> 'ok') = 'true'::jsonb end as body_says_ok,
--        left(o.response_error, 60) as error, count(*)
--   from public.priority_push_outbox o
--  where o.request_id is not null
--  group by 1, 2, 3, 4 order by 1, 2, 3, 4;
