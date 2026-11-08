-- 2026-11-08 Gianni: "why is norma here?" Norma Delgado (Filifera packager / deleaf) and Raul signed into
-- the Manager Timesheets app with Google; handle_new_user turned each login into a BA profile, so they
-- showed on the BA app's Team activity list. Neither is a BA: mark both non_ba (app access kept).
update public.profiles set non_ba = true
 where id in ('14c42bc7-8674-49a7-acfb-c2c9eaf6661f', (select id from public.profiles where email = 'raul@wizardtrees.com'))
   and role = 'ba' and region is null and home_region is null and coalesce(non_ba, false) = false
returning full_name, email, non_ba;
