-- ============================================================================
--  Distro / Labor Tracker  ·  PHASE 0 schema  ·  REVIEW ONLY — DO NOT APPLY YET
-- ----------------------------------------------------------------------------
--  Idempotent (safe to re-run). Mirrors the BA app's convention: paste into the
--  Supabase dashboard SQL editor once signed off.
--
--  Project:  dhiqhgtmelxwelyoowle   (SHARED with the BA app — this file is
--            strictly ADDITIVE and never touches BA objects)
--
--  Namespacing: every object is distro_ / packaging_ / labor_ so nothing
--  collides with the BA app's existing  hours / labor_kinds / pay_periods.
--
--  Auth model: Google sign-in restricted to @wizardtrees.com. This tracker is
--  an internal ops tool for trusted office staff, so row security is simple —
--  any signed-in @wizardtrees.com user may read and write. We gate on the JWT
--  email claim and reference auth.users directly, so NOTHING here depends on or
--  modifies the BA app's profiles / role model or its handle_new_user trigger.
--
--  >>> DASHBOARD STEPS (done at apply time, NOT part of this SQL):
--    1. Authentication → Providers → Google → enable; paste the OAuth client
--       id/secret from the Google Cloud "Wizard Trees Tools" project.
--    2. Restrict to the wizardtrees.com hosted domain in the Google OAuth
--       consent screen. is_staff() below is the hard data-layer gate: it
--       requires a CONFIRMED @wizardtrees.com mailbox, so an unverified or
--       non-wizardtrees session can read/write nothing regardless of settings.
--    3. Leave "Allow new users to sign up" as the BA app already set it; the
--       domain gate does not rely on that toggle (it checks email_confirmed_at,
--       so a self-registered unconfirmed @wizardtrees.com address won't pass).
-- ============================================================================

-- ---- staff gate: a signed-in, email-CONFIRMED @wizardtrees.com user --------
--   Reads auth.users (not the raw JWT claim) so a self-registered but
--   unconfirmed "anyone@wizardtrees.com" cannot pass. Google Workspace logins
--   already have email_confirmed_at set, so intended access is unaffected. The
--   anchored '%@wizardtrees.com' suffix rejects subdomain/suffix spoofs; the
--   security-definer + fixed search_path lets it read auth.users safely.
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and lower(u.email) like '%@wizardtrees.com'
    -- to pin to Google sign-in only, also require:
    --   and (u.raw_app_meta_data ->> 'provider') = 'google'
  )
$$;

