-- 2026-10-18 (ours, web scanner): every carton on an in-progress pallet /
-- loose-box list is saved on the server the moment it is scanned, edited or
-- removed — not only in the phone's localStorage.
--
-- Why: Glatt 261059464 (18/10). A pallet's scanned list lived only in the
-- browser until the pallet was confirmed. Two Chrome tabs on one link each
-- wrote their own list to the same localStorage key; the stale tab wiped 31
-- scanned cartons and nothing on the server held them. Client (18/10): every
-- scan persisted server-side as it happens, restored from the server after a
-- reload, two open instances merged — never overwritten.
--
-- Model: one row per carton per list (token, pallet, carton_key = the row's
-- barcode on the scanner list, unique per list). Every change carries the
-- writing tab's version `ver` (ms clock × 1000 + counter); the server keeps
-- the highest version per carton (last writer wins PER CARTON), and a removal
-- is kept as a tombstone (deleted = true) so a stale copy cannot bring a
-- removed carton back. Two tabs or two phones writing different cartons
-- simply add up. lib/scan-ledger.ts is the client side.
--
-- scan_carton_log keeps every accepted change (audit: what was scanned,
-- edited, removed, by which page load, when).

create table if not exists public.scan_cartons (
  token       text    not null,             -- scan_sessions token
  pallet      integer not null,             -- pallet number; 0 = the loose-box list
  carton_key  text    not null,             -- the carton's barcode on the list
  row_data    jsonb,                        -- the scanner's row (no photo bytes); null when removed
  deleted     boolean not null default false,
  ver         bigint  not null,             -- writer's version; highest wins
  tab         text,                         -- page load that wrote it
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (token, pallet, carton_key)
);
alter table public.scan_cartons enable row level security;
comment on table public.scan_cartons is
  'Web scanner (ours): server copy of every carton on an in-progress pallet/loose list, written as it is scanned (per-carton last-writer-wins, tombstones for removals). 18/10 Glatt 261059464 lost 31 cartons that lived only in one browser tab.';

create table if not exists public.scan_carton_log (
  id          bigserial primary key,
  token       text    not null,
  pallet      integer not null,
  carton_key  text    not null,
  deleted     boolean not null,
  ver         bigint  not null,
  tab         text,
  row_data    jsonb,
  at          timestamptz not null default now()
);
create index if not exists scan_carton_log_token_idx on public.scan_carton_log (token, pallet, at);
alter table public.scan_carton_log enable row level security;
comment on table public.scan_carton_log is
  'Web scanner (ours): every accepted change to scan_cartons (audit trail).';

-- Apply a batch of carton changes; per carton the highest version wins.
-- Returns, per change, the version the server now holds, whether this change
-- was the one applied (false = the server already had a newer one) and
-- whether the server's copy is a removal.
create or replace function public.scan_carton_push(p_token text, p_ops jsonb)
returns table (pallet integer, carton_key text, ver bigint, applied boolean, deleted boolean)
language plpgsql set search_path = public as $$
#variable_conflict use_column
declare
  op jsonb;
  v_pallet integer;
  v_key text;
  v_ver bigint;
  v_del boolean;
  v_row jsonb;
  v_tab text;
  v_cur bigint;
  v_cur_del boolean;
begin
  for op in select * from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    v_pallet := (op->>'pallet')::integer;
    v_key    := op->>'key';
    v_ver    := (op->>'ver')::bigint;
    v_del    := coalesce((op->>'deleted')::boolean, false);
    v_row    := case when v_del then null else op->'row' end;
    v_tab    := left(op->>'tab', 64);
    if v_pallet is null or v_key is null or v_key = '' or v_ver is null then
      continue;
    end if;

    insert into public.scan_cartons as c (token, pallet, carton_key, row_data, deleted, ver, tab)
    values (p_token, v_pallet, v_key, v_row, v_del, v_ver, v_tab)
    on conflict (token, pallet, carton_key) do update
       set row_data = excluded.row_data, deleted = excluded.deleted, ver = excluded.ver,
           tab = excluded.tab, updated_at = now()
     where excluded.ver > c.ver
    returning c.ver, c.deleted into v_cur, v_cur_del;

    if found then
      insert into public.scan_carton_log (token, pallet, carton_key, deleted, ver, tab, row_data)
      values (p_token, v_pallet, v_key, v_del, v_ver, v_tab, v_row);
      pallet := v_pallet; carton_key := v_key; ver := v_cur; applied := true; deleted := v_cur_del;
    else
      select c.ver, c.deleted into v_cur, v_cur_del from public.scan_cartons c
       where c.token = p_token and c.pallet = v_pallet and c.carton_key = v_key;
      pallet := v_pallet; carton_key := v_key; ver := v_cur; applied := false; deleted := v_cur_del;
    end if;
    return next;
  end loop;
end $$;

revoke all on function public.scan_carton_push(text, jsonb) from public, anon, authenticated;
revoke all on table public.scan_cartons from anon, authenticated;
revoke all on table public.scan_carton_log from anon, authenticated;
