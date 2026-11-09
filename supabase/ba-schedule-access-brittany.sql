-- BA app: CA schedule access for Brittany Rohrbach, Head of Marketing Coordination & Events at Waf & Gus
-- (Gianni, 2026-11-09: "can we give brittany access to the BA schedule?"). Her account came from a Google
-- sign-in to another app on this project on 2026-07-15 and was inactive with no region. The CA board is
-- visible to active profiles with region CA (schedule_can_see). She isn't a brand ambassador: non_ba = no
-- submit reminders, anything she logs is filed as Non-BA activity, and she stays out of BA reports (same as
-- Lorenzo, Justin and Nouri). The BA app signs in with email + password only, so she was then sent the app's
-- welcome email (ba-notify job 'invite': fresh temporary password, must_change_password = true).
update public.profiles
   set full_name = 'Brittany Rohrbach', region = 'CA', active = true, non_ba = true
 where email = 'brittany@wizardtrees.com' and role = 'ba'
returning full_name, email, region, active, non_ba;

-- Gianni, same day: "she can see the ny side too". Region stays CA (her home board); the NY board's
-- allowlist adds her, so she gets both boards and the CA/NY switcher.
update public.schedule_board
   set allowed_emails = array_append(allowed_emails, 'brittany@wizardtrees.com'), updated_at = now()
 where state = 'NY' and not ('brittany@wizardtrees.com' = any(allowed_emails))
returning state, allowed_emails;
