-- 2026-10-05 — priority_push_send_unready (applied via MCP migration of the same name)
--
-- The client (Mevaser) asked: "just send it to Priority, I will handle it in
-- Priority myself". Until now priority_push_plan() held a receipt in
-- 'waiting' whenever his wb_gr_priority_body() said not ready
-- (supplier_unmatched / items_unmapped) or a line was mapped only by a guess
-- (METHOD <> 'vat_sku'), so his Make webhook was never called for it.
--
-- New switch priority_push_config.send_unready (default false). When true,
-- an unready receipt is SENT anyway; the reason + codes stay on the outbox
-- row (not_ready_reason starts with 'sent although not ready'). Builder errors
-- (exceptions) are still held as 'error'.
--
-- Turned on right after: update priority_push_config set send_unready = true where id = 1;
-- Turn off:             update priority_push_config set send_unready = false where id = 1;

alter table public.priority_push_config
  add column if not exists send_unready boolean not null default false;
comment on column public.priority_push_config.send_unready is
  '2026-10-05: client asked to send every closed receipt to his Make webhook even when wb_gr_priority_body says not ready (unknown supplier / unmapped items); he fixes the draft in Priority himself.';

do $m$
declare
  v_def text := pg_get_functiondef('public.priority_push_plan'::regproc);
  v_old text := $o$    if (v_failed is not null or not v_ready)
       and greatest(rw.queued_at, rw.released_at) < now() - make_interval(days => cfg.max_wait_days) then$o$;
  v_new text := $n$    if v_failed is null and not v_ready and cfg.send_unready then
      -- 2026-10-05: the client asked for every receipt to reach his Make
      -- scenario; he fixes an unknown supplier / unmapped item in Priority.
      decision := 'send';
      reason   := 'sent although not ready (priority_push_config.send_unready): '
                  || coalesce(v_reason, '?')
                  || coalesce(' [' || array_to_string(v_codes, ', ') || ']', '');
      codes    := v_codes;
    elsif (v_failed is not null or not v_ready)
       and greatest(rw.queued_at, rw.released_at) < now() - make_interval(days => cfg.max_wait_days) then$n$;
begin
  if position(v_old in v_def) = 0 then
    raise exception 'priority_push_plan: anchor not found';
  end if;
  execute replace(v_def, v_old, v_new);
end
$m$;

-- keep the reason/codes on the row when an unready receipt is sent
do $m$
declare
  v_def text := pg_get_functiondef('public.priority_push_dispatch'::regproc);
  v_old text := $o$not_ready_reason = null, unmapped_codes = null, next_check_at = null,$o$;
  v_new text := $n$not_ready_reason = case when p.reason like 'sent although not ready%' then p.reason end,
                 unmapped_codes = p.codes, next_check_at = null,$n$;
begin
  if position(v_old in v_def) = 0 then
    raise exception 'priority_push_dispatch: anchor not found';
  end if;
  execute replace(v_def, v_old, v_new);
end
$m$;
