-- ============================================================================
--  Distro / Labor Tracker  ·  PHASE 4 schema  ·  LP Units cutover + roster UI
-- ----------------------------------------------------------------------------
--  Idempotent (safe to re-run). Same conventions as distro-tracker-phase0.sql:
--  strictly ADDITIVE on the shared project dhiqhgtmelxwelyoowle, everything
--  namespaced packaging_/distro_, staff-gated by the existing is_staff().
--
--  packaging_units_days replaces the "Labor _ Packaging Units" Google Sheet:
--  one row per day. Pre-roll counts are stored PRE-SPLIT into 1.5g vs 1g
--  columns (the sheet kept a combined "1.5g/1.0g" column that the app split
--  at render time by date rules — that quirk dies with the sheet; the split
--  is baked in at import). Day totals / units-per-hour / pounds are STORED:
--  for imported history they are the sheet's own authored values (not always
--  derivable — the sheet's formulas had quirks), and the app recomputes them
--  whenever a day is edited in-app.
--
--  source: 'import' = came from a sheet import (the frozen sheet era, plus
--  any future re-drop of an export); 'edit' = a day born in the app — either
--  typed fresh or an auto-derived-from-Tasks day that someone edited
--  ("materialized"). Deleting an 'edit' row returns that date to live
--  Tasks-derived values; 'import' rows are the end of the line (no fallback).
-- ============================================================================

create table if not exists public.packaging_units_days (
  work_date       date primary key,
  -- unit counts, in the page's column order
  p15_prod        numeric(12,2),      -- 1.5g pre-roll produced
  p15_pre         numeric(12,2),      -- 1.5g pre-COA labeled
  p15_post        numeric(12,2),      -- 1.5g post-COA labeled
  p10_prod        numeric(12,2),      -- 1g pre-roll produced
  p10_pre         numeric(12,2),
  p10_post        numeric(12,2),
  pk5_prod        numeric(12,2),      -- 5pk (.7g) pre-roll, counted as single 0.7g units
  pk5_pre         numeric(12,2),
  pk5_post        numeric(12,2),
  jar_rec_pack    numeric(12,2),      -- 3.5g jar (rec)
  jar_rec_label   numeric(12,2),
  bud_pack        numeric(12,2),      -- budtender samples (rec, weighed at 1.5g)
  bud_label       numeric(12,2),
  jar_void_pack   numeric(12,2),      -- 3.5g jar (void)
  jar_void_label  numeric(12,2),
  pouch_pack      numeric(12,2),      -- 3.5g pouch (void)
  pouch_label     numeric(12,2),
  prep            numeric(12,2),      -- pouch prep
  hours           numeric(8,2),       -- day labor hours (sheet: daily-log crew totals; derived: task man-hours)
  ppl             numeric(6,2),       -- day crew size
  -- stored day rollups (sheet-authored for imports; recomputed by the app on edit)
  tot_rec_pack    numeric(12,2),
  tot_rec_label   numeric(12,2),
  tot_void_pack   numeric(12,2),
  tot_void_label  numeric(12,2),
  tot_prep        numeric(12,2),
  uph             numeric(16,6),      -- units handled per hour (incl. prepped; wide — an hours typo like 0.01 must not overflow the save)
  lbs_rec_pack    numeric(12,6),
  lbs_rec_label   numeric(12,6),
  lbs_void_pack   numeric(12,6),
  lbs_void_label  numeric(12,6),
  source          text not null default 'import' check (source in ('import','edit')),
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now()
);

-- retro-widen for projects that ran the first cut of this file (idempotent)
alter table public.packaging_units_days alter column uph type numeric(16,6);

-- keep updated_at honest (touch_updated_at ships in phase 0)
drop trigger if exists trg_pkg_units_touch on public.packaging_units_days;
create trigger trg_pkg_units_touch before insert or update on public.packaging_units_days
  for each row execute function public.touch_updated_at();

-- ---- Row-level security: staff full CRUD, same as the other tracker tables --
alter table public.packaging_units_days enable row level security;
drop policy if exists packaging_units_days_staff_all on public.packaging_units_days;
create policy packaging_units_days_staff_all on public.packaging_units_days
  for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- ---- Realtime: LP edits + roster edits push live to every open tab ----------
do $$
declare t text;
begin
  foreach t in array array['packaging_units_days','distro_roster'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

select 'distro-tracker phase 4 ready' as result;
