-- BA app: close the public-key hole in the schedule backup and period-reopen functions (found 2026-11-11).
-- schedule_restore, schedule_restore_json, schedule_restore_rows, schedule_snapshot and unsubmit_period treat a caller with no signed-in user
-- as trusted (the SQL editor's break-glass path), but the pages' public key (anon) could call them as well, so anyone on
-- the internet could overwrite a state's schedule from a backup or with rows of their own, or reopen a BA's submitted period. After this, only
-- signed-in people (whose admin check inside each function then applies), the server (service_role) and the SQL editor
-- (postgres, the owner) can call them. The BA app calls schedule_restore, schedule_restore_json and schedule_snapshot, always signed in.
-- Safe to re-run.

revoke execute on function public.schedule_restore(bigint) from public, anon;
revoke execute on function public.schedule_restore_json(text, jsonb) from public, anon;
revoke execute on function public.schedule_restore_rows(text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.schedule_snapshot(text, text, text) from public, anon;
revoke execute on function public.unsubmit_period(uuid, uuid) from public, anon;

grant execute on function public.schedule_restore(bigint) to authenticated, service_role;
grant execute on function public.schedule_restore_json(text, jsonb) to authenticated, service_role;
grant execute on function public.schedule_snapshot(text, text, text) to authenticated, service_role;
grant execute on function public.unsubmit_period(uuid, uuid) to authenticated, service_role;
grant execute on function public.schedule_restore_rows(text, jsonb, text) to service_role;
