-- 2026-10-04: the client's wb_build_priority_gr_full finds the Priority
-- supplier ONLY by an exact (punctuation-stripped) match of
-- deliveries.supplier_hebrew against priority_suppliers.supdes. OCR mangles
-- names ("גלט עוף למהדרין" for "מ.ב גלאט עוף למהדרין", note 251068506), so the
-- push said "Priority cannot receive". This OUR-side trigger rewrites the
-- stored name to Priority's exact supdes when the supplier is unambiguous:
--   1. the note's ח.פ belongs to exactly one Priority supplier AND the names
--      agree (similarity >= 0.3 — OCR sometimes reads the CUSTOMER's ח.פ,
--      514259514, which belongs to an unrelated supplier), else
--   2. trigram similarity of the name (legal suffix dropped) >= 0.6 and
--      >= 0.2 ahead of the runner-up (replayed on every past delivery:
--      only correct suppliers pass).
-- An exact name match is left alone; any error leaves the row unchanged.
create or replace function public.delivery_supplier_key(t text)
returns text language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
    '[^0-9א-ת ]', '', 'g'), '(^| )בעמ( |$)', ' ', 'g'), ' +', ' ', 'g'))
$$;

create or replace function public.delivery_supplier_canonicalize()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_norm text := regexp_replace(coalesce(new.supplier_hebrew, ''), '[^0-9א-ת]', '', 'g');
  v_vat  text := nullif(regexp_replace(coalesce(new.supplier_vat, ''), '\D', '', 'g'), '');
  v_des  text;
  v_n    int;
  s1 real; s2 real;
begin
  if v_norm = '' then return new; end if;
  if exists (select 1 from priority_suppliers s
              where regexp_replace(coalesce(s.supdes, ''), '[^0-9א-ת]', '', 'g') = v_norm) then
    return new;
  end if;

  if v_vat is not null and length(v_vat) <= 9 then
    select min(s.supdes), count(distinct s.supname) into v_des, v_n
      from priority_suppliers s
     where (regexp_replace(coalesce(s.vatnum, ''), '\D', '', 'g') <> ''
            and lpad(regexp_replace(s.vatnum, '\D', '', 'g'), 9, '0') = lpad(v_vat, 9, '0'))
        or (regexp_replace(coalesce(s.compnum, ''), '\D', '', 'g') <> ''
            and lpad(regexp_replace(s.compnum, '\D', '', 'g'), 9, '0') = lpad(v_vat, 9, '0'));
    if v_n = 1 and public.similarity(delivery_supplier_key(v_des),
                                     delivery_supplier_key(new.supplier_hebrew)) >= 0.3 then
      new.supplier_hebrew := v_des;
      return new;
    end if;
  end if;

  select x.supdes, x.sim into v_des, s1 from (
    select s.supdes, public.similarity(delivery_supplier_key(s.supdes), delivery_supplier_key(new.supplier_hebrew)) sim
      from priority_suppliers s order by 2 desc limit 1) x;
  select max(public.similarity(delivery_supplier_key(s.supdes), delivery_supplier_key(new.supplier_hebrew))) into s2
    from priority_suppliers s where s.supdes is distinct from v_des;
  if s1 >= 0.6 and s1 - coalesce(s2, 0) >= 0.2 then
    new.supplier_hebrew := v_des;
  end if;
  return new;
exception when others then
  return new;
end
$$;

drop trigger if exists trg_delivery_supplier_canonicalize on public.deliveries;
create trigger trg_delivery_supplier_canonicalize
  before insert or update of supplier_hebrew, supplier_vat on public.deliveries
  for each row execute function public.delivery_supplier_canonicalize();
