-- ============================================================================
--  ROLLBACK of supabase/ba-expense-events.sql   2026-10-23
-- ----------------------------------------------------------------------------
--  Turn the event sync's BA writes OFF first (remove ~/bank-dashboard/data/.event-sync-ba-enabled on Gianni's Mac).
--  Then this file, in one transaction:
--    1. puts trg_force_non_ba, ba_sales_metrics, ba_visit_detail, ba_visit_kinds and ba_visit_days back exactly as
--       they were live before the change (pg_get_functiondef, read 2026-10-23), BEFORE the columns go: SQL function
--       bodies are not dependency-tracked, so dropping the column first would leave them broken;
--    2. deletes the rows the sync wrote: source = 'books' AND owned by the Automation profile AND a books_key. The
--       guard trigger stops a BA marking their own row 'books' through the API, but a row can still get it by hand
--       in SQL, so source alone does not name only the sync's rows; any other such row is kept and reported in a
--       notice. Without this the sync's rows would turn into ordinary app rows owned by Automation and start counting
--       as visits;
--    3. drops the guard trigger and its function, then the two constraints and the four columns (BA rows the sync
--       only tagged keep everything else).
--  After it, put supabase/ba-sales-metrics.sql, ba-sales-detail.sql and ba-visit-kinds.sql back to their previous
--  versions too (git): their refreshed bodies read expenses.source and would no longer apply.
--  The BA app page keeps working (it falls back to the old select when the columns are missing).
--  Apply: node ~/claude-sql/run-sql-ca.mjs "supabase/ba-expense-events-rollback.sql".
-- ============================================================================

begin;

