-- BA field DETAIL for the Customer Tiers drills (companion to ba-sales-metrics.sql).
--
-- Read-only RPCs, anon-callable, store-level only, private (Home) locations excluded.
-- v2 posture (2026-08-12, per Gianni): rows DO name the BA (first name) and the activity kinds
-- they logged, and labor is per person-day — the owner wants who/what visible in the drills.
-- Split rules (alloc weight-split → even split → single id) are copied verbatim from
-- ba_sales_metrics so the drill always reconciles to the column.
--
--   ba_visit_days(p_from, p_to)          → (superseded by ba_visit_detail below) store-day + BA
--                                          count only; kept for compatibility.
--   ba_visit_detail(p_from, p_to)        → every (sales_key, day, BA) with the BA's first name +
--                                          activity kinds — feeds the merged Visits column
--                                          (schedule ∪ BA, deduped by day) + both visit drills.
--   ba_sales_detail(p_from, p_to, p_key) → the per-entry spend behind one account's BA Spend
--                                          cell: mileage per trip, expenses per receipt-share,
--                                          labor per store-day.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create or replace function public.ba_visit_days(p_from date, p_to date)
returns table (sales_key text, disp_state text, d date, bas bigint)
language sql stable security definer set search_path = public
as $$
with
h as (
  select ba_id, work_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id
  from hours where work_date between p_from and p_to and status <> 'rejected'
),
h_split as (
  select h.ba_id, h.d, nullif(a.j->>'d','')::uuid as disp,
         h.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt
  from h
  cross join lateral jsonb_array_elements(h.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(h.alloc) x) s
  where jsonb_typeof(h.alloc) = 'array' and jsonb_array_length(h.alloc) > 0
  union all
  select h.ba_id, h.d, u.disp, h.amount / cardinality(h.dispensary_ids)
  from h cross join lateral unnest(h.dispensary_ids) u(disp)
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and h.dispensary_ids is not null and cardinality(h.dispensary_ids) > 0
  union all
  select h.ba_id, h.d, h.dispensary_id, h.amount from h
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
  select ba_id, trip_date as d, coalesce(amount,0) as amt, dispensary_id as disp, coalesce(miles,0) as miles
  from trips where trip_date between p_from and p_to and status <> 'rejected'
),
vis as (
  select ba_id, d, disp from t0      where disp is not null and (amt > 0 or miles > 0)
  union
  select ba_id, d, disp from h_split where disp is not null and amt > 0
  union
  select ba_id, d, disp from e_split where disp is not null and amt > 0
)
select d.sales_key, d.state, v.d, count(distinct v.ba_id)
from vis v
join dispensaries d on d.id = v.disp
where coalesce(d.retail,true) and not coalesce(d.private,false) and d.name not like '* %'
  and d.sales_key is not null
group by d.sales_key, d.state, v.d
order by v.d
$$;

grant execute on function public.ba_visit_days(date, date) to anon, authenticated;

