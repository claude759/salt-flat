-- ============================================================================
-- GENERATED: schema.sql + policies.sql concatenated for one-paste setup.
-- Run this whole file once in the Supabase SQL Editor on a fresh project.
-- (Source of truth is schema.sql + policies.sql; regenerate if those change.)
-- ============================================================================

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
  region               text check (region in ('CA','FL','NY')),  -- BA's state; null for admins
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
  mileage_rate      numeric(6,3) not null default 0.76,    -- IRS business rate Jul–Dec 2026
  period_length_days int not null default 14,              -- bi-weekly
  period_anchor     date not null default date '2026-06-20', -- pay-period start; windows derive from this
  updated_at        timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- dispensaries : the stores BAs visit (admin-managed; seedable from AR exports)
-- ---------------------------------------------------------------------------
create table if not exists public.dispensaries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                            -- DBA / storefront name
  legal_name  text,                                     -- legal entity (optional)
  address     text,
  state       text check (state in ('CA','FL','NY')),  -- only BAs in this region see it
  private     boolean not null default false,          -- true = personal (Home), visible to owner only
  retail      boolean not null default true,           -- false = errand stop (post office, gas, food); its trips file under * General BA activity
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
  dispensary_id uuid references public.dispensaries(id),     -- optional; destination may be free text
  start_label   text,                                        -- starting location (free text or "Current location")
  dest_label    text,                                        -- destination (free text or dispensary name)
  start_lat     double precision,                            -- GPS start (auto-distance)
  start_lng     double precision,
  roundtrip     boolean not null default true,
  method        text not null check (method in ('distance','odometer','manual')),
  start_odo     numeric(9,1),
  end_odo       numeric(9,1),
  start_photo   text,                  -- storage path in 'odometer' bucket
  end_photo     text,
  miles         numeric(8,2),
  miles_source  text,                  -- 'maps_cache' | 'maps_live' | 'odometer' | 'manual'
  rate          numeric(6,3) not null default 0.76,   -- set authoritatively by trigger
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
  payment       text not null default 'reimbursement' check (payment in ('reimbursement','company')),
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
    0.76
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
declare v_pid uuid;
begin
  if tg_op = 'UPDATE' and new.status in ('submitted','approved') and public.is_admin() then
    -- admin correcting a past/locked period: keep the locked-in rate, recompute $ from the (possibly edited) miles
    new.rate   := old.rate;
    new.amount := round(coalesce(new.miles,0) * coalesce(old.rate, public.effective_rate(new.ba_id)), 2);
  elsif tg_op = 'UPDATE' and new.status in ('submitted','approved') then
    -- locked once submitted: a BA cannot alter anything that drives the reimbursement $
    new.miles := old.miles; new.miles_source := old.miles_source;
    new.rate := old.rate;   new.amount := old.amount;
    new.start_label := old.start_label; new.dest_label := old.dest_label;
    new.start_lat := old.start_lat;     new.start_lng := old.start_lng;
    new.roundtrip := old.roundtrip;
  else
    -- editable (insert / draft / rejected): rate is server-owned, amount derived.
    -- miles come from the client (calc-distance result, odometer delta, or typed);
    -- the start GPS/labels are stored for the admin to audit.
    new.rate   := public.effective_rate(new.ba_id);
    new.amount := round(coalesce(new.miles, 0) * new.rate, 2);
  end if;
  -- keep the row in the pay period that matches its (possibly edited) date
  select id into v_pid
    from public.pay_periods
   where new.trip_date between start_date and end_date
   order by start_date desc
   limit 1;
  if v_pid is not null then new.period_id := v_pid; end if;
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
declare v_pid uuid;
begin
  -- keep the row in the pay period that matches its (possibly edited) date
  select id into v_pid
    from public.pay_periods
   where new.expense_date between start_date and end_date
   order by start_date desc
   limit 1;
  if v_pid is not null then new.period_id := v_pid; end if;
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

-- the caller's region (CA/FL/NY) — used by the locations RLS
create or replace function public.my_region()
returns text language sql stable security definer set search_path = public as $$
  select region from public.profiles where id = auth.uid();
$$;

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


-- ============================================================================
-- Wizard Trees — BA Mileage & Expense app
-- policies.sql  ·  Row-Level Security + Storage buckets/policies
-- Run AFTER schema.sql.
--
-- Model: every BA can read/write ONLY their own rows; admins (is_admin()) can
-- read everything and perform approvals. The service-role key (used by edge
-- functions) bypasses RLS entirely, so privileged work is centralized there.
-- ============================================================================

