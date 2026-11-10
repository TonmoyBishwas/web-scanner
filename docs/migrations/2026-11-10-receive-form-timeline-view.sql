-- 2026-11-10: one readable timeline per receive form (Mevaser: "we must have a
-- record of everything he does in the new UI, to monitor bugs").
--
-- Read-only view over scanner_events (page 'receive', token = form id) joined
-- to receipt_forms. Israel time, the form version (v3 / classic), and the
-- common fields lifted out of `data`. security_invoker: it reads with the
-- caller's rights, so it exposes nothing the base tables do not.
--
-- Use:  select * from receive_form_timeline where invoice_number = '2607598' order by ts, seq;
-- Rollback: drop view if exists public.receive_form_timeline;
create or replace view public.receive_form_timeline
with (security_invoker = true) as
select
  f.id                                   as form_id,
  f.header->>'invoice_number'            as invoice_number,
  f.header->>'supplier'                  as supplier,
  f.chat_id,
  f.status                               as form_status,
  case
    when exists (select 1 from scanner_events o
                 where o.page = 'receive' and o.token = f.id::text
                   and (o.data ? 'v3' or o.data->>'v' = '3' or o.data->>'form' = 'v3'))
      then 'v3'
    else 'classic'
  end                                    as form_version,
  e.ts,
  to_char(e.ts at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS') as ts_il,
  e.load_id,
  e.seq,
  e.kind,
  e.event,
  e.data->>'step'                        as step,
  nullif(e.data->>'line', '')            as line,
  e.data->>'line_code'                   as line_code,
  e.data->>'field'                       as field,
  e.data->>'old'                         as old_value,
  e.data->>'new'                         as new_value,
  e.data->'errs'                         as errs,
  coalesce(e.data->>'message', e.data->>'text', e.data->>'notice', e.data->>'outcome') as note,
  e.data
from public.receipt_forms f
join public.scanner_events e on e.page = 'receive' and e.token = f.id::text;
