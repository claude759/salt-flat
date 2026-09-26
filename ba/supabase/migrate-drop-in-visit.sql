-- "Drop-In Visit" category (applied to the live project 2026-09-25).
-- Amanda asked for drop-in visits as their own category, separate from PAD/EDU. Categories
-- are the shared labor_kinds list: every picker in the app (trip legs, the hours/mileage grid,
-- admin editors) reads it at load, so one row makes it selectable for everyone, in any open
-- period, with no app deploy. Sorted right after "Store visit". It is a store visit (not in
-- NONSTORE_KINDS), so a leg tagged with it still needs a store link and counts as a visit.
-- Safe to re-run.
insert into public.labor_kinds (name, active, sort)
values ('Drop-In Visit', true, 15)
on conflict (name) do update set active = true;

-- Verify as a BA would see it (labor_kinds_select is open to every signed-in user):
select name, sort, active from public.labor_kinds where active order by sort, name;
