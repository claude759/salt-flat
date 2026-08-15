-- ── Schedule board exceptions ───────────────────────────────────────────────
-- Access is normally by profiles.region (migrate-schedule-region-access.sql): CA staff
-- see the CA board, NY staff see NY, and only Universal Admins see both — which is what
-- makes the CA/NY switcher appear, since the switcher is derived from "can you see more
-- than one board", never from a hardcoded name.
--
-- THIS FILE is the deliberate exception list: people who need a board outside their own
-- region without being made a Universal Admin. Keep it small and keep the reason next to
-- each entry — every row here is someone whose access no longer follows the org chart.
--
-- NOTE: re-running migrate-schedule-region-access.sql empties allowed_emails, which wipes
-- these grants. Re-run THIS file after it. (Both are idempotent.)
--
-- What a board grant actually carries, beyond seeing the calendar:
--   • the board's workbook_id — the de-facto secret for a link-shared Google Sheet;
--   • read AND write/delete on that board's schedule_tasks (schedule_tasks_* policies
--     are scoped by schedule_states(), not by role).
-- It does NOT grant the 🛟 Backup & restore panel or any admin screen — those check
-- role='admin' separately. Deactivating the person still revokes everything.

-- Amanda Majlessi (CA BA) — needs the NY board too, so the CA/NY switcher appears for her.
-- She keeps CA through her own region; this adds NY on top.
update public.schedule_board
   set allowed_emails = (
         select array(select distinct e from unnest(allowed_emails || array['amanda@wizardtrees.com']) e)),
       updated_at = now()
 where state = 'NY'
   and not ('amanda@wizardtrees.com' = any(allowed_emails));

-- Verify (expect Amanda → CA,NY):
--   select p.full_name, p.region,
--     coalesce((select string_agg(b.state, ',' order by b.state) from public.schedule_board b
--       where p.active and (lower(p.email) = any(b.allowed_emails)
--         or (p.role='admin' and p.region is null) or b.state = p.region)), '(none)') as boards
--   from public.profiles p where p.active order by boards, p.full_name;
--
-- To revoke:
--   update public.schedule_board
--      set allowed_emails = array_remove(allowed_emails,'amanda@wizardtrees.com')
--    where state='NY';
