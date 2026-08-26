-- Let tracker STAFF request and watch "pull from Gusto now" (2026-08-26).
-- Until now only BA-app admins (is_admin) could — but the person who notices
-- stale timecards is Kelsey, who signs into the NY Labor Tracker as staff.
-- Staff may INSERT a request (only as themselves) and SELECT to watch progress;
-- updating/completing stays with is_admin (the sync worker + BA admins).
create policy gusto_pull_staff_select on public.gusto_pull_requests
  for select to authenticated using (public.is_staff());
create policy gusto_pull_staff_insert on public.gusto_pull_requests
  for insert to authenticated with check (public.is_staff() and requested_by = auth.uid());
