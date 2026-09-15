-- ============================================================================
--  NY Labor Tracker · roster keyed to Gusto · 2026-09-15
-- ----------------------------------------------------------------------------
--  Kelsey: "the labor tracker isn't pulling new employees' hours from Gusto.
--  Essence started yesterday but I'm not seeing her hours." The tracker only
--  imports people on ny_roster (by design: the roster IS the distro crew), so a
--  new hire is invisible until someone adds them by hand. Nobody knew that step
--  existed.
--
--  From now on the hourly Gusto pull (~/gusto-sync/gusto-api.mjs) keeps the
--  roster in step with Gusto's "Distro Hourly" department: new hires are added
--  with their Gusto title and rate, terminations are deactivated, and a rate
--  that drifts from Gusto is reported in the log. gusto_uuid is the identity
--  (names can be respelled on the Roster page without breaking the link);
--  gusto_synced_at says when the sync last touched the row.
--
--  Applied to dhiqhgtmelxwelyoowle 2026-09-15. Safe to re-run.
-- ============================================================================
alter table public.ny_roster add column if not exists gusto_uuid text;
alter table public.ny_roster add column if not exists gusto_synced_at timestamptz;
create unique index if not exists ny_roster_gusto_uuid_ux on public.ny_roster (gusto_uuid) where gusto_uuid is not null;
comment on column public.ny_roster.gusto_uuid is
  'Gusto employee uuid. Set by the hourly pull (roster-sync.mjs); the roster row it belongs to '
  'follows renames on the Roster page. NULL = added by hand and not yet matched to Gusto.';
select column_name from information_schema.columns where table_name='ny_roster' and column_name like 'gusto%';
