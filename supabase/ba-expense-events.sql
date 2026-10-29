-- ============================================================================
--  BA app: event columns on expenses + rows synced from the books   2026-10-23
-- ----------------------------------------------------------------------------
--  Gianni (10/23): tag every event cost with the event's folder name in QuickBooks, and feed the BA app from the
--  books. The hourly event sync on Gianni's Mac (~/bank-dashboard/fills/event-sync.mjs) writes one expenses row per
--  tagged QuickBooks expense line, owned by the Automation profile (a426046a-c0b4-42d0-ae13-6787df43ca77), and can tag
--  a BA's own row that is the same purchase. New columns:
--    event_name  the events-app folder name, e.g. 'PUFFCON 2026 (10/3/26)' (the QuickBooks tag minus 'Event: ')
--    event_id    the events-app Event ID (survives a rename of the folder)
--    books_key   the QuickBooks line a synced row IS: '<company>:<txnType>:<txnId>:<lineId>'. Plain UNIQUE (not
--                partial): a second row for the same line is refused (the sync inserts with a plain POST, never an
--                upsert); NULLs stay distinct, so app rows and any number of untagged rows are unaffected.
--    source      null = entered in the app; 'books' = written by the sync. Only those rows are ever rewritten or
--                deleted by it.
--  Only the sync's login (an admin), any other admin, the service key or direct SQL may set or change the four
--  columns: trg_expense_books_guard keeps a BA's own insert or update from touching them.
--  A row from the books is a company-paid QuickBooks line, not field work, so:
--    * trg_force_non_ba leaves its store link alone;
--    * ba_sales_metrics keeps its dollars (Customer Tiers 'BA Spend', as card) but never counts it as a BA visit, and
--      ba_visit_detail, ba_visit_kinds and ba_visit_days leave it out (no 'Store visit' days credited to 'Automation').
--  Each function below is the LIVE definition (pg_get_functiondef, read 2026-10-23) with only the lines marked
--  "books" added; the older repo files (ba-sales-metrics.sql, ba-sales-detail.sql, ba-visit-kinds.sql) get the same
--  lines in this release, so re-applying one of them cannot undo the visit exclusion.
--  The BA app page feature-detects the columns, so it works before and after this file.
--  Apply: node ~/claude-sql/run-sql-ca.mjs "supabase/ba-expense-events.sql" (project dhiqhgtmelxwelyoowle).
--  Check:  supabase/ba-expense-events-verify.sql (one transaction that rolls back; every row must say pass = true).
--  Undo:   supabase/ba-expense-events-rollback.sql. Safe to re-run.
-- ============================================================================

begin;

-- ── 1. the columns ───────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.expenses
  add column if not exists event_name text,
  add column if not exists event_id   text,
  add column if not exists books_key  text,
  add column if not exists source     text;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_books_key_key') then
    alter table public.expenses add constraint expenses_books_key_key unique (books_key);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_source_check') then
    alter table public.expenses add constraint expenses_source_check check (source is null or source = 'books');
  end if;
end $$;

comment on column public.expenses.event_name is 'events-app folder name, e.g. PUFFCON 2026 (10/3/26); set by the event sync (supabase/ba-expense-events.sql)';
comment on column public.expenses.event_id   is 'events-app Event ID; set by the event sync';
comment on column public.expenses.books_key  is 'the QuickBooks line a synced row is: <company>:<txnType>:<txnId>:<lineId>';
comment on column public.expenses.source     is 'null = entered in the BA app; books = written by the event sync from QuickBooks (read-only in the app)';