-- ── 1. the live definitions as they were before ba-expense-events.sql (pg_get_functiondef, 2026-10-23) ──────────────
CREATE OR REPLACE FUNCTION public.trg_force_non_ba()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_always boolean; v_from date; v_date date; v_bucket uuid;
begin
  select non_ba, non_ba_from into v_always, v_from from public.profiles where id = new.ba_id;
  -- Leave before touching any date column: this trigger runs on EVERY write to these
  -- three tables, and the date column has a different name in each. A single CASE over
  -- new.trip_date/new.expense_date/new.work_date resolves ALL of its branches against
  -- the actual record, so it errors on whichever table doesn't have that column —
  -- which took out every hours/trips/expenses write, not just this person's.
  if not coalesce(v_always,false) and v_from is null then return new; end if;
  if    tg_table_name = 'trips'    then v_date := new.trip_date;
  elsif tg_table_name = 'expenses' then v_date := new.expense_date;
  else                                  v_date := new.work_date;
  end if;
  if not (coalesce(v_always,false) or v_date >= v_from) then
    return new;                       -- dated before they stopped being a BA
  end if;
  v_bucket := public.non_ba_disp();
  -- The three tables do NOT share an attribution shape, and PL/pgSQL resolves a field
  -- reference against the actual record — so each table gets only the columns it has:
  --   trips    → kind, dispensary_id            (no dispensary_ids, no alloc)
  --   expenses → dispensary_id, dispensary_ids, alloc   (no kind)
  --   hours    → all of them
  -- Park on the Non-BA bucket rather than clearing the link: a NULL link would be
  -- re-autolinked onto real stores by hours_before, which runs after this trigger.
  if tg_table_name = 'trips' then
    new.kind := 'Non-BA activity';
    new.dispensary_id := v_bucket;
  elsif tg_table_name = 'expenses' then
    new.dispensary_id  := v_bucket;
    new.dispensary_ids := case when v_bucket is null then null else array[v_bucket] end;
    new.alloc := null;
  else
    new.kind := 'Non-BA activity';
    new.dispensary_id  := v_bucket;
    new.dispensary_ids := case when v_bucket is null then null else array[v_bucket] end;
    new.alloc := null;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.ba_sales_metrics(p_from date, p_to date)
 RETURNS TABLE(disp_id uuid, disp_name text, disp_state text, sales_key text, is_store boolean, visits bigint, labor numeric, mileage numeric, expense numeric, card numeric, total numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with
h as (  -- labor rows in window
  select ba_id, work_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id, state
  from hours where work_date between p_from and p_to and status <> 'rejected'
),
h_split as (
  -- alloc present → weight-split (equal split when all weights are 0) — the app's dispSplit rule
  select h.ba_id, h.d, h.state, nullif(a.j->>'d','')::uuid as disp,
         h.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw
                         else 1.0 / s.n end as amt
  from h
  cross join lateral jsonb_array_elements(h.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(h.alloc) x) s
  where jsonb_typeof(h.alloc) = 'array' and jsonb_array_length(h.alloc) > 0
  union all
  -- no alloc → even split across dispensary_ids
  select h.ba_id, h.d, h.state, u.disp, h.amount / cardinality(h.dispensary_ids)
  from h cross join lateral unnest(h.dispensary_ids) u(disp)
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and h.dispensary_ids is not null and cardinality(h.dispensary_ids) > 0
  union all
  -- no links → single dispensary_id (usually null ⇒ the unlinked bucket)
  select h.ba_id, h.d, h.state, h.dispensary_id, h.amount
  from h
  where (h.alloc is null or jsonb_typeof(h.alloc) <> 'array' or jsonb_array_length(h.alloc) = 0)
    and (h.dispensary_ids is null or cardinality(h.dispensary_ids) = 0)
),
e0 as (  -- expense rows in window (co = paid by the company: card or company bank)
  select ba_id, expense_date as d, coalesce(amount,0) as amount, alloc, dispensary_ids, dispensary_id, state,
         (payment in ('company','company_bank')) as co
  from expenses where expense_date between p_from and p_to and status <> 'rejected'
),
e_split as (
  select e.ba_id, e.d, e.state, e.co, nullif(a.j->>'d','')::uuid as disp,
         e.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw
                         else 1.0 / s.n end as amt
  from e0 e
  cross join lateral jsonb_array_elements(e.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(e.alloc) x) s
  where jsonb_typeof(e.alloc) = 'array' and jsonb_array_length(e.alloc) > 0
  union all
  select e.ba_id, e.d, e.state, e.co, u.disp, e.amount / cardinality(e.dispensary_ids)
  from e0 e cross join lateral unnest(e.dispensary_ids) u(disp)
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and e.dispensary_ids is not null and cardinality(e.dispensary_ids) > 0
  union all
  select e.ba_id, e.d, e.state, e.co, e.dispensary_id, e.amount
  from e0 e
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and (e.dispensary_ids is null or cardinality(e.dispensary_ids) = 0)
),
t0 as (  -- mileage: whole trip amount to the trip's store (the app's rule)
  select ba_id, trip_date as d, coalesce(amount,0) as amt, dispensary_id as disp, state, coalesce(miles,0) as miles
  from trips where trip_date between p_from and p_to and status <> 'rejected'
),
money as (  -- bstate only matters for unlinked rows (stores carry their own state)
  select disp, case when disp is null then state end as bstate, 'labor'::text as kind, amt from h_split
  union all
  select disp, case when disp is null then state end, case when co then 'card' else 'exp' end, amt from e_split
  union all
  select disp, case when disp is null then state end, 'mileage', amt from t0
),
sums as (
  select disp, bstate,
         coalesce(sum(amt) filter (where kind = 'labor'),   0) as labor,
         coalesce(sum(amt) filter (where kind = 'mileage'), 0) as mileage,
         coalesce(sum(amt) filter (where kind = 'exp'),     0) as expense,
         coalesce(sum(amt) filter (where kind = 'card'),    0) as card
  from money group by disp, bstate
),
vis as (  -- a visit = one BA at one store on one day, from any positive attribution
  select ba_id, d, disp from t0     where disp is not null and (amt > 0 or miles > 0)
  union
  select ba_id, d, disp from h_split where disp is not null and amt > 0
  union
  select ba_id, d, disp from e_split where disp is not null and amt > 0
),
vc as ( select disp, count(distinct (ba_id, d)) as v from vis group by disp )
-- Private (Home) pins are REDACTED, not dropped: this function is security definer + anon-
-- callable, so a BA's private location name must never leave it — but its dollars still have
-- to reconcile, so the row survives with identity nulled ('(private location)', no id/key).
select case when coalesce(d.private,false) then null else d.id end,
       case when coalesce(d.private,false) then '(private location)'
            else coalesce(d.name, '(unlinked — not tied to a store)') end,
       coalesce(d.state, s.bstate),
       case when coalesce(d.private,false) then null else d.sales_key end,
       (d.id is not null and coalesce(d.retail,true) and not coalesce(d.private,false)
        and d.name not like '* %'),
       coalesce(vc.v, 0),
       round(s.labor, 2), round(s.mileage, 2), round(s.expense, 2), round(s.card, 2),
       round(s.labor + s.mileage + s.expense + s.card, 2)
