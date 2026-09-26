-- ba_visit_kinds: ba_visit_detail with the kinds exactly as the BA picked them.
-- ba_visit_detail labels a BA-day with no picked kind as "Store visit" (mostly days with only an
-- expense charged to the store: event supplies, food for a retailer, parking). That is fine for the
-- Tiers/BA Report drills, but the PAD/EDU/Drop-in report counts "Store visit" days as drop-ins, so
-- it needs to tell a picked "Store visit" from the filler. Here activity is NULL when nothing was
-- picked. Same rows, same filters, same access as ba_visit_detail (read-only, SECURITY DEFINER).
-- Added 2026-09-25 for the Drop-in category (ar-reports.html repDropIns).
CREATE OR REPLACE FUNCTION public.ba_visit_kinds(p_from date, p_to date)
 RETURNS TABLE(sales_key text, disp_state text, d date, ba text, activity text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with
h as (
  select ba_id, work_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id, kind
  from hours where work_date between p_from and p_to and status <> 'rejected'
),
h_split as (
  select h.ba_id, h.d, h.kind, nullif(a.j->>'d','')::uuid as disp,
         h.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt
  from h
  cross join lateral jsonb_array_elements(h.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(h.alloc) x) s
  where jsonb_typeof(h.alloc) = 'array' and jsonb_array_length(h.alloc) > 0
  union all
  select h.ba_id, h.d, h.kind, u.disp, h.amount / cardinality(h.dispensary_ids)
  from h cross join lateral unnest(h.dispensary_ids) u(disp)
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and h.dispensary_ids is not null and cardinality(h.dispensary_ids) > 0
  union all
  select h.ba_id, h.d, h.kind, h.dispensary_id, h.amount from h
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and (h.dispensary_ids is null or cardinality(h.dispensary_ids) = 0)
),
e0 as (
  select ba_id, expense_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id
  from expenses where expense_date between p_from and p_to and status <> 'rejected'
),
e_split as (
  select e.ba_id, e.d, nullif(a.j->>'d','')::uuid as disp,
         e.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt
  from e0 e
  cross join lateral jsonb_array_elements(e.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(e.alloc) x) s
  where jsonb_typeof(e.alloc) = 'array' and jsonb_array_length(e.alloc) > 0
  union all
  select e.ba_id, e.d, u.disp, e.amount / cardinality(e.dispensary_ids)
  from e0 e cross join lateral unnest(e.dispensary_ids) u(disp)
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and e.dispensary_ids is not null and cardinality(e.dispensary_ids) > 0
  union all
  select e.ba_id, e.d, e.dispensary_id, e.amount from e0 e
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and (e.dispensary_ids is null or cardinality(e.dispensary_ids) = 0)
),
t0 as (
  select ba_id, trip_date as d, coalesce(amount,0) as amt, dispensary_id as disp, coalesce(miles,0) as miles, kind
  from trips where trip_date between p_from and p_to and status <> 'rejected'
),
acts as (
  select ba_id, d, disp, kind from t0      where disp is not null and (amt > 0 or miles > 0)
  union all
  select ba_id, d, disp, kind from h_split where disp is not null and amt > 0
  union all
  select ba_id, d, disp, null::text from e_split where disp is not null and amt > 0
),
kinds as (
  select a.ba_id, a.d, a.disp, nullif(btrim(k.k),'') as k
  from acts a
  left join lateral regexp_split_to_table(coalesce(a.kind,''), ',') k(k) on true
)
select dsp.sales_key, dsp.state, x.d,
       coalesce(nullif(split_part(p.full_name,' ',1),''), 'BA'),
       nullif(string_agg(distinct x.k, ' · '), '')
from kinds x
join dispensaries dsp on dsp.id = x.disp
left join profiles p on p.id = x.ba_id
where coalesce(dsp.retail,true) and not coalesce(dsp.private,false) and dsp.name not like '* %'
  and dsp.sales_key is not null
group by dsp.sales_key, dsp.state, x.d, x.ba_id, p.full_name
order by x.d
$function$;

grant execute on function public.ba_visit_kinds(date, date) to anon, authenticated;
notify pgrst, 'reload schema';
