-- ── More per-person reminder CCs ───────────────────────────────────────────
-- Leads who follow up on someone's submissions get CC'd on that person's reminder:
--   • Maddy  → every NY field worker's reminder (she runs the region). Never her own:
--              ccFor() drops the recipient's own address, so she is a CC on the other
--              four NY people and still receives her own reminder as a recipient.
--   • Amanda → Joanna's reminder.
--   • Joanna → Leti's reminder (set earlier, preserved here).
--
-- Appended, never replaced — a second run must not wipe an existing entry.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

-- Maddy on the NY crew (region NY, excluding Maddy herself)
update public.profiles p
   set reminder_cc = (select array(select distinct e
                        from unnest(p.reminder_cc || array['maddy@wizardtrees.com']) e))
 where p.active
   and coalesce(p.region, p.home_region) = 'NY'
   and p.email <> 'maddy@wizardtrees.com'
   and not ('maddy@wizardtrees.com' = any(p.reminder_cc));

-- Amanda on Joanna's
update public.profiles p
   set reminder_cc = (select array(select distinct e
                        from unnest(p.reminder_cc || array['amanda@wizardtrees.com']) e))
 where p.email = 'joanna@wizardtrees.com'
   and not ('amanda@wizardtrees.com' = any(p.reminder_cc));

-- Verify:
--   select full_name, coalesce(region,home_region) as reg, reminder_cc
--     from public.profiles where cardinality(reminder_cc) > 0 order by full_name;