create or replace function public.ba_sales_detail(p_from date, p_to date, p_key text)
returns table (d date, kind text, descr text, amount numeric)
language sql stable security definer set search_path = public
as $$
with tgt as (
  select id, name from dispensaries
  where sales_key = p_key
    and coalesce(retail,true) and not coalesce(private,false) and name not like '* %'
),
multi as (select count(*) > 1 as m from tgt),
-- mileage: whole trip to its store (the metrics rule)
mil as (
  select t.trip_date as d, 'Mileage'::text as kind,
         btrim(concat_ws(' · ',
           nullif(concat_ws(' → ', nullif(t.start_label,''), nullif(t.dest_label,'')),''),
           round(coalesce(t.miles,0),1) || ' mi' || case when coalesce(t.roundtrip,false) then ' round trip' else '' end,
           nullif(t.note,''),
           case when (select m from multi) then g.name end)) as descr,
         coalesce(t.amount,0) as amount
  from trips t join tgt g on g.id = t.dispensary_id
  where t.trip_date between p_from and p_to and t.status <> 'rejected'
),
-- expenses: this store's share of each receipt (alloc weight-split → even → single)
e0 as (
  select ba_id, expense_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id,
         vendor, category, note, (payment in ('company','company_bank')) as co
  from expenses where expense_date between p_from and p_to and status <> 'rejected'
),
e_split as (
  select e.d, e.vendor, e.category, e.note, e.co, nullif(a.j->>'d','')::uuid as disp,
         e.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt,
         e.amount as whole
  from e0 e
  cross join lateral jsonb_array_elements(e.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(e.alloc) x) s
  where jsonb_typeof(e.alloc) = 'array' and jsonb_array_length(e.alloc) > 0
  union all
  select e.d, e.vendor, e.category, e.note, e.co, u.disp, e.amount / cardinality(e.dispensary_ids), e.amount
  from e0 e cross join lateral unnest(e.dispensary_ids) u(disp)
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and e.dispensary_ids is not null and cardinality(e.dispensary_ids) > 0
  union all
  select e.d, e.vendor, e.category, e.note, e.co, e.dispensary_id, e.amount, e.amount
  from e0 e
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and (e.dispensary_ids is null or cardinality(e.dispensary_ids) = 0)
),
exp as (
  select es.d, case when es.co then 'Company card' else 'Expense' end as kind,
         btrim(concat_ws(' · ', nullif(es.vendor,''), nullif(es.category,''), nullif(es.note,''),
           case when abs(es.amt - es.whole) > 0.005
                then 'this store''s share of a ' || to_char(es.whole,'FM999,990.00') || ' receipt' end,
           case when (select m from multi) then g.name end)) as descr,
         es.amt as amount
  from e_split es join tgt g on g.id = es.disp
),
-- labor: per store-day aggregate — NEVER per person (a lone row would expose a pay rate)
h as (
  select ba_id, work_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id, job
  from hours where work_date between p_from and p_to and status <> 'rejected'
),
h_split as (
  select h.ba_id, h.d, h.job, nullif(a.j->>'d','')::uuid as disp,
         h.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt
  from h
  cross join lateral jsonb_array_elements(h.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(h.alloc) x) s
  where jsonb_typeof(h.alloc) = 'array' and jsonb_array_length(h.alloc) > 0
  union all
  select h.ba_id, h.d, h.job, u.disp, h.amount / cardinality(h.dispensary_ids)
  from h cross join lateral unnest(h.dispensary_ids) u(disp)
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and h.dispensary_ids is not null and cardinality(h.dispensary_ids) > 0
  union all
  select h.ba_id, h.d, h.job, h.dispensary_id, h.amount from h
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and (h.dispensary_ids is null or cardinality(h.dispensary_ids) = 0)
),
lab as (
  select hs.d, 'Labor'::text as kind,
         btrim(concat_ws(' · ',
           count(distinct hs.ba_id) || ' BA-day' || case when count(distinct hs.ba_id) <> 1 then 's' else '' end,
           nullif(string_agg(distinct nullif(hs.job,''), ', '),''),
           case when (select m from multi) then g.name end)) as descr,
         sum(hs.amt) as amount
  from h_split hs join tgt g on g.id = hs.disp
  where hs.amt > 0
  group by hs.d, g.name
)
select d, kind, descr, round(amount,2) from (
  select * from mil union all select * from exp union all select * from lab
) x
where abs(amount) > 0.005
order by d, kind
$$;

grant execute on function public.ba_sales_detail(date, date, text) to anon, authenticated;

-- Verify:  select * from public.ba_visit_days(current_date-90, current_date) limit 10;
--          select * from public.ba_sales_detail(current_date-90, current_date, 'goat global westwood');
-- Undo:    drop function public.ba_visit_days(date, date);
--          drop function public.ba_sales_detail(date, date, text);

-- ── ba_visit_detail: WHO visited and WHAT they were doing (per store-day-BA) ────────────────────
-- Feeds the Tiers visit drills: first name + the BA app's activity kinds ("Demo / PAD",
-- "Education talk", "Store visit", …) gathered from that day's hours + trips at the store
-- (kind strings can be comma-joined multi-selects — split and deduped). Expense-only presence
-- falls back to 'Store visit'. First names only; no dollars, no rates.
create or replace function public.ba_visit_detail(p_from date, p_to date)
returns table (sales_key text, disp_state text, d date, ba text, activity text)
language sql stable security definer set search_path = public
as $$
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
       coalesce(nullif(string_agg(distinct x.k, ' · '), ''), 'Store visit')
from kinds x
join dispensaries dsp on dsp.id = x.disp
left join profiles p on p.id = x.ba_id
where coalesce(dsp.retail,true) and not coalesce(dsp.private,false) and dsp.name not like '* %'
  and dsp.sales_key is not null
group by dsp.sales_key, dsp.state, x.d, x.ba_id, p.full_name
order by x.d
$$;

grant execute on function public.ba_visit_detail(date, date) to anon, authenticated;
-- Verify:  select * from public.ba_visit_detail(current_date-30, current_date) limit 10;
-- Undo:    drop function public.ba_visit_detail(date, date);

