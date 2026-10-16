-- BA app: CA schedule access (BA visits + driver deliveries) for Lorenzo Amado, Justin Nguyen and
-- Nouri Ayoub (Victoria, 2026-10-16: "give BA + Driver schedule access to Lorenzo justin and Nouri").
-- All three already have Google sign-in accounts. The CA board is visible to active profiles with
-- region CA (schedule_can_see). They aren't brand ambassadors: non_ba = no submit reminders, any
-- expense they log is filed as Non-BA activity, and they stay out of BA reports (same as Carlos).
-- NOTE: the BA app signs in with email + password only (no Google button); their Google accounts are
-- from the other apps on this project. After this update each was sent the app's welcome email
-- (ba-notify job 'invite': fresh temporary password, must_change_password = true).
update public.profiles
   set region = 'CA', active = true, non_ba = true
 where email in ('lorenzo@wizardtrees.com', 'justin@wizardtrees.com', 'nouri@wizardtrees.com');
