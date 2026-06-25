-- ============================================================================
-- Wizard Trees — BA Mileage & Expense app
-- schema.sql  ·  tables, helpers, triggers
-- Apply once to a fresh Supabase project (SQL editor or `supabase db push`).
-- RLS policies live in policies.sql — run that AFTER this file.
-- ============================================================================

-- gen_random_uuid()
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles : one row per auth user (id == auth.users.id)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  role                 text not null default 'ba' check (role in ('ba','admin')),
  full_name            text,
  email                text,
  phone                text,
  base_address         text,
  base_lat             double precision,
  base_lng             double precision,
  rate_override        numeric(6,3),              -- per-mile override; null = global rate
  must_change_password boolean not null default true,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- app_settings : single-row global config (id is pinned to 1)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id                int primary key default 1 check (id = 1),
  mileage_rate      numeric(6,3) not null default 0.725,   -- 2026 IRS business rate
  period_length_days int not null default 14,              -- bi-weekly
  period_anchor     date not null default date '2026-01-05', -- a Monday: period boundaries derive from this
  updated_at        timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- dispensaries : the stores BAs visit (admin-managed; seedable from AR exports)
-- ---------------------------------------------------------------------------
create table if not exists public.dispensaries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  lat         double precision,
  lng         double precision,
  license     text,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists dispensaries_active_idx on public.dispensaries(active);

-- ---------------------------------------------------------------------------
-- pay_periods : explicit reimbursement windows (admin generates)
-- ---------------------------------------------------------------------------
create table if not exists public.pay_periods (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open','closed')),
  created_at  timestamptz not null default now(),
  unique (start_date, end_date)
);
create index if not exists pay_periods_range_idx on public.pay_periods(start_date, end_date);

-- ---------------------------------------------------------------------------
-- trips : a mileage event (distance-computed OR odometer-photo)
-- ---------------------------------------------------------------------------
create table if not exists public.trips (
  id            uuid primary key default gen_random_uuid(),
  ba_id         uuid not null references public.profiles(id) on delete cascade,
  trip_date     date not null,
  dispensary_id uuid references public.dispensaries(id),
  method        text not null check (method in ('distance','odometer')),
  start_odo     numeric(9,1),
  end_odo       numeric(9,1),
  start_photo   text,                  -- storage path in 'odometer' bucket
  end_photo     text,
  miles         numeric(8,2),
  miles_source  text,                  -- 'maps_cache' | 'maps_live' | 'odometer' | 'manual'
  rate          numeric(6,3) not null default 0.725,  -- set authoritatively by trigger
  amount        numeric(10,2) not null default 0,     -- miles*rate, set by trigger
  period_id     uuid references public.pay_periods(id),
  status        text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  note          text,
  reject_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists trips_ba_period_idx on public.trips(ba_id, period_id);
create index if not exists trips_status_idx on public.trips(status);

-- ---------------------------------------------------------------------------
-- expenses : a receipt-backed cost, tagged to a dispensary
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  ba_id         uuid not null references public.profiles(id) on delete cascade,
  expense_date  date not null,
  dispensary_id uuid references public.dispensaries(id),
  vendor        text,
  amount        numeric(10,2) not null,
  category      text,
  receipt_path  text,                  -- storage path in 'receipts' bucket
  ocr_raw       jsonb,                 -- raw model extraction for audit
  period_id     uuid references public.pay_periods(id),
  status        text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  note          text,
  reject_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists expenses_ba_period_idx on public.expenses(ba_id, period_id);
create index if not exists expenses_status_idx on public.expenses(status);

-- ---------------------------------------------------------------------------
-- submissions : one per (ba, period); drives the submit/approve workflow
-- ---------------------------------------------------------------------------
create table if not exists public.submissions (
  id           uuid primary key default gen_random_uuid(),
  ba_id        uuid not null references public.profiles(id) on delete cascade,
  period_id    uuid not null references public.pay_periods(id) on delete cascade,
  status       text not null default 'open' check (status in ('open','submitted','approved','rejected')),
  submitted_at timestamptz,
  approved_by  uuid references public.profiles(id),
  approved_at  timestamptz,
  totals       jsonb,
  note         text,
  unique (ba_id, period_id)
);

-- ---------------------------------------------------------------------------
-- distance_cache : memoized round-trip miles per (base, dispensary)
-- written by the calc-distance edge function (service role)
-- ---------------------------------------------------------------------------
create table if not exists public.distance_cache (
  id            uuid primary key default gen_random_uuid(),
  ba_id         uuid not null references public.profiles(id) on delete cascade,
  dispensary_id uuid not null references public.dispensaries(id) on delete cascade,
  miles_round   numeric(8,2) not null,
  computed_at   timestamptz not null default now(),
  unique (ba_id, dispensary_id)   -- one cached round-trip per BA base + store
);

-- ===========================================================================
-- Helper functions
-- ===========================================================================

-- is this request from a real end-user role, vs. a trusted context? PostgREST
-- SET ROLEs to 'authenticated'/'anon' for end users; everything else (the
-- service-role edge functions, and the postgres/supabase_admin SQL editor that
-- bootstraps the first admin) is trusted and bypasses the guard triggers.
-- NOT security definer, so current_user is the real caller's role.
create or replace function public.req_is_enduser()
returns boolean
language sql
stable
as $$
  select current_user in ('authenticated', 'anon');
$$;

-- is the current auth user an admin?  (security definer so it can read profiles
-- regardless of the caller's RLS — used inside policies)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

-- authoritative per-mile rate for a BA: their override, else the global rate
create or replace function public.effective_rate(p uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select rate_override from public.profiles where id = p),
    (select mileage_rate from public.app_settings where id = 1),
    0.725
  );
$$;

-- ===========================================================================
-- Triggers
-- ===========================================================================

-- trips: server owns miles (for distance method), rate, and amount — the client
-- cannot inflate any of them. rate/amount/miles FREEZE once the row leaves the
-- editable states (draft/rejected), so an admin's "approve" update can't silently
-- re-price a trip if the global rate changed in between.
create or replace function public.trg_trip_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cached numeric;
begin
  if tg_op = 'UPDATE' and new.status in ('submitted','approved') then
    -- locked: preserve the values computed while it was still editable
    new.miles        := old.miles;
    new.miles_source := old.miles_source;
    new.rate         := old.rate;
    new.amount       := old.amount;
  else
    -- editable (insert / draft / rejected): recompute authoritatively
    if new.method = 'distance' then
      select miles_round into cached
        from public.distance_cache
       where ba_id = new.ba_id and dispensary_id = new.dispensary_id;
      if cached is not null then
        new.miles := cached;                 -- trust the server-computed route
        new.miles_source := 'maps_cache';
      else
        new.miles_source := 'manual';        -- no cached route (e.g. no maps key)
      end if;
    end if;
    new.rate   := public.effective_rate(new.ba_id);
    new.amount := round(coalesce(new.miles, 0) * new.rate, 2);
  end if;
  if new.period_id is null then
    select id into new.period_id
      from public.pay_periods
     where new.trip_date between start_date and end_date
     order by start_date desc
     limit 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trips_before on public.trips;
create trigger trips_before
  before insert or update on public.trips
  for each row execute function public.trg_trip_before();

-- expenses: assign period, stamp updated_at (amount is the BA-confirmed total)
create or replace function public.trg_expense_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.period_id is null then
    select id into new.period_id
      from public.pay_periods
     where new.expense_date between start_date and end_date
     order by start_date desc
     limit 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists expenses_before on public.expenses;
create trigger expenses_before
  before insert or update on public.expenses
  for each row execute function public.trg_expense_before();

-- profiles: a non-admin may only edit their own descriptive fields. role,
-- active, the per-mile rate_override, and the server-derived base lat/lng are
-- off-limits (a BA could otherwise inflate their own reimbursement or relocate
-- their base to fake a longer auto-distance). The edge functions (service role)
-- and admins bypass this. A BA MAY clear base_lat/lng to null — that just asks
-- calc-distance to re-geocode their new address.
-- NOT security definer, so req_is_enduser()/is_admin() read the real caller.
create or replace function public.trg_profile_guard()
returns trigger
language plpgsql
as $$
begin
  if (not public.req_is_enduser()) or public.is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'only admins can change role';
  end if;
  if new.active is distinct from old.active then
    raise exception 'only admins can change active';
  end if;
  if new.rate_override is distinct from old.rate_override then
    raise exception 'only admins can change the mileage rate';
  end if;
  if new.base_lat is distinct from old.base_lat and new.base_lat is not null then
    raise exception 'base coordinates are set by the server';
  end if;
  if new.base_lng is distinct from old.base_lng and new.base_lng is not null then
    raise exception 'base coordinates are set by the server';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.trg_profile_guard();

-- new auth user -> ensure a profile row exists (admin-create-ba also does this,
-- but this covers any auth-side signup and keeps id in sync).
-- role is ALWAYS 'ba' here — never trust client signup metadata for it; only
-- admin-create-ba (service role) may elevate to admin afterward. Also disable
-- open signups in the project's Auth settings as defense in depth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.email),
          'ba')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- submissions: a non-admin may never write the approval/audit columns
