-- 2026-10-22 (ours, web scanner): silent scan KPIs per meat receipt.
-- NOT APPLIED. Draft for Tonmoy / Mevaser review (scan_success_kpi_2026-10-21_v2).
--
-- Read-only views over OUR tables only (deliveries, delivery_items, pallets,
-- pallet_items, box_inventory, carton_labels, scan_cartons, scanner_events,
-- scan_sessions, users). Touches none of the client's wb_* / priority_* objects.
-- Nothing is shown to the worker.
--
-- Why our own definitions differ from the client's v2 numbers (detail in the
-- plan, scratchpad oct21c/plan_kpi.md):
--  1. Denominator = cartons RECEIVED (pallets.box_count), not invoice cartons.
--     A short delivery (261057279: 60 invoiced, 30 arrived) or an unfinished
--     receipt (IN264185523: 13 of 86) is a gap to the invoice, not a scanner
--     failure. The gap is reported in its own column.
--  2. Only cartons whose label carries per-carton data count toward
--     "scanner success". A 13-digit EAN / short item code that repeats on
--     every carton of the item (Baladi falafel/kebab/schnitzel, Asher falafel)
--     is identical by construction: copying it is the designed path. Those
--     cartons are reported separately (item_only_*).
--  3. Never count box_inventory rows as the received quantity (uniform pallets
--     keep 2 samples). Rows are classified; the received total comes from
--     pallets.box_count.
--  4. Pace comes from the server carton ledger scan_cartons (one row per
--     carton, row_data.scanned_at; since 19/10), not from scanner_events,
--     whose trace was lossy before 15/10 (logging gap G1) and is purged after
--     30 days. Cartons minted in one action (copies / New carton xN) share a
--     timestamp and are collapsed to one action.
--  5. scanner_events is purged after 30 days (pg_cron purge-scanner-events):
--     the weekly trend needs the daily snapshot table at the end of this file.

-- ── token → receipt map (scan_sessions keeps receipt_id; carton_labels keeps
--    session_token + document_number for older sessions) ─────────────────────
create or replace view public.scan_kpi_token_receipt with (security_invoker = true) as
select distinct on (token) token, receipt_id, document_number
from (
  select s.token, nullif(s.data->>'receipt_id','')::uuid receipt_id, s.data->>'document_number' document_number, 1 pri
    from public.scan_sessions s
  union all
  select cl.session_token, null::uuid, cl.document_number, 2
    from public.carton_labels cl where cl.session_token is not null
) x
order by token, pri;
comment on view public.scan_kpi_token_receipt is
  'Ours (scan KPI): scanner session token -> receipt / document number.';

