-- Applied live 2026-09-22 (Supabase migration `carton_labels_identical_origin`).
-- "All boxes identical" on pallet-verify mints one carton_labels row per
-- carton and books them as stock; these columns say where a batch came from.
alter table public.carton_labels
  add column if not exists origin text not null default 'new_carton',
  add column if not exists source_barcode text,
  add column if not exists pallet_number integer;
create index if not exists carton_labels_source_barcode_idx on public.carton_labels (source_barcode);
comment on column public.carton_labels.origin is 'new_carton = New carton chip (label only); identical = "all boxes identical" action on pallet-verify (booked as stock)';
comment on column public.carton_labels.source_barcode is 'supplier barcode read off the sample carton (the one shared by every box)';
comment on column public.carton_labels.pallet_number is 'pallet the batch was minted on; 0 = loose pile';
