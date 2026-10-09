-- BA app: CC Amanda on the daily reimbursement reminders for her CA team (2026-10-09).
-- Gianni: "set Amanda as the manager of jesse, joanna, cesar, makenna, and leticia ... cc her
-- when any of them submit their reimbursements or receive a reminder email".
-- Viewing/approving and the submitted-email CC need no change: Amanda is a universal admin
-- (role admin, region null), so admin_sees_ba() is true for every BA, and her home_region CA
-- makes regionCcList() CC her on every CA BA's submitted/approved email. Only the reminder
-- CC is per person (profiles.reminder_cc). Appends without duplicates; existing CCs stay.
update public.profiles
   set reminder_cc = coalesce(reminder_cc, '{}') || array['amanda@wizardtrees.com']
 where email in ('jesse@wizardtrees.com','joanna@wizardtrees.com','cesar@wizardtrees.com',
                 'makenna@wizardtrees.com','leticia@wizardtrees.com')
   and not ('amanda@wizardtrees.com' = any(coalesce(reminder_cc, '{}')));