-- ── 1. Scanner success per meat receipt ──────────────────────────────────────
create or replace view public.scan_kpi_receipt with (security_invoker = true) as
with lbl as (
  select distinct on (barcode) barcode, origin, source_barcode
    from public.carton_labels order by barcode, created_at desc
),
meat as (
  select d.id receipt_id, d.document_number, d.supplier_hebrew, d.created_at,
         u.nickname receipt_by, u.role receipt_by_role
    from public.deliveries d
    left join public.users u on u.chat_id = d.received_by_chat_id
   where exists (select 1 from public.pallets p
                  where p.receipt_id = d.id and coalesce(p.category,'meat') = 'meat')
),
box as (
  select p.receipt_id, pi.item_code,
         case when l.origin = 'identical' then 'copied'
              when l.origin in ('new_carton','receiving') then 'by_hand'
              when coalesce(b.barcode,'') = '' then 'by_hand'
              else 'scanned' end how,
         regexp_replace(case when l.origin = 'identical' then l.source_barcode
                             when l.origin is null then b.barcode end, '\D', '', 'g') ref
    from public.box_inventory b
    join public.pallets p on p.id = b.pallet_id
    left join public.pallet_items pi on pi.id = b.pallet_item_id
    left join lbl l on l.barcode = b.barcode
),
box1 as (
  select box.*,
         case when ref is null or ref = '' then null
              when length(ref) <= 14
                   and count(*) over (partition by receipt_id, ref) > 1 then 'item_only'
              else 'per_carton' end own_class
    from box
),
item_class as (
  select receipt_id, item_code,
         case when bool_or(own_class = 'per_carton') then 'per_carton'
              when bool_or(own_class = 'item_only') then 'item_only' end cls
    from box1 group by 1, 2
),
box2 as (
  select b.*, coalesce(b.own_class, ic.cls, 'unknown') label_class
    from box1 b
    left join item_class ic on ic.receipt_id = b.receipt_id
                           and ic.item_code is not distinct from b.item_code
),
agg as (
  select receipt_id,
    count(*) booked_rows,
    count(*) filter (where label_class = 'per_carton')                       pc_rows,
    count(*) filter (where label_class = 'per_carton' and how = 'scanned')   pc_scanned,
    count(*) filter (where label_class = 'per_carton' and how = 'copied')    pc_copied,
    count(*) filter (where label_class = 'per_carton' and how = 'by_hand')   pc_by_hand,
    count(*) filter (where label_class = 'per_carton' and how = 'copied' and length(ref) >= 24) pc_copied_long_label, -- copy of a label that carries weight/serial: likely the old label winning the frame (check)
    count(*) filter (where label_class = 'item_only')                        io_rows,
    count(*) filter (where label_class = 'item_only' and how = 'scanned')    io_scanned,
    count(*) filter (where label_class = 'item_only' and how = 'copied')     io_copied,
    count(*) filter (where label_class = 'item_only' and how = 'by_hand')    io_by_hand,
    count(*) filter (where label_class = 'unknown')                          unknown_rows,
    count(*) filter (where how = 'scanned')                                  all_scanned,
    count(*) filter (where how = 'copied')                                   all_copied,
    count(*) filter (where how = 'by_hand')                                  all_by_hand
  from box2 group by 1
),
recv as (select receipt_id, sum(box_count) received_cartons from public.pallets group by 1),
inv  as (select receipt_id, sum(invoice_box_count) invoice_cartons from public.delivery_items group by 1),
who  as (select tr.receipt_id, string_agg(distinct e.nickname, ', ') scanned_by
           from public.scanner_events e
           join public.scan_kpi_token_receipt tr on tr.token = e.token
          where e.kind = 'ui' and e.page = 'pallet-verify' and tr.receipt_id is not null
          group by 1)
select m.receipt_id, m.document_number,
       m.supplier_hebrew supplier,
       (m.created_at at time zone 'Asia/Jerusalem')::date receipt_day,
       m.receipt_by, m.receipt_by_role, w.scanned_by,
       inv.invoice_cartons, recv.received_cartons, a.booked_rows,
       coalesce(inv.invoice_cartons,0) - coalesce(recv.received_cartons,0) gap_to_invoice,
       greatest(coalesce(recv.received_cartons,0) - coalesce(a.booked_rows,0), 0) declared_not_listed,
       a.pc_rows, a.pc_scanned, a.pc_copied, a.pc_by_hand,
       -- cartons declared on a pallet but never listed (uniform shortcut samples)
       -- count as not scanned: every carton gets its own scan
       round(100.0 * a.pc_scanned / nullif(a.pc_rows + greatest(coalesce(recv.received_cartons,0) - coalesce(a.booked_rows,0), 0), 0), 1) scan_success_pct,
       a.pc_copied_long_label,
       a.io_rows, a.io_scanned, a.io_copied, a.io_by_hand, a.unknown_rows,
       a.all_scanned, a.all_copied, a.all_by_hand,
       round(100.0 * a.all_scanned / nullif(inv.invoice_cartons,0), 1) client_v2_pct
  from meat m
  left join agg  a    on a.receipt_id = m.receipt_id
  left join recv      on recv.receipt_id = m.receipt_id
  left join inv       on inv.receipt_id = m.receipt_id
  left join who  w    on w.receipt_id = m.receipt_id;
comment on view public.scan_kpi_receipt is
  'Ours (scan KPI 1): per meat receipt, cartons scanned from a per-carton supplier label / received cartons of per-carton-label items (scan_success_pct). Item-only labels (one EAN/short code on every carton) and the invoice gap are separate columns; client_v2_pct = the client''s v2 formula for comparison.';