-- (approved_by / approved_at). Status is already constrained by RLS; this
-- stops a BA from forging who/when a submission was approved.
create or replace function public.trg_submission_guard()
returns trigger
language plpgsql
as $$
begin
  if (not public.req_is_enduser()) or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.approved_by := null;
    new.approved_at := null;
  else
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;
  return new;
end;
$$;
drop trigger if exists submissions_guard on public.submissions;
create trigger submissions_guard
  before insert or update on public.submissions
  for each row execute function public.trg_submission_guard();
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- ensure_period(d): return the pay_period covering date d, creating it from the
-- app_settings anchor/length if it doesn't exist yet. Security definer so any
-- signed-in user can guarantee the current period exists (admins still own the
-- bulk generation / closing flow). Bi-weekly windows derive deterministically
-- from period_anchor, so the same date always maps to the same window.
-- ===========================================================================
create or replace function public.ensure_period(d date default current_date)
returns public.pay_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  s   public.app_settings;
  n   int;
  ps  date;
  pe  date;
  rec public.pay_periods;
begin
  select * into s from public.app_settings where id = 1;
  n  := floor(((d - s.period_anchor)::numeric) / s.period_length_days);
  ps := s.period_anchor + (n * s.period_length_days);
  pe := ps + (s.period_length_days - 1);
  select * into rec from public.pay_periods where start_date = ps and end_date = pe;
  if not found then
    insert into public.pay_periods (label, start_date, end_date)
    values (to_char(ps, 'Mon FMDD') || '–' || to_char(pe, 'Mon FMDD, YYYY'), ps, pe)
    on conflict (start_date, end_date) do nothing
    returning * into rec;
    if rec.id is null then
      select * into rec from public.pay_periods where start_date = ps and end_date = pe;
    end if;
  end if;
  return rec;
end;
$$;
