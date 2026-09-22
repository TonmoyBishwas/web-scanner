-- Applied live 2026-09-22 (Supabase migration `scanner_events_trace`).
-- Per-user scanner event trail for debugging: every scan / OCR / edit /
-- undo / confirm / reload / API call a traced worker makes on the web
-- scanner, in order. Switched on per user (users.trace_enabled, permanent)
-- or per day (users.trace_until). Read it through the `scanner_trace` view.

alter table public.users
  add column if not exists trace_enabled boolean not null default false,
  add column if not exists trace_until timestamptz;
comment on column public.users.trace_enabled is 'true = every web-scanner session of this user is recorded into scanner_events (David is permanently on)';
comment on column public.users.trace_until is 'record this user''s scanner sessions until this moment (a one-day debugging window); NULL = only trace_enabled decides';

create table if not exists public.scanner_events (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null,               -- client clock, when the event happened
  received_at timestamptz not null default now(), -- server clock, when the batch landed
  chat_id     bigint,
  nickname    text,
  page        text not null,                      -- pallet-verify | scan | issue
  token       text not null,                      -- scan_sessions token
  load_id     text not null,                      -- one per page load: a new value = the page was (re)loaded
  seq         integer not null,                   -- order within a load_id
  kind        text not null,                      -- lifecycle | ui | phase | fetch | console | error
  event       text not null,
  data        jsonb
);
create index if not exists scanner_events_chat_ts_idx on public.scanner_events (chat_id, ts);
create index if not exists scanner_events_token_idx on public.scanner_events (token, ts);
create index if not exists scanner_events_received_idx on public.scanner_events (received_at);
alter table public.scanner_events enable row level security;
comment on table public.scanner_events is 'Web-scanner debugging trail (ours). Only written for users with trace_enabled or a live trace_until. Purged after 30 days by pg_cron.';

create or replace view public.scanner_trace as
  select
    (ts at time zone 'Asia/Jerusalem') as local_time,
    nickname, chat_id, page, token, load_id, seq, kind, event, data, ts, id
  from public.scanner_events
  order by ts, id;
comment on view public.scanner_trace is 'Readable timeline over scanner_events (Israel local time). Filter by nickname + local_time.';

select cron.schedule(
  'purge-scanner-events',
  '17 3 * * *',
  $$ delete from public.scanner_events where received_at < now() - interval '30 days' $$
);

update public.users set trace_enabled = true where chat_id = 972544965384; -- David Hirsch
