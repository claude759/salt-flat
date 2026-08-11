-- BA field metrics → sales reports bridge (Customer Tiers "BA Visits" / "BA Spend" columns).
--
-- The BA field app (ba/index.html) and the AR reports app share this Supabase project, so there is
-- no export/sync at all: this RPC DERIVES per-store visit + spend aggregates straight from the BA
-- tables at call time. Any BA-side edit (reopened period, re-split expense, retired Gusto day) is
-- reflected on the next report render — there is no second copy of the truth to drift.
--
-- Identity: dispensaries.sales_key = the tierNorm-normalized sales-account name this store maps to
-- (tierNorm is ar-reports.html's cross-source customer key: strip trailing [..] tag, non-alnum →
-- space, trim, lowercase — sales_norm() below is its exact SQL twin). Seeded from the store's own
-- name (NY names ARE the LeafLink trade names by construction; CA names came from the Distru+Nabis
-- export), then hand-corrected per store where the two sides genuinely diverge. A store with spend
-- whose key matches no sales account shows up LOUDLY in the report's reconciliation line — never
-- silently dropped.
--
-- Spend definition mirrors the BA app's own "Spend by dispensary" (adminReport/dispSplit):
--   trips    → whole amount to the trip's dispensary_id
--   hours    → alloc jsonb weight-split (per-leg miles), else even across dispensary_ids
--   expenses → alloc jsonb dollar-split, else even across dispensary_ids
--   visits   → distinct (BA, store, day) with any positive attribution (the app's buildVisits rule)
-- One deliberate divergence: status='rejected' rows are EXCLUDED here (a rejected expense is not
-- spend); the BA app's internal report currently includes them.
-- (2026-08-11: the BA app's two report queries were missing hours.alloc, so they even-split
-- multi-store labor that this RPC weight-splits — fixed in ba/index.html v.79; both sides now
-- apply the identical alloc rule.)
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

-- ── 1. the crosswalk column ─────────────────────────────────────────────────────────────────────
alter table public.dispensaries add column if not exists sales_key text;

-- exact SQL twin of ar-reports.html tierNorm()
create or replace function public.sales_norm(s text) returns text
language sql immutable as
$$ select lower(btrim(regexp_replace(regexp_replace(coalesce(s,''), '\s*\[[^\]]*\]\s*$', ''), '[^a-zA-Z0-9]+', ' ', 'g'))) $$;

-- seed every unmapped real store from its own name
update public.dispensaries
   set sales_key = public.sales_norm(name)
 where sales_key is null
   and coalesce(retail, true) and not coalesce(private, false) and name not like '* %';

-- keep the key fresh for NEW stores and renames (unless an admin hand-set a custom key, which a
-- rename then never clobbers). The rename-follow only fires when the key column is unchanged in
-- the same UPDATE, so "rename + set a different key" always keeps the hand-set key. KNOWN LIMIT:
-- "rename + pin the key to the value it already holds" in ONE statement is indistinguishable from
-- a plain rename at trigger level (NEW = OLD for the column) and will auto-follow — to pin the
-- old default across a rename, use two statements: rename first, then set sales_key (a key
-- change without a rename never auto-follows).
create or replace function public.trg_disp_sales_key() returns trigger
language plpgsql as $$
begin
  if new.name like '* %' or coalesce(new.private,false) then return new; end if;
  if new.sales_key is null
     or (tg_op = 'UPDATE' and new.name is distinct from old.name
         and new.sales_key is not distinct from old.sales_key
         and new.sales_key = public.sales_norm(old.name)) then
    new.sales_key := public.sales_norm(new.name);
  end if;
  return new;
end $$;
drop trigger if exists disp_sales_key on public.dispensaries;
create trigger disp_sales_key before insert or update of name, sales_key
  on public.dispensaries for each row execute function public.trg_disp_sales_key();

-- ── 2. the metrics RPC ──────────────────────────────────────────────────────────────────────────
-- Returns one row per attribution bucket: real stores (is_store), placeholder/non-retail buckets,
-- and per-state "(unlinked)" rows — so the client can reconcile Σ(shown) + unmapped = total.
create or replace function public.ba_sales_metrics(p_from date, p_to date)
returns table (
  disp_id uuid, disp_name text, disp_state text, sales_key text, is_store boolean,
  visits bigint, labor numeric, mileage numeric, expense numeric, card numeric, total numeric
)
language sql stable security definer set search_path = public
as $$
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
$$;

-- open-feed posture (matches ny_credits / ny_dispensary_addresses): aggregated store-level
-- numbers only — no per-person rows or rates, and private (Home) locations are redacted to
-- an anonymous '(private location)' bucket before anything leaves this RPC.
grant execute on function public.ba_sales_metrics(date, date) to anon, authenticated;

-- Verify:  select * from public.ba_sales_metrics(current_date - 90, current_date) limit 20;
-- Undo:    drop function public.ba_sales_metrics(date, date);
--          drop trigger disp_sales_key on public.dispensaries;
--          alter table public.dispensaries drop column sales_key;
