-- =============================================================================
-- 2026-10-08  priority_push_05_units_shortage   (M5, OUR objects only)
-- =============================================================================
--
-- STATUS: NOT APPLIED yet. The controller applies it, only after Tonmoy's OK, byte-exact via
--         psycopg in ONE transaction (no BEGIN / COMMIT in this file: scripts/sql/run_sql_test.py
--         runs it inside BEGIN ... ROLLBACK for the tests), and records it in
--         supabase_migrations.schema_migrations as priority_push_05_units_shortage. It is NOT
--         applied through mcp apply_migration. Requires M1-M4 live.
--         Test: tests/2026-10-08-priority-push-05-units-shortage.test.sql
--
-- Spec: telegram-warehouse-bot/docs/superpowers/specs/
--       2026-10-07-priority-push-dependable-design.md, component 4
--       ("Units and shortages: make them visible, store the facts").
--
-- WHAT THIS FILE DOES (columns only; no function, view or trigger changes)
--   delivery_items (ours):
--     pack_count      numeric  outer packages the worker counted for the line
--                              (cartons / crates / sacks). NULL = not said.
--     units_per_pack  numeric  how many the worker said one package holds.
--                              NULL = not said. Together these are the facts
--                              the client's builder could turn into NUMPACK.
--     count_source    text     'counted' (default) | 'invoice_assumed' = the
--                              worker never stated the line; it was booked
--                              at the note's figure so the receipt is not empty.
--     gap_reason      text     per-line reason for a gap outside tolerance
--                              (written by Task 17, shortages, not by this file).
--     gap_note        text     the worker's free text for "other reason".
--     rest_expected   text     'will_come' | 'wont_come' for a short line.
--   deliveries (ours):
--     invoice_date    date     the date printed on the supplier note.
--
-- WHY NEW COLUMNS AND NOT EXISTING ONES (checked 2026-10-07):
--   * delivery_items.discrepancy_note is NOT reused for gap_note: meat's
--     finalize_receipt writes machine evidence into it ('boxes 3/5', damaged
--     sticker), and non-meat writes a localized label. Free text from the
--     worker would mix with both.
--   * delivery_items.received_box_count is NOT reused for pack_count: it is the
--     meat scanner's per-carton counter (incremented per scan, defaults to 0 so
--     "unknown" and "zero" look alike) and drives meat's box Short/Over.
--     pack_count is NULL unless the worker gave packages x per-package.
--   * deliveries had no date column; the note's date lived only in
--     invoice_ocr_results.raw_ocr->>'invoice_date'.
--
-- BACKFILL (deliveries.invoice_date only):
--   From the newest invoice_ocr_results row linked to the delivery, when
--   raw_ocr->>'invoice_date' is YYYY-MM-DD, is a real date, and lies within
--   [created_at::date - 60 days, created_at::date + 1 day]. Anything else is
--   an OCR misread (2026-09-23: three notes came back as 2023-09-26;
--   2026-10-04: one as 2024-10-26) and stays NULL. The bot applies the same
--   rule at create time (airtable_service._plausible_invoice_date).
--   2026-10-07: 71 deliveries have an OCR row (2026-10-07 evening), 30 carry an ISO date, 26 pass.
--
-- SAFE TO APPLY AT ANY TIME, BEFORE THE BOT (Task 16) IS DEPLOYED:
--   * No trigger fires: trg_priority_push_enqueue is AFTER UPDATE OF status and
--     trg_delivery_supplier_canonicalize is OF supplier_hebrew, supplier_vat;
--     the backfill sets invoice_date only.
--   * No client object reads these columns (no wb_* function references
--     pack_count, units_per_pack, count_source, gap_*, rest_expected or
--     deliveries.invoice_date; v_delivery_priority_gr and wb_activity do not
--     select them).
--   * PG17: ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only.
--   * delivery_gaps_v reads these columns, so it lives in THIS file, not in M4:
--     Task 14b appends it at the end, between its own markers. Sections 1-3
--     below create no view, function or trigger (nothing to REVOKE).
-- =============================================================================

-- Fail fast (5 s) instead of queueing behind another session's lock. Transaction-local, set
-- before the first statement and outside every block, like M1 to M4.
set local lock_timeout = '5s';

-- 1. delivery_items: the facts per line ----------------------------------------
alter table public.delivery_items
  add column if not exists pack_count numeric
    constraint delivery_items_pack_count_check check (pack_count is null or pack_count >= 0),
  add column if not exists units_per_pack numeric
    constraint delivery_items_units_per_pack_check check (units_per_pack is null or units_per_pack > 0),
  add column if not exists count_source text not null default 'counted'
    constraint delivery_items_count_source_check check (count_source in ('counted', 'invoice_assumed')),
  add column if not exists gap_reason text,
  add column if not exists gap_note text,
  add column if not exists rest_expected text
    constraint delivery_items_rest_expected_check check (rest_expected in ('will_come', 'wont_come'));

comment on column public.delivery_items.pack_count is
  '2026-10-08 (M5): outer packages (cartons/crates/sacks) the worker counted for this line; NULL = not said. Pairs with units_per_pack. Not the meat scanner counter (that is received_box_count).';
comment on column public.delivery_items.units_per_pack is
  '2026-10-08 (M5): how many the worker said one package holds (e.g. 10 loaves per crate). NULL = not said. No conversion is applied on our side.';
comment on column public.delivery_items.count_source is
  '2026-10-08 (M5): counted = received figure came from the worker, the scanner or the scale; invoice_assumed = nobody stated the line, it was booked at the note''s figure.';
comment on column public.delivery_items.gap_reason is
  '2026-10-08 (M5): per-line reason for a gap outside tolerance (only lines outside it get one).';
comment on column public.delivery_items.gap_note is
  '2026-10-08 (M5): the worker''s free text when the reason is "other".';
comment on column public.delivery_items.rest_expected is
  '2026-10-08 (M5): for a short line - will_come (יגיע בהמשך, "will come later") or wont_come (לא יגיע, "won''t come"). Only wont_come may ever map to the client''s סופקה בחוסר ("supplied short").';

-- 2. deliveries: the note's own date ------------------------------------------
alter table public.deliveries
  add column if not exists invoice_date date;

comment on column public.deliveries.invoice_date is
  '2026-10-08 (M5): the date printed on the supplier note (OCR), when plausible (within 60 days before the receipt .. 1 day after). NULL = not read or a misread. CURDATE today is still created_at (client builder).';

-- 3. backfill deliveries.invoice_date -----------------------------------------
do $m$
declare
  r   record;
  d   date;
  n   int := 0;
begin
  for r in
    select dl.id, dl.created_at, o.s
      from public.deliveries dl
      join lateral (
             select x.raw_ocr ->> 'invoice_date' as s
               from public.invoice_ocr_results x
              where x.delivery_id = dl.id
              order by x.created_at desc
              limit 1
           ) o on true
     where dl.invoice_date is null
       and o.s ~ '^\d{4}-\d{2}-\d{2}$'
  loop
    begin
      d := r.s::date;                       -- '2026-02-30' raises -> skipped
    exception when others then
      continue;
    end;
    if d between r.created_at::date - 60 and r.created_at::date + 1 then
      update public.deliveries set invoice_date = d where id = r.id;
      n := n + 1;
    end if;
  end loop;
  raise notice 'M5: deliveries.invoice_date backfilled on % row(s)', n;
end
$m$;
