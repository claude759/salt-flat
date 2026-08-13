-- Central store registry feed for the sales web app (Customers report "Registry"
-- column). Mirrors the ba_sales_metrics pattern: security definer, anon-callable,
-- returns only the canonical directory columns (public-record business info).
create or replace function public.store_registry()
returns table(id uuid, name text, legal_name text, pistil_name text, address text,
              state text, license text, sales_key text, aliases text[])
language sql stable security definer set search_path=public as $$
  select id, name, legal_name, pistil_name, address, state, license, sales_key, aliases
  from public.dispensaries
  where active and not private and retail;
$$;
grant execute on function public.store_registry() to anon, authenticated;
