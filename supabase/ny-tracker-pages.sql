-- ============================================================================
--  Wizard Trees NY Labor Tracker · TASKS / PACKAGING / NOTES · 2026-07-21
-- ----------------------------------------------------------------------------
--  Idempotent (safe to re-run). Additive on the shared project
--  dhiqhgtmelxwelyoowle, namespaced ny_, touching nothing else.
--
--  The NY app is getting the CA app's other pages back — Tasks, Labor/Packaging
--  (LP Units) and Reports — so it needs NY's own copies of the three tables
--  those pages read and write. They start EMPTY: NY's task and packaging
--  numbers are NY's, and the CA tables (packaging_tasks / packaging_notes /
--  packaging_units_days) are never read or written by the NY app.
--
--  Columns mirror the CA originals exactly (distro-tracker-phase0.sql and
--  distro-tracker-phase4.sql), so the page code ports across as-is.
-- ============================================================================

-- ---- ny_tasks: one row per task per day (never a per-day JSON blob) ---------
create table if not exists public.ny_tasks (
  id          uuid primary key default gen_random_uuid(),
  work_date   date not null,
  task        text not null,
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
create index if not exists ny_tasks_date_ix on public.ny_tasks(work_date);

-- ---- ny_notes: the Labor/Packaging notes column ----------------------------
create table if not exists public.ny_notes (
  work_date   date primary key,
  note        text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

-- ---- ny_units_days: the LP Units page, one row per day ---------------------
--   NY runs 1g pre-rolls and .7g 5-packs only, and doesn't split rec from void,
--   so this drops CA's 1.5g pre-roll columns and its per-market jar/total/pound
--   columns in favour of one packed / labeled pair.
create table if not exists public.ny_units_days (
  work_date       date primary key,
  p10_prod        numeric(12,2),
  p10_pre         numeric(12,2),
  p10_post        numeric(12,2),
  pk5_prod        numeric(12,2),
  pk5_pre         numeric(12,2),
  pk5_post        numeric(12,2),
  jar_pack        numeric(12,2),
  jar_label       numeric(12,2),
  bud_pack        numeric(12,2),
  bud_label       numeric(12,2),
  pouch_pack      numeric(12,2),
  pouch_label     numeric(12,2),
  prep            numeric(12,2),
  hours           numeric(8,2),
  ppl             numeric(6,2),
  tot_pack        numeric(12,2),
  tot_label       numeric(12,2),
  tot_prep        numeric(12,2),
  uph             numeric(16,6),
  lbs_pack        numeric(12,6),
  lbs_label       numeric(12,6),
  source          text not null default 'edit' check (source in ('import','edit')),
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now()
);

-- reshape for projects that ran the first cut of this file (the table is only
-- ever empty at that point, so dropping the unused market columns is safe)
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='ny_units_days' and column_name='jar_rec_pack') then
    alter table public.ny_units_days
      drop column if exists p15_prod,      drop column if exists p15_pre,
      drop column if exists p15_post,      drop column if exists jar_void_pack,
      drop column if exists jar_void_label,
      drop column if exists tot_void_pack, drop column if exists tot_void_label,
      drop column if exists lbs_void_pack, drop column if exists lbs_void_label;
    alter table public.ny_units_days rename column jar_rec_pack  to jar_pack;
    alter table public.ny_units_days rename column jar_rec_label to jar_label;
    alter table public.ny_units_days rename column tot_rec_pack  to tot_pack;
    alter table public.ny_units_days rename column tot_rec_label to tot_label;
    alter table public.ny_units_days rename column lbs_rec_pack  to lbs_pack;
    alter table public.ny_units_days rename column lbs_rec_label to lbs_label;
  end if;
end $$;

-- ---- ny_labor_history: NY's own frozen-history table -----------------------
--   The CA app reads labor_history for its pre-cutover rows. NY has no history
--   to freeze, but the page code expects the table, and pointing NY at the CA
--   one would put California numbers on New York's Reports page. So: NY's own,
--   empty, staff-read-only (writes would come from a service-role backfill).
create table if not exists public.ny_labor_history (
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
create index if not exists ny_labor_history_date_ix on public.ny_labor_history(work_date);
alter table public.ny_labor_history enable row level security;
drop policy if exists ny_labor_history_staff_read on public.ny_labor_history;
create policy ny_labor_history_staff_read on public.ny_labor_history
  for select to authenticated using (public.is_staff());

-- touch_updated_at ships in the CA phase 0 and is shared, not redefined here
drop trigger if exists trg_ny_task_touch on public.ny_tasks;
create trigger trg_ny_task_touch before insert or update on public.ny_tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_ny_note_touch on public.ny_notes;
create trigger trg_ny_note_touch before insert or update on public.ny_notes
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_ny_units_touch on public.ny_units_days;
create trigger trg_ny_units_touch before insert or update on public.ny_units_days
  for each row execute function public.touch_updated_at();

-- ---- Row-level security: same staff gate as every other tracker table ------
alter table public.ny_tasks      enable row level security;
alter table public.ny_notes      enable row level security;
alter table public.ny_units_days enable row level security;
do $$
declare t text;
begin
  foreach t in array array['ny_tasks','ny_notes','ny_units_days'] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I for all to authenticated '
      || 'using (public.is_staff()) with check (public.is_staff())', t, t);
  end loop;
end $$;

-- ---- Realtime: edits land in every open tab -------------------------------
do $$
declare t text;
begin
  foreach t in array array['ny_tasks','ny_notes','ny_units_days'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

select 'ny tracker pages ready' as result,
       (select count(*) from public.ny_labor_history) as history,
       (select count(*) from public.ny_tasks)      as tasks,
       (select count(*) from public.ny_notes)      as notes,
       (select count(*) from public.ny_units_days) as unit_days;