-- ── v2 (2026-08-12, per Gianni): the BA's NAME on every spend row ───────────────────────────────
-- "What" now leads with who: labor becomes per (store-day, BA) — "Ledy — Brand Ambassador" —
-- and mileage/expense rows are prefixed with the BA's first name. Supersedes the v1 definition
-- above (re-running this file lands here).
create or replace function public.ba_sales_detail(p_from date, p_to date, p_key text)
returns table (d date, kind text, descr text, amount numeric)
language sql stable security definer set search_path = public
as $$
with tgt as (
  select id, name from dispensaries
  where sales_key = p_key
    and coalesce(retail,true) and not coalesce(private,false) and name not like '* %'
),
multi as (select count(*) > 1 as m from tgt),
fn as (select id, coalesce(nullif(split_part(full_name,' ',1),''),'BA') as fname from profiles),
mil as (
  select t.trip_date as d, 'Mileage'::text as kind,
         btrim(concat_ws(' · ', f.fname,
           nullif(concat_ws(' → ', nullif(t.start_label,''), nullif(t.dest_label,'')),''),
           round(coalesce(t.miles,0),1) || ' mi' || case when coalesce(t.roundtrip,false) then ' round trip' else '' end,
           nullif(t.note,''),
           case when (select m from multi) then g.name end)) as descr,
         coalesce(t.amount,0) as amount
  from trips t join tgt g on g.id = t.dispensary_id
  left join fn f on f.id = t.ba_id
  where t.trip_date between p_from and p_to and t.status <> 'rejected'
),
e0 as (
  select ba_id, expense_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id,
         vendor, category, note, (payment in ('company','company_bank')) as co
  from expenses where expense_date between p_from and p_to and status <> 'rejected'
),
e_split as (
  select e.ba_id, e.d, e.vendor, e.category, e.note, e.co, nullif(a.j->>'d','')::uuid as disp,
         e.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt,
         e.amount as whole
  from e0 e
  cross join lateral jsonb_array_elements(e.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(e.alloc) x) s
  where jsonb_typeof(e.alloc) = 'array' and jsonb_array_length(e.alloc) > 0
  union all
  select e.ba_id, e.d, e.vendor, e.category, e.note, e.co, u.disp, e.amount / cardinality(e.dispensary_ids), e.amount
  from e0 e cross join lateral unnest(e.dispensary_ids) u(disp)
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and e.dispensary_ids is not null and cardinality(e.dispensary_ids) > 0
  union all
  select e.ba_id, e.d, e.vendor, e.category, e.note, e.co, e.dispensary_id, e.amount, e.amount
  from e0 e
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and (e.dispensary_ids is null or cardinality(e.dispensary_ids) = 0)
),
exp as (
  select es.d, case when es.co then 'Company card' else 'Expense' end as kind,
         btrim(concat_ws(' · ', f.fname, nullif(es.vendor,''), nullif(es.category,''), nullif(es.note,''),
           case when abs(es.amt - es.whole) > 0.005
                then 'this store''s share of a ' || to_char(es.whole,'FM999,990.00') || ' receipt' end,
           case when (select m from multi) then g.name end)) as descr,
         es.amt as amount
  from e_split es join tgt g on g.id = es.disp
  left join fn f on f.id = es.ba_id
),
h as (
  select ba_id, work_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id, job, kind as hkind
  from hours where work_date between p_from and p_to and status <> 'rejected'
),
h_split as (
  select h.ba_id, h.d, h.job, h.hkind, nullif(a.j->>'d','')::uuid as disp,
         h.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw else 1.0 / s.n end as amt
  from h
  cross join lateral jsonb_array_elements(h.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(h.alloc) x) s
  where jsonb_typeof(h.alloc) = 'array' and jsonb_array_length(h.alloc) > 0
  union all
  select h.ba_id, h.d, h.job, h.hkind, u.disp, h.amount / cardinality(h.dispensary_ids)
  from h cross join lateral unnest(h.dispensary_ids) u(disp)
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and h.dispensary_ids is not null and cardinality(h.dispensary_ids) > 0
  union all
  select h.ba_id, h.d, h.job, h.hkind, h.dispensary_id, h.amount from h
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and (h.dispensary_ids is null or cardinality(h.dispensary_ids) = 0)
),
lab as (
  select hs.d, 'Labor'::text as kind,
         btrim(concat_ws(' · ',
           f.fname || coalesce(' — ' || nullif(string_agg(distinct nullif(btrim(k.k),''), ', '),''),
                               ' — ' || coalesce(nullif(string_agg(distinct nullif(hs.job,''), ', '),''),'BA day')),
           case when (select m from multi) then g.name end)) as descr,
         sum(hs.amt) as amount
  from h_split hs
  join tgt g on g.id = hs.disp
  left join fn f on f.id = hs.ba_id
  left join lateral regexp_split_to_table(coalesce(hs.hkind,''), ',') k(k) on true
  where hs.amt > 0
  group by hs.d, hs.ba_id, f.fname, g.name
)
select d, kind, descr, round(amount,2) from (
  select * from mil union all select * from exp union all select * from lab
) x
where abs(amount) > 0.005
order by d, kind
$$;