-- ---- distro_roster: the packaging crew (data rows, NOT auth users) ----------
create table if not exists public.distro_roster (
  id              uuid primary key default gen_random_uuid(),
  last            text,               -- nullable: harvest workers may be first-name only
  first           text not null,
  full_name       text,
  team            text,               -- "Norma's Team" / "Justin's Team"
  default_company text,               -- Filifera / Portal
  default_rate    numeric(8,2),
  aliases         text[],
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ---- distro_shifts: one clock-in/out per person per day (was: entries) ------
create table if not exists public.distro_shifts (
  id            uuid primary key default gen_random_uuid(),
  category      text not null default 'distro' check (category in ('distro','harvest')),
  work_date     date not null,
  company       text,
  team          text,
  roster_id     uuid references public.distro_roster(id) on delete set null,
  last          text,                 -- name snapshot (import + display without a join)
  first         text,
  clock_in      time,
  clock_out     time,
  break_minutes int  not null default 0,
  hours         numeric(7,3)  not null default 0,   -- trigger-owned (see below)
  rate          numeric(8,2)  not null default 0,
  total         numeric(10,2) not null default 0,   -- trigger-owned
  source        text not null default 'manual' check (source in ('manual','ocr','import')),
  photo_path    text,                 -- Storage: timesheets/<uuid>.jpg
  note          text,
  updated_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists distro_shifts_date_ix on public.distro_shifts(work_date);

-- ---- packaging_tasks: ONE ROW PER TASK (replaces the tracker_days JSON blob)-
--   Normalizing here is what ends the phantom-day + last-writer-wins-blob class
--   of bug: a blank task is simply never inserted, and two people editing the
--   same day touch different rows instead of racing over one document.
create table if not exists public.packaging_tasks (
  id          uuid primary key default gen_random_uuid(),
  work_date   date not null,
  task        text not null,          -- "5pk (.7g) pre-roll produced(rec)"
  people      int,
  begin_at    time,
  end_at      time,
  packaged    int,
  labeled     int,
  seconds     int,
  hours       numeric(7,3),
  cost        numeric(10,2),
  note        text,
  updated_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists packaging_tasks_date_ix on public.packaging_tasks(work_date);

-- ---- packaging_notes: the Labor/Packaging notes column ----------------------
create table if not exists public.packaging_notes (
  work_date   date primary key,
  note        text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

-- ---- labor_history: read-only historical rows (old Combined tab backfill) ---
--   Loaded once by the service role in Phase 1 (with the 1g corrections baked
--   in). Staff read only; no client writes.
create table if not exists public.labor_history (
  id         bigint generated always as identity primary key,
  work_date  date not null,
  task       text not null,
  people     int,
  begin_at   time,
  end_at     time,
  seconds    int,
  hours      numeric(7,3),
  packaged   int,
  labeled    int,
  cost       numeric(10,2),
  note       text
);
create index if not exists labor_history_date_ix on public.labor_history(work_date);

-- retro-relax for projects created before the rule changed (idempotent)
alter table public.distro_roster alter column last drop not null;

-- ---- shift fidelity columns (added for the Phase 1 import) ------------------
--   people: harvest rows record a crew size and pay hours × rate × people
--   pay_period: the Hours app's optional period tag
--   source_id: the original sheet row id — makes re-imports idempotent
alter table public.distro_shifts add column if not exists people int not null default 1;
alter table public.distro_shifts add column if not exists pay_period date;
alter table public.distro_shifts add column if not exists source_id text;
create unique index if not exists distro_shifts_source_id_ux
  on public.distro_shifts(source_id) where source_id is not null;

-- ---- server-owned hours & total on shifts (mirrors the BA money pattern) ----
create or replace function public.distro_shift_calc()
returns trigger language plpgsql as $$
declare mins int;
begin
  if new.clock_in is not null and new.clock_out is not null then
    mins := (extract(epoch from (new.clock_out - new.clock_in)) / 60)::int;
    if mins < 0 then mins := mins + 24*60; end if;      -- overnight guard on the RAW span
    mins := mins - coalesce(new.break_minutes, 0);       -- subtract break AFTER the guard
    if mins < 0 then mins := 0; end if;                  -- an over-long break floors at 0, never inflates
    new.hours := round(mins / 60.0, 3);
  else
    new.hours := 0;
  end if;
  new.total := round(coalesce(new.hours,0) * coalesce(new.rate,0) * coalesce(new.people,1), 2);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_distro_shift on public.distro_shifts;
create trigger trg_distro_shift before insert or update on public.distro_shifts
  for each row execute function public.distro_shift_calc();

-- ---- keep updated_at honest on the other editable tables --------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_pkg_task_touch on public.packaging_tasks;
create trigger trg_pkg_task_touch before insert or update on public.packaging_tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_pkg_note_touch on public.packaging_notes;
create trigger trg_pkg_note_touch before insert or update on public.packaging_notes
  for each row execute function public.touch_updated_at();

-- ---- Row-level security -----------------------------------------------------
alter table public.distro_roster   enable row level security;
alter table public.distro_shifts   enable row level security;
alter table public.packaging_tasks enable row level security;
alter table public.packaging_notes enable row level security;
alter table public.labor_history   enable row level security;

-- roster / shifts / tasks / notes: full read + write for @wizardtrees staff
do $$
declare t text;
begin
  foreach t in array array['distro_roster','distro_shifts','packaging_tasks','packaging_notes'] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I for all to authenticated '
      || 'using (public.is_staff()) with check (public.is_staff())', t, t);
  end loop;
end $$;

-- labor_history: staff read only; writes happen via the service role (import)
drop policy if exists labor_history_staff_read on public.labor_history;
create policy labor_history_staff_read on public.labor_history
  for select to authenticated using (public.is_staff());

-- ---- Realtime: push task / shift / note edits live to every open tab --------
--   (guarded so re-running this file doesn't error on already-published tables)
do $$
declare t text;
begin
  foreach t in array array['packaging_tasks','distro_shifts','packaging_notes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---- Storage: private bucket for timesheet photos ---------------------------
--   Same idempotent pattern as the BA app's receipts/odometer buckets. Staff
--   read/write, scoped strictly to this bucket so the BA buckets are untouched.
insert into storage.buckets (id, name, public)
values ('timesheets','timesheets', false)
on conflict (id) do nothing;

drop policy if exists timesheets_staff_rw on storage.objects;
create policy timesheets_staff_rw on storage.objects for all to authenticated
  using (bucket_id = 'timesheets' and public.is_staff())
  with check (bucket_id = 'timesheets' and public.is_staff());

select 'distro-tracker phase 0 ready' as result;