from sums s
left join dispensaries d on d.id = s.disp
left join vc on vc.disp = s.disp
where abs(s.labor) + abs(s.mileage) + abs(s.expense) + abs(s.card) > 0.005 or coalesce(vc.v,0) > 0
order by 11 desc
$function$;

CREATE OR REPLACE FUNCTION public.ba_visit_detail(p_from date, p_to date)
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
       coalesce(nullif(string_agg(distinct x.k, ' · '), ''), 'Store visit')
from kinds x
join dispensaries dsp on dsp.id = x.disp
left join profiles p on p.id = x.ba_id
where coalesce(dsp.retail,true) and not coalesce(dsp.private,false) and dsp.name not like '* %'
  and dsp.sales_key is not null
group by dsp.sales_key, dsp.state, x.d, x.ba_id, p.full_name
order by x.d
$function$;

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

CREATE OR REPLACE FUNCTION public.ba_visit_days(p_from date, p_to date)
 RETURNS TABLE(sales_key text, disp_state text, d date, bas bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ── 2. the sync's own rows ──────────────────────────────────────────────────────────────────────────────────────────
-- Only rows the sync itself writes: source 'books', owned by the Automation profile, with a books_key. Any other row
-- carrying source 'books' (set by hand in SQL; the guard trigger stops a BA doing it through the API) is someone else's,
-- so it is kept (and counted in a notice) rather than deleted.
do $$ declare n int; m int; begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'expenses' and column_name = 'source') then
    delete from public.expenses
     where source = 'books' and ba_id = 'a426046a-c0b4-42d0-ae13-6787df43ca77'::uuid and books_key is not null;
    get diagnostics n = row_count;
    raise notice 'removed % row(s) synced from the books', n;
    select count(*) into m from public.expenses where source = 'books';
    if m > 0 then raise notice 'kept % row(s) marked books that the sync did not write (not Automation''s, or no books_key)', m; end if;
  end if;
end $$;

-- the optional regional-admin policy (optional/regional-admin-events-policy.sql) reads `source`, and a policy blocks
-- dropping a column it uses: put back the live policy first if that one is in place
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'expenses'
              and policyname = 'expenses_select' and qual like '%source%') then
    drop policy expenses_select on public.expenses;
    create policy expenses_select on public.expenses for select to authenticated
      using ( ba_id = auth.uid() or public.admin_sees_ba(ba_id) );
  end if;
end $$;

-- ── 3. the guard, constraints and columns ───────────────────────────────────────────────────────────────────────────
-- the guard names the four columns, so it goes first: left behind, it would fail every expenses write
drop trigger if exists a0_expense_books_guard on public.expenses;
drop function if exists public.trg_expense_books_guard();
alter table public.expenses drop constraint if exists expenses_books_key_key;
alter table public.expenses drop constraint if exists expenses_source_check;
alter table public.expenses
  drop column if exists event_name,
  drop column if exists event_id,
  drop column if exists books_key,
  drop column if exists source;

commit;

notify pgrst, 'reload schema';
