-- =============================================================================
-- 2026-10-04  priority_push_supplier_mapping_only  (OUR Priority-push planner)
-- =============================================================================
--
-- WHY
--   The client's readiness gate (wb_gr_priority_body ->> 'ready') counts a line
--   as resolved by ANY of wb_resolve_partname's three methods:
--     vat_sku  sku_crosswalk row for THIS supplier's VAT + its code   (reliable)
--     sku      the code appears in sku_crosswalk under exactly one internal
--              part — for SOME OTHER supplier                         (a guess)
--     direct   the supplier's code happens to equal a Priority PARTNAME (a guess)
--   Supplier codes are the supplier's own small numbers, so the two guesses
--   collide with unrelated goods. Read live 2026-10-04:
--     * GR26000039 (the first live push, M.B. Glatt 251068506) booked
--         2283 "חזה עוף טחון"        -> Priority 2283 "ירכיים עוף גדול מוסדי קפוא" (direct)
--         550  "קציצות ברוטב אדום"   -> Priority 550  "סלק אדום ק"ג"              (direct)
--         101  "בשר טחון - מוסדי"     -> Priority 715  "שישיית מי עדן 1.5 ליטר"    (sku)
--     * Agami bakery 241954682 line 1003 "לחם אחיד פרוס" resolves (sku, another
--       supplier's 1003) to Priority 5026 "שעות רגילות בדץ" (kashrut hours).
--
-- WHAT THIS DOES (OUR object only — wb_* are the client's and are not touched)
--   priority_push_plan(): a delivery is sent only when EVERY line resolves by
--   vat_sku, i.e. through a sku_crosswalk row for that supplier. Any line that
--   resolves by a guess, or not at all, makes the decision 'not_ready' with
--   reason 'items_unmapped' (the reason the scanner's priority-status already
--   shows as "items not mapped") and its code in `codes` -> outbox
--   unmapped_codes. The client's own not_ready_reason (e.g. supplier_unmatched)
--   is kept when the client already said not ready; the guessed codes are
--   added to its code list so one read shows everything to map.
--   Line methods come from wb_build_priority_gr_full -> TRANSORDER_P[].METHOD,
--   the same builder wb_gr_priority_body uses, so the VAT is the one the push
--   would use (priority_suppliers matched by name).
--
-- EFFECT ON LIVE ROWS (2026-10-04): none sent were pending; outbox 44 (Baladi)
--   already waits on 90500010; its other two lines are vat_sku.
-- =============================================================================

create or replace function public.priority_push_plan()
returns table (outbox_id bigint, delivery_id uuid, decision text, reason text, codes text[])
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
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
  v_guessed   text[];
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

    if rw.delivery_status_now is null
       or rw.delivery_status_now not in ('Complete', 'Has Discrepancy') then
      decision := 'hold_not_closed';
      reason   := 'delivery status is now ' || coalesce(rw.delivery_status_now, 'missing')
                  || '; sent only while Complete / Has Discrepancy';
      return next;
      continue;
    end if;

    if v_doc is not null and rw.released_at is null then
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

    v_cat := coalesce(rw.category, public.priority_push_delivery_category(rw.delivery_id));
    if v_cat is null or not (v_cat = any (cfg.categories)) then
      decision := 'hold_category';
      reason   := 'category ' || coalesce(v_cat, 'unknown') || ' is not in priority_push_config.categories '
                  || cfg.categories::text;
      return next;
      continue;
    end if;

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

    if not exists (select 1 from public.delivery_po_links l where l.delivery_id = rw.delivery_id)
       and rw.queued_at > now() - make_interval(mins => cfg.po_grace_minutes) then
      decision := 'wait_po';
      reason   := 'no purchase-order answer yet (no delivery_po_links row); waiting until '
                  || to_char((rw.queued_at + make_interval(mins => cfg.po_grace_minutes)) at time zone 'Asia/Jerusalem',
                             'HH24:MI') || ' (Israel)';
      return next;
      continue;
    end if;

    if v_evaluated >= c_batch then
      continue;
    end if;
    v_evaluated := v_evaluated + 1;

    v_failed  := null;
    v_ready   := false;
    v_reason  := null;
    v_codes   := null;
    v_guessed := null;
    begin
      v_body  := public.wb_gr_priority_body(rw.delivery_id);
      v_ready := coalesce((v_body ->> 'ready')::boolean, false);
      if not v_ready then
        v_reason := coalesce(v_body ->> 'not_ready_reason', 'not ready (no not_ready_reason given)');
        if jsonb_typeof(v_body -> 'unmapped_codes') = 'array' then
          v_codes := array(select jsonb_array_elements_text(v_body -> 'unmapped_codes'));
        end if;
      end if;

      -- 2026-10-04: only a mapping made for THIS supplier is trusted. A line
      -- the client's resolver matched by a guess (another supplier's code, or
      -- a code that merely equals a PARTNAME) is treated as unmapped.
      select array_agg(distinct coalesce(l ->> 'SRC_CODE', '?'))
        into v_guessed
        from jsonb_array_elements(
               coalesce(public.wb_build_priority_gr_full(rw.delivery_id) -> 'TRANSORDER_P', '[]'::jsonb)) l
       where (l ->> 'METHOD') is distinct from 'vat_sku';
      if coalesce(cardinality(v_guessed), 0) > 0 then
        v_codes := array(select distinct c from unnest(coalesce(v_codes, '{}'::text[]) || v_guessed) c order by c);
        if v_ready then
          v_ready  := false;
          v_reason := 'items_unmapped';
        end if;
      end if;
    exception when others then
      v_failed := left(sqlerrm, 500);
    end;

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
      reason   := 'ready (category ' || v_cat || ', every line mapped for this supplier)';
    end if;
    return next;
  end loop;
end
$function$;

comment on function public.priority_push_plan() is
  'Side-effect-free preview of priority_push_dispatch(): one decision per due outbox row (already_in_priority, hold_local_draft, hold_not_closed, hold_same_invoice, hold_pre_enable, hold_category, hold_pre_category, wait_po, expired, error, not_ready, send). Calls the client''s wb_gr_priority_body / wb_build_priority_gr_full read-only. Since 2026-10-04 a line counts as mapped only when wb_resolve_partname resolved it by vat_sku (a sku_crosswalk row for that supplier).';
