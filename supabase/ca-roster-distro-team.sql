-- CA Labor Tracker: "Gusto distro" people (Gianni, 2026-09-26).
-- A person's DISTRO hours can be paid through Gusto while they stay on their crew (e.g. Lucero Torres stays on
-- Norma's Team for deleaf). The flag drives the views, not the row's team:
--   Gusto Distro view  = every distro row of a flagged person (overlaps Justin's Team: Drea, Thanh, Barry)
--   Norma's Team views = Norma's crew minus distro rows of flagged people
-- Read by labor-calculator.html and ~/gusto-sync/import-ca-packagers.mjs (which flags Gusto Distro Packagers).
alter table public.distro_roster drop column if exists distro_team;   -- first draft, never used by any code
alter table public.distro_roster add column if not exists gusto_distro boolean not null default false;
