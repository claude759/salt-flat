-- BA app: close the public post-visit report feed (2026-11-24, Gianni: "yes close this").
--
-- ba_activity_feed() was added in August (ba/supabase/migrate-ba-activity.sql) as a public projection for the sales
-- app, which never used it. It let anyone holding the public page key read 400 days of post-visit reports (BA names,
-- stores, shelf and stock notes, next steps) with no sign-in, around the access rule that limits reports to admins
-- and the people on that report's board. Nothing in the repo or the jobs on Gianni's Mac calls it.
-- The function stays; only the service role may run it. To open it again: grant execute on function
-- public.ba_activity_feed() to anon, authenticated;  Safe to run again.

revoke all on function public.ba_activity_feed() from public, anon, authenticated;
grant execute on function public.ba_activity_feed() to service_role;