-- ── 1b. who may set them: the sync, an admin, the service key or direct SQL ──────────────────────────────────────────
-- The four columns belong to the event sync (signed in as the Automation login, an admin) and to admins. Anyone else's
-- write keeps them as they were: a BA's insert arrives with none, a BA's update keeps the row's own. So a BA cannot mark
-- a draft 'books' (read-only, no to-do, no visit), claim a books_key the sync needs, or retag an event. Silent, like
-- trg_force_non_ba: an app save that sends the row back unchanged still works.
-- NOT security definer, so req_is_enduser() reads the real caller (the same test trg_profile_guard uses).
-- a0_ sorts before aa_force_non_ba: BEFORE triggers fire in name order, so a BA's 'books' mark is gone before
-- trg_force_non_ba looks at it.
create or replace function public.trg_expense_books_guard() returns trigger
language plpgsql as $function$
begin
  if (not public.req_is_enduser()) or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.source := null; new.books_key := null; new.event_name := null; new.event_id := null;
  else
    new.source := old.source; new.books_key := old.books_key; new.event_name := old.event_name; new.event_id := old.event_id;
  end if;
  return new;
end $function$;
drop trigger if exists a0_expense_books_guard on public.expenses;
create trigger a0_expense_books_guard before insert or update on public.expenses
  for each row execute function public.trg_expense_books_guard();

-- ── 2. trg_force_non_ba: a row from the books keeps its store link ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_force_non_ba()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_always boolean; v_from date; v_date date; v_bucket uuid;
begin
  -- books: a row the event sync wrote from QuickBooks (source 'books', supabase/ba-expense-events.sql) is a company
  -- purchase, not this person's field work, so its store link (the event venue or '* Brand event') stays as written.
  -- Only the sync's own login (a universal admin) or a direct SQL write gets this; a BA marking a row 'books' does not.
  if tg_table_name = 'expenses' then
    if new.source = 'books' and (auth.uid() is null or public.is_universal_admin()) then return new; end if;
  end if;
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

-- ── 3. visits leave out the rows from the books (their dollars stay) ─────────────────────────────────────────────────
-- ba_sales_metrics: Customer Tiers 'BA Visits' / 'BA Spend'. Dollars keep counting (as 'card'); visits do not.
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
         (payment in ('company','company_bank')) as co,
         (source is not distinct from 'books') as books   -- books: synced from QuickBooks, dollars only (no visit)
  from expenses where expense_date between p_from and p_to and status <> 'rejected'
),
e_split as (
  select e.ba_id, e.d, e.state, e.co, e.books, nullif(a.j->>'d','')::uuid as disp,
         e.amount * case when s.tw > 0 then greatest(coalesce((a.j->>'w')::numeric,0),0) / s.tw
                         else 1.0 / s.n end as amt
  from e0 e
  cross join lateral jsonb_array_elements(e.alloc) a(j)
  cross join lateral (select sum(greatest(coalesce((x->>'w')::numeric,0),0)) as tw, count(*) as n
                      from jsonb_array_elements(e.alloc) x) s
  where jsonb_typeof(e.alloc) = 'array' and jsonb_array_length(e.alloc) > 0
  union all
  select e.ba_id, e.d, e.state, e.co, e.books, u.disp, e.amount / cardinality(e.dispensary_ids)
  from e0 e cross join lateral unnest(e.dispensary_ids) u(disp)
  where (e.alloc is null or jsonb_typeof(e.alloc) <> 'array' or jsonb_array_length(e.alloc) = 0)
    and e.dispensary_ids is not null and cardinality(e.dispensary_ids) > 0
  union all
  select e.ba_id, e.d, e.state, e.co, e.books, e.dispensary_id, e.amount
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
  select ba_id, d, disp from e_split where disp is not null and amt > 0 and not books
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

-- ba_visit_detail: the Tiers merged Visits column, BA Report 'Last store visit', NY Visits.
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
    and source is distinct from 'books'   -- books: synced from QuickBooks, never a visit
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

-- ba_visit_kinds: the drop-in report.
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
    and source is distinct from 'books'   -- books: synced from QuickBooks, never a visit
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

-- ba_visit_days: the older per-day visit count (no caller in the repo today; kept in step so none can disagree).
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
    and source is distinct from 'books'   -- books: synced from QuickBooks, never a visit
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

notify pgrst, 'reload schema';

commit;