-- ── 2. Pace and stalls per receipt (server carton ledger, since 19/10) ──────
create or replace view public.scan_kpi_pace with (security_invoker = true) as
with c as (
  select sc.token, tr.receipt_id, tr.document_number,
         (sc.row_data->>'scanned_at')::timestamptz t,
         (sc.row_data ? 'minted' or sc.row_data ? 'captured_via') not_camera
    from public.scan_cartons sc
    join public.scan_kpi_token_receipt tr on tr.token = sc.token
   where not sc.deleted and sc.row_data ? 'scanned_at'
),
act as (            -- one action per timestamp (a copy xN / New carton xN is one action)
  select token, receipt_id, document_number, t, bool_and(not_camera) minted, count(*) n
    from c group by 1, 2, 3, 4
),
g as (
  select act.*, lag(t) over (partition by token order by t) t0 from act
),
s as (
  select g.*, extract(epoch from t - t0) gap,
         (select jsonb_object_agg(ev, n) from (
            select e.event ev, count(*) n from public.scanner_events e
             where e.token = g.token and e.ts > g.t0 and e.ts < g.t
               and e.kind in ('ui','lifecycle')
               and e.event in ('load','delete_box','delete_all_open','select_mode_open',
                               'pallet_completed','count_open','count_submit',
                               'different_carton_open','different_carton_quick','identical_open',
                               'carton_creator_open','edit_open','manual_capture','scan_detected')
             group by 1) z) evs
    from g
),
k as (
  select s.*, case
      when gap is null or gap <= 30 then null
      when evs ? 'load' then 'reload'
      when evs ?| array['delete_box','delete_all_open','select_mode_open'] then 'delete'
      when evs ?| array['pallet_completed','count_open','count_submit'] then 'pallet_close_or_count'
      when evs ?| array['different_carton_open','different_carton_quick','identical_open',
                        'carton_creator_open','edit_open','manual_capture'] then 'dialog_or_manual'
      when coalesce((evs->>'scan_detected')::int, 0) >= 3 then 'reread_loop'
      else 'no_scanner_activity' end cause
    from s
)
select receipt_id, document_number,
       sum(n) cartons,
       count(*) filter (where not minted) camera_scans,
       round(extract(epoch from max(t) - min(t)) / 60.0, 1) minutes,
       round(sum(n) / nullif(extract(epoch from max(t) - min(t)) / 60.0, 0), 1) cartons_per_min,
       round((percentile_cont(0.5) within group (order by gap)
              filter (where not minted and gap <= 30))::numeric, 1) flow_sec_per_carton,
       count(cause) stalls,
       round((sum(gap) filter (where cause is not null) / 60.0)::numeric, 1) stall_minutes,
       round((max(gap) / 60.0)::numeric, 1) longest_stall_min,
       jsonb_strip_nulls(jsonb_build_object(
         'reload',                round((sum(gap) filter (where cause = 'reload') / 60.0)::numeric, 1),
         'delete',                round((sum(gap) filter (where cause = 'delete') / 60.0)::numeric, 1),
         'pallet_close_or_count', round((sum(gap) filter (where cause = 'pallet_close_or_count') / 60.0)::numeric, 1),
         'dialog_or_manual',      round((sum(gap) filter (where cause = 'dialog_or_manual') / 60.0)::numeric, 1),
         'reread_loop',           round((sum(gap) filter (where cause = 'reread_loop') / 60.0)::numeric, 1),
         'no_scanner_activity',   round((sum(gap) filter (where cause = 'no_scanner_activity') / 60.0)::numeric, 1)
       )) stall_minutes_by_cause
  from k
 group by receipt_id, document_number;
comment on view public.scan_kpi_pace is
  'Ours (scan KPI 3): pace per receipt from scan_cartons (19/10 on). Stalls = gaps > 30 s between carton actions, cause from scanner_events inside the gap (first match: reload > delete > pallet close/count > dialog/manual > re-read loop > none).';