alter table public.profiles      enable row level security;
alter table public.app_settings  enable row level security;
alter table public.dispensaries  enable row level security;
alter table public.pay_periods   enable row level security;
alter table public.trips         enable row level security;
alter table public.expenses      enable row level security;
alter table public.submissions   enable row level security;
alter table public.distance_cache enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- self-update (role/active changes blocked by trg_profile_guard) or admin
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- inserts happen via the admin-create-ba edge function / auth trigger (service
-- role), so no INSERT policy is granted to normal users.

-- ---------------------------------------------------------------------------
-- app_settings  (everyone reads the rate; only admins change it)
-- ---------------------------------------------------------------------------
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- dispensaries  (any signed-in user can read; admins manage)
-- ---------------------------------------------------------------------------
-- Locations: admins see all; a BA sees shared locations in their state + their own
-- (incl. private "Home"). BAs add in their state; shared ones are collaboratively
-- editable by any BA in that state; private ones only by their owner.
drop policy if exists dispensaries_select on public.dispensaries;
create policy dispensaries_select on public.dispensaries for select to authenticated
  using ( public.is_admin()
       or (private = false and state = public.my_region())
       or (created_by = auth.uid()) );

drop policy if exists dispensaries_write  on public.dispensaries;
drop policy if exists dispensaries_insert on public.dispensaries;
create policy dispensaries_insert on public.dispensaries for insert to authenticated
  with check ( public.is_admin()
            or (created_by = auth.uid() and state = public.my_region()) );

drop policy if exists dispensaries_update on public.dispensaries;
create policy dispensaries_update on public.dispensaries for update to authenticated
  using      ( public.is_admin() or (private = false and state = public.my_region()) or created_by = auth.uid() )
  with check ( public.is_admin() or state = public.my_region() or created_by = auth.uid() );

drop policy if exists dispensaries_delete on public.dispensaries;
create policy dispensaries_delete on public.dispensaries for delete to authenticated
  using      ( public.is_admin() or (private = false and state = public.my_region()) or created_by = auth.uid() );

-- ---------------------------------------------------------------------------
-- pay_periods  (read all; admins manage)
-- ---------------------------------------------------------------------------
drop policy if exists pay_periods_select on public.pay_periods;
create policy pay_periods_select on public.pay_periods
  for select to authenticated using (true);

drop policy if exists pay_periods_write on public.pay_periods;
create policy pay_periods_write on public.pay_periods
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- trips
--   read   : own or admin
--   insert : own only, must start as draft
--   update : own while draft/rejected (incl. flipping to submitted, never
--            approved) ; admins can update anything (approve/reject)
--   delete : own draft, or admin
-- ---------------------------------------------------------------------------
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

drop policy if exists trips_insert on public.trips;
create policy trips_insert on public.trips
  for insert to authenticated
  with check (ba_id = auth.uid() and status = 'draft');

drop policy if exists trips_update on public.trips;
create policy trips_update on public.trips
  for update to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('draft','submitted')) or public.is_admin());

drop policy if exists trips_delete on public.trips;
create policy trips_delete on public.trips
  for delete to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin());

-- ---------------------------------------------------------------------------
-- expenses  (identical shape to trips)
-- ---------------------------------------------------------------------------
drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check (ba_id = auth.uid() and status = 'draft');

drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses
  for update to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('draft','submitted')) or public.is_admin());

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses
  for delete to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin());

-- ---------------------------------------------------------------------------
-- submissions
--   read   : own or admin
--   insert : own (open/submitted)
--   update : own up to 'submitted'; admin approve/reject
-- ---------------------------------------------------------------------------
drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions
  for insert to authenticated
  with check ((ba_id = auth.uid() and status in ('open','submitted')) or public.is_admin());

drop policy if exists submissions_update on public.submissions;
create policy submissions_update on public.submissions
  for update to authenticated
  using ((ba_id = auth.uid() and status in ('open','submitted','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('open','submitted')) or public.is_admin());

-- ---------------------------------------------------------------------------
-- distance_cache  (own rows only; written by the calc-distance service role)
-- ---------------------------------------------------------------------------
drop policy if exists distance_cache_select on public.distance_cache;
create policy distance_cache_select on public.distance_cache
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

-- ===========================================================================
-- Storage : private buckets for receipt + odometer photos
-- Objects are keyed  <ba_id>/<uuid>.jpg  so the first path segment == owner.
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('receipts','receipts', false), ('odometer','odometer', false)
on conflict (id) do nothing;

-- a BA can read/write only objects under their own <ba_id>/ prefix
drop policy if exists storage_ba_rw on storage.objects;
create policy storage_ba_rw on storage.objects
  for all to authenticated
  using (
    bucket_id in ('receipts','odometer')
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id in ('receipts','odometer')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- admins can read every receipt/odometer object (for review + export)
drop policy if exists storage_admin_read on storage.objects;
create policy storage_admin_read on storage.objects
  for select to authenticated
  using (bucket_id in ('receipts','odometer') and public.is_admin());
