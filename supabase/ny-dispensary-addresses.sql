-- NY dispensary addresses for the AR report's "New York → Reports → Customers" page.
--
-- The `dispensaries` table is RLS-protected (the field app reads it through a logged-in session),
-- so the report's anonymous key can't read it. Rather than open the whole table, this exposes ONLY
-- name + address for active NY stores through a read-only view — public license / store-address
-- data. The base table's RLS and every other column stay exactly as they are.
--
-- Run once in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create or replace view public.ny_dispensary_addresses as
  select name, address
  from public.dispensaries
  where state = 'NY'
    and address is not null
    and coalesce(active, true);

-- The view runs with its owner's rights (default), so it reads through the base RLS for just these
-- two columns; grant the anon (publishable-key) role read access to the view only.
grant select on public.ny_dispensary_addresses to anon;

-- Verify:  select count(*) from public.ny_dispensary_addresses;   -- expect ~170
-- Undo:    drop view if exists public.ny_dispensary_addresses;
