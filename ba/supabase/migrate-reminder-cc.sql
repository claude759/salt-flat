-- ── reminder_cc: extra people to CC on ONE person's reminder ───────────────
-- The pay-period reminder CCs the admin address and nobody else. Some BAs are
-- chased by a lead rather than by Gianni directly (Joanna keeps an eye on Leti's
-- submissions), and that is per-person, not per-region — so it belongs on the
-- profile rather than in the notification scope rules.
--
-- Empty for everyone else, so no other reminder changes.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

alter table public.profiles add column if not exists reminder_cc text[] not null default '{}';
comment on column public.profiles.reminder_cc is
  'Extra addresses CC''d on THIS person''s pay-period reminder, on top of the admin '
  'address. Use for a lead who follows up on someone''s submissions. Lowercase.';

update public.profiles
   set reminder_cc = array['joanna@wizardtrees.com']
 where email = 'leticia@wizardtrees.com'
   and not ('joanna@wizardtrees.com' = any(reminder_cc));

-- Verify:
--   select full_name, reminder_cc from public.profiles where cardinality(reminder_cc) > 0;