-- ── 3. Interruptions per receipt (scanner_events, reliable from 15/10) ──────
create or replace view public.scan_kpi_interruptions with (security_invoker = true) as
with e as (
  select tr.receipt_id, tr.document_number, e.token, e.ts, e.event, e.data,
         e.data->>'barcode' bc
    from public.scanner_events e
    join public.scan_kpi_token_receipt tr on tr.token = e.token
   where e.kind in ('ui','lifecycle') and e.page = 'pallet-verify'
),
d as (
  select e.*, lag(ts) over (partition by token, event, bc order by ts) prev from e
),
r as (
  select receipt_id, document_number,
    -- shown by the scanner without the worker asking
    count(*) filter (where event = 'scan_detected' and (data->>'duplicate')::boolean
                       and (prev is null or ts - prev > interval '10 seconds'))   already_counted_notices,
    count(*) filter (where event = 'scan_detected' and not coalesce((data->>'ok')::boolean, true)
                       and (prev is null or ts - prev > interval '60 seconds'))   refused_read_notices,
    count(*) filter (where event = 'scan_short_item_code' and (data->>'opened')::boolean) auto_opened_forms,
    count(*) filter (where event = 'weight_suspect')                              weight_flags,
    greatest(count(*) filter (where event = 'load') - count(distinct token), 0)   reloads,
    -- opened by the worker (manual work, not a pop-up)
    count(*) filter (where event in ('different_carton_open','identical_open'))  another_carton_dialogs,
    count(*) filter (where event = 'different_carton_quick')                      another_carton_one_tap,
    count(*) filter (where event = 'carton_creator_open' and data is null)        new_carton_from_toolbar,
    count(*) filter (where event in ('delete_all_open','select_mode_open'))       delete_dialogs
  from d group by 1, 2
)
select r.*, recv.received_cartons,
       round(100.0 * (already_counted_notices + refused_read_notices + auto_opened_forms + reloads)
             / nullif(recv.received_cartons, 0), 1) system_interruptions_per_100,
       round(100.0 * (another_carton_dialogs + another_carton_one_tap + new_carton_from_toolbar + delete_dialogs)
             / nullif(recv.received_cartons, 0), 1) manual_actions_per_100
  from r
  left join (select receipt_id, sum(box_count) received_cartons from public.pallets group by 1) recv
         on recv.receipt_id = r.receipt_id;
comment on view public.scan_kpi_interruptions is
  'Ours (scan KPI 2): per receipt, interruptions the scanner raised by itself (already-counted notices deduped per barcode per 10 s, refused-read notices per 60 s, auto-opened forms, reloads) vs dialogs the worker opened. Reliable from 15/10 (trace gap G1 before).';

-- ── 4. Daily snapshot (scanner_events is purged after 30 days) ──────────────
create table if not exists public.scan_kpi_daily (
  receipt_id     uuid primary key,
  document_number text,
  receipt_day    date,
  supplier       text,
  success        jsonb,   -- scan_kpi_receipt row
  pace           jsonb,   -- scan_kpi_pace row (null before 19/10)
  interruptions  jsonb,   -- scan_kpi_interruptions row
  snapshot_at    timestamptz not null default now()
);
alter table public.scan_kpi_daily enable row level security;
comment on table public.scan_kpi_daily is
  'Ours (scan KPI): one frozen row per meat receipt, refreshed nightly while the receipt is <= 7 days old, so the weekly trend survives the 30-day scanner_events purge.';

create or replace function public.scan_kpi_snapshot(p_days integer default 7)
returns integer language sql security definer set search_path = public as $$
  with src as (
    select r.receipt_id, r.document_number, r.receipt_day, r.supplier,
           to_jsonb(r) success, to_jsonb(p) pace, to_jsonb(i) interruptions
      from public.scan_kpi_receipt r
      left join public.scan_kpi_pace p on p.receipt_id = r.receipt_id
      left join public.scan_kpi_interruptions i on i.receipt_id = r.receipt_id
     where r.receipt_day >= (now() at time zone 'Asia/Jerusalem')::date - p_days
  ), up as (
    insert into public.scan_kpi_daily as t (receipt_id, document_number, receipt_day, supplier, success, pace, interruptions)
    select * from src
    on conflict (receipt_id) do update
       set success = excluded.success, pace = excluded.pace,
           interruptions = excluded.interruptions, snapshot_at = now()
    returning 1
  ) select count(*)::int from up;
$$;
revoke all on function public.scan_kpi_snapshot(integer) from public, anon, authenticated;

-- Schedule only after review (not part of this draft's apply):
-- select cron.schedule('scan-kpi-snapshot', '40 23 * * *', $$select public.scan_kpi_snapshot(7)$$);
