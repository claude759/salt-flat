-- Schedule board access = YOUR REGION. (2026-08-13)
--
-- Every CA employee sees the CA schedule, every NY employee sees the NY schedule, and only
-- Universal Admins (role='admin' with no region — Gianni + Victoria) see both and therefore
-- get the CA/NY switcher. That was already true via the region branch; this migration retires
-- the hardcoded email allowlist that sat in front of it.
--
-- Why retire it: the lists had become pure duplication of the region rule (every address on
-- them already had the matching region), while carrying two failure modes —
--   • moving someone CA→NY changed their region but left them on the old board's list, so
--     they kept seeing the schedule they no longer work from;
--   • revoking access meant hand-editing a SQL array, since no admin UI writes this column.
-- Region is set in Admin → Users, so access now follows the org chart automatically and a new
-- hire needs no SQL at all.
--
-- The column stays (empty) as a deliberate per-board exception hatch — e.g. lending a CA lead
-- temporary NY visibility — but it is no longer load-bearing for anyone, and it is still gated
-- on `active` by schedule_can_see() so an exception can never outlive an offboarding.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

update public.schedule_board set allowed_emails = '{}'
 where coalesce(array_length(allowed_emails, 1), 0) > 0;

comment on column public.schedule_board.allowed_emails is
  'Optional per-board exceptions, normally EMPTY. Access is by profiles.region (see '
  'schedule_can_see); add an address here only to grant someone a board outside their own region.';

-- Verify — expect CA staff→CA, NY staff→NY, Gianni/Victoria→CA,NY, FL/no-region→none:
--   select p.full_name, p.region,
--     coalesce((select string_agg(b.state, ',' order by b.state) from public.schedule_board b
--       where p.active and (lower(p.email) = any(b.allowed_emails)
--         or (p.role='admin' and p.region is null) or b.state = p.region)), '(none)') as boards
--   from public.profiles p where p.active order by boards, p.full_name;
