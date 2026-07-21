-- ============================================================================
--  Wizard Trees NY Labor Tracker · PHASE 0 · 2026-07-21
-- ----------------------------------------------------------------------------
--  Idempotent (safe to re-run). Strictly ADDITIVE on the SHARED Supabase
--  project dhiqhgtmelxwelyoowle, which also hosts the BA field app and the CA
--  tracker (distro_* / packaging_* / labor_history). Everything here is
--  namespaced ny_ and touches nothing else.
--
--  Auth: reuses the existing public.is_staff() (confirmed @wizardtrees.com
--  email) — NY managers use the same Google accounts, zero new auth work.
--
--  Data source: hours will be pulled from GUSTO by a sync job (like the BA
--  app's gusto-sync) writing rows with source='import' and source_id set to
--  the Gusto record key so re-imports are idempotent. Manual corrections are
--  typed in the app (source='manual').
--
--  CAVEAT on "idempotent": re-running the roster seed at the bottom RESURRECTS
--  anyone deleted through the app (the fixed UUIDs only stop duplicates, not
--  re-inserts). Deactivate people in the app instead of deleting them, or drop
--  the seed block before a re-run.
-- ============================================================================

create table if not exists public.ny_roster (
  id              uuid primary key default gen_random_uuid(),
  last            text,
  first           text not null,
  full_name       text,
  team            text,
  default_company text,
  default_rate    numeric(8,2),
  aliases         text[],
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists public.ny_shifts (
  id            uuid primary key default gen_random_uuid(),
  -- NY has a single hours log. Keep this to 'distro' so no row can exist that
  -- the UI cannot show (a stray 'harvest' row would be hidden from the log but
  -- still counted in By Person totals). Widen deliberately if NY ever splits.
  category      text not null default 'distro' check (category in ('distro')),
  work_date     date not null,
  company       text,
  team          text,
  roster_id     uuid references public.ny_roster(id) on delete set null,
  last          text,
  first         text,
  clock_in      time,
  clock_out     time,
  break_minutes int  not null default 0,
  hours         numeric(7,3)  not null default 0,   -- trigger-owned
  rate          numeric(8,2)  not null default 0,
  total         numeric(10,2) not null default 0,   -- trigger-owned
  people        int not null default 1,
  pay_period    date,
  source_id     text,
  overlap_ok    boolean not null default false,
  source        text not null default 'manual' check (source in ('manual','ocr','import','notes')),
  photo_path    text,
  note          text,
  updated_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ny_shifts_date_ix on public.ny_shifts(work_date);
-- NOT partial on purpose: PostgREST/supabase-js upsert needs a plain unique
-- index as its on-conflict arbiter, and Postgres already treats NULL source_id
-- (every manual row) as distinct, so manual rows are unconstrained either way.
drop index if exists public.ny_shifts_source_id_ux;
create unique index if not exists ny_shifts_source_id_ux
  on public.ny_shifts(source_id);

-- retro-fix for projects that ran the first cut of this file (idempotent)
do $$
begin
  if exists (select 1 from pg_constraint
             where conrelid = 'public.ny_shifts'::regclass and conname = 'ny_shifts_category_check'
               and pg_get_constraintdef(oid) like '%harvest%') then
    alter table public.ny_shifts drop constraint ny_shifts_category_check;
    alter table public.ny_shifts add constraint ny_shifts_category_check check (category in ('distro'));
  end if;
end $$;

-- own copy of the pay math so NY can diverge from CA later without coupling:
-- overnight guard on the raw span -> subtract break -> floor at 0.
-- KEEP THIS BODY IN SYNC WITH ny-tracker-gusto.sql — both files define this
-- function, so whichever runs last wins.
create or replace function public.ny_shift_calc()
returns trigger language plpgsql as $$
declare mins int;
begin
  if new.clock_in is not null and new.clock_out is not null then
    mins := (extract(epoch from (new.clock_out - new.clock_in)) / 60)::int;
    if mins < 0 then mins := mins + 24*60; end if;
    mins := mins - coalesce(new.break_minutes, 0);
    if mins < 0 then mins := 0; end if;
    new.hours := round(mins / 60.0, 3);
  elsif new.source = 'import' then
    new.hours := coalesce(new.hours, 0);   -- paid leave has no punches; the importer's number stands
  else
    new.hours := 0;
  end if;
  new.total := round(coalesce(new.hours,0) * coalesce(new.rate,0) * coalesce(new.people,1), 2);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_ny_shift on public.ny_shifts;
create trigger trg_ny_shift before insert or update on public.ny_shifts
  for each row execute function public.ny_shift_calc();

-- ---- Row-level security: staff full CRUD, same pattern as the CA tracker ---
alter table public.ny_roster enable row level security;
alter table public.ny_shifts enable row level security;
do $$
declare t text;
begin
  foreach t in array array['ny_roster','ny_shifts'] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I for all to authenticated '
      || 'using (public.is_staff()) with check (public.is_staff())', t, t);
  end loop;
end $$;

-- ---- Realtime: push edits live to every open tab ---------------------------
do $$
declare t text;
begin
  foreach t in array array['ny_shifts','ny_roster'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---- Roster seed: FIRST RUN ONLY -----------------------------------------
--   The crew lives in ny-roster-distro-crew.sql, which is the file to edit.
--   This block is deliberately gated on an EMPTY table: an early version seeded
--   all 18 people from the Gusto rate export, and re-running it to repair
--   something kept re-inserting people Gianni had deliberately removed. A seed
--   must never undo a person's edits.
insert into public.ny_roster (id, last, first, team, default_company, default_rate, active)
select * from (values
  ('bee00001-0000-4000-8000-000000000004'::uuid,'D''Haiti',        'Murphy','Packaging Tech',      'Wizard Trees NY', 23.00, true),
  ('bee00001-0000-4000-8000-000000000008'::uuid,'Gomez-Sarmiento','Leslie','Packaging Tech',      'Wizard Trees NY', 23.00, true),
  ('bee00001-0000-4000-8000-000000000010'::uuid,'Gonzalez',       'George','Packaging Tech',      'Wizard Trees NY', 23.00, true),
  ('bee00001-0000-4000-8000-000000000012'::uuid,'Herrera',        'Luis',  'Packaging Tech',      'Wizard Trees NY', 23.00, true),
  ('bee00001-0000-4000-8000-000000000014'::uuid,'Marcial',        'Harry', 'Packaging Tech',      'Wizard Trees NY', 23.00, true),
  ('bee00001-0000-4000-8000-000000000018'::uuid,'Velazquez',      'Irene', 'Packaging Tech',      'Wizard Trees NY', 23.00, true)
) as v(id, last, first, team, default_company, default_rate, active)
where not exists (select 1 from public.ny_roster);

select 'ny tracker phase 0 ready' as result,
       (select count(*) from public.ny_roster) as roster_rows;
