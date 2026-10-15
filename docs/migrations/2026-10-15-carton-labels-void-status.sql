-- 2026-10-15 — carton_labels: a 'void' status (client request (c)).
--
-- The scanner's Delete sheet can now cancel PRINTED labels whose carton was
-- never booked (e.g. IN26013461 pallet 2: 62 falafel labels printed for the
-- wrong pallet and left as orphans). A printed sticker exists on paper, so
-- the row is kept as history with status 'void' instead of being deleted;
-- the worker is told to peel the sticker off.
--
-- Ours (scanner). Not read by the bot or by the client's wb_* functions
-- (they read box_inventory / delivery_items, never carton_labels).
--
-- Until this is applied the scanner falls back to DELETING such a label
-- (lib/carton-labels.ts clearSessionLabels catches the 23514
-- check_violation) — still never a booked one.
--
-- Idempotent: drops and re-adds the CHECK with the extra value.

begin;

alter table public.carton_labels
  drop constraint if exists carton_labels_status_check;

alter table public.carton_labels
  add constraint carton_labels_status_check
  check (status = any (array['created'::text, 'printed'::text, 'void'::text]));

comment on column public.carton_labels.status is
  'created = saved, not printed yet; printed = sent to the printer (print_count says how often); '
  'void = printed but cancelled before its carton was booked (sticker to be peeled off; kept as history).';

commit;
