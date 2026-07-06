-- Tag each trip with an activity kind (Store visit / Education talk / Demo / PAD /
-- Brand event / Travel / Admin — the same admin-editable labor_kinds list used by
-- hours). Optional per trip; surfaced as the "Kind" column on the mileage grid.
alter table public.trips add column if not exists kind text;
