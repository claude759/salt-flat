-- ============================================================================
--  BA app Schedule: delivery orders (COD + address + distance)   2026-10-14
-- ----------------------------------------------------------------------------
--  Gianni: "for the schedule can we add if the delivery is a COD order, this data
--  would be in the sales webapp" + "needs to show address, and order deliveries by
--  longest address away to closest".
--
--  The CA schedule workbook names each delivery by its Distru sales order ("#SO-0000443").
--  Distru has no payment-terms column; terms show up as the order's due date. Due on (or
--  before) the delivery date = COD, which agrees with how those invoices actually get paid
--  (cash/check at drop-off). The hourly sales job (~/ar-automation, lib/delivery-orders-feed.mjs)
--  publishes one row per recent sales order here, with the customer's address from Distru's
--  company directory geocoded once (US Census geocoder), so the BA app can tag COD, show the
--  address and sort a day's deliveries farthest-first without reading any sales data itself.
--
--  Write path: token-gated SECURITY DEFINER RPC (the olympic_save / royalty_save pattern);
--  the token hash is seeded out-of-band, never committed. Read path: anyone who can see the
--  CA schedule board (schedule_states()), the same people who already see INV TOTAL there.
--  Applied to dhiqhgtmelxwelyoowle 2026-10-14 (save hardened the same day after review). Safe to re-run.
-- ============================================================================
create table if not exists public.delivery_orders (
  so_num         text primary key,          -- 'SO-0000443' (no '#')
  customer       text,
  delivery_date  date,
  due_date       date,
  terms_days     integer,                   -- due - delivery (or invoice) date; 0 or less = COD
  is_cod         boolean not null default false,
  status         text,                      -- Distru order status
  invoice_no     text,
  invoice_total  numeric,
  outstanding    numeric,
  address        text,
  license        text,
  lat            double precision,
  lng            double precision,
  updated_at     timestamptz not null default now()
);
-- 2026-10-14 (2nd ask): drivers from Metrc. Only names are stored, never licence numbers or plates.
alter table public.delivery_orders add column if not exists manifest_no      text;          -- Metrc manifest, from Distru
alter table public.delivery_orders add column if not exists driver_name      text;          -- Metrc "Name of Person Transporting"
alter table public.delivery_orders add column if not exists driver_label     text;          -- schedule name (Carlos, Jesse, Al...) or 'Pickup'
alter table public.delivery_orders add column if not exists transporter_name text;          -- Metrc transporter facility (FILIFERA, NABIFIVE...)
alter table public.delivery_orders add column if not exists is_pickup        boolean;       -- null = no manifest yet
alter table public.delivery_orders add column if not exists departs_at       text;          -- Metrc estimated departure, LA wall clock 'YYYY-MM-DD HH:MM'
alter table public.delivery_orders add column if not exists received_at      timestamptz;
alter table public.delivery_orders add column if not exists order_total      numeric;       -- line items, pre-tax
alter table public.delivery_orders add column if not exists order_date       date;          -- an open order with no delivery date yet is listed as "needs a date"

comment on table public.delivery_orders is
  'Recent Distru sales orders for the BA app Schedule (COD tag, address, farthest-first sort). '
  'Written hourly by ~/ar-automation via delivery_orders_save(); read by CA schedule viewers.';
alter table public.delivery_orders enable row level security;
drop policy if exists delivery_orders_select on public.delivery_orders;
create policy delivery_orders_select on public.delivery_orders
  for select to authenticated using ('CA' = any(public.schedule_states()));

create table if not exists public.delivery_orders_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.delivery_orders_secret enable row level security;   -- no policies: nobody reads it
-- token hash is inserted out-of-band (~/claude-sql/pending), never committed to the repo

-- p_rows: [{so_num, customer, delivery_date, due_date, terms_days, is_cod, status, invoice_no,
--           invoice_total, outstanding, address, license, lat, lng}, ...] for every order with a
-- delivery date on/after p_from. Orders in that window that are no longer sent were cancelled
-- or deleted in Distru and are removed; anything older than 120 days is pruned.
create or replace function public.delivery_orders_save(p_token text, p_from date, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int; n_del int;
begin
  if not exists (select 1 from public.delivery_orders_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be an array'; end if;
  insert into public.delivery_orders as d (so_num, customer, delivery_date, due_date, terms_days, is_cod,
         status, invoice_no, invoice_total, outstanding, address, license, lat, lng,
         manifest_no, driver_name, driver_label, transporter_name, is_pickup, departs_at, received_at, order_total, order_date, updated_at)
  select r->>'so_num', r->>'customer', (r->>'delivery_date')::date, (r->>'due_date')::date,
         (r->>'terms_days')::int, coalesce((r->>'is_cod')::boolean, false), r->>'status', r->>'invoice_no',
         (r->>'invoice_total')::numeric, (r->>'outstanding')::numeric, r->>'address', r->>'license',
         (r->>'lat')::double precision, (r->>'lng')::double precision,
         r->>'manifest_no', r->>'driver_name', r->>'driver_label', r->>'transporter_name', (r->>'is_pickup')::boolean,
         r->>'departs_at', (r->>'received_at')::timestamptz, (r->>'order_total')::numeric, (r->>'order_date')::date, now()
    from jsonb_array_elements(p_rows) r
   where coalesce(r->>'so_num','') ~ '^SO-[0-9]+$'
  on conflict (so_num) do update set
    customer = excluded.customer, delivery_date = excluded.delivery_date, due_date = excluded.due_date,
    terms_days = excluded.terms_days, is_cod = excluded.is_cod, status = excluded.status,
    invoice_no = excluded.invoice_no, invoice_total = excluded.invoice_total,
    outstanding = excluded.outstanding,
    -- a run that couldn't read Distru's company directory sends blank addresses: keep what we had
    address = coalesce(excluded.address, d.address), license = coalesce(excluded.license, d.license),
    -- keep the old point only when this run knows no address at all; with an address, the
    -- feed's (ZIP-checked) geocode is the answer, including "no match" (a rejected wrong point)
    lat = case when excluded.address is null then d.lat else excluded.lat end,
    lng = case when excluded.address is null then d.lng else excluded.lng end,
    order_total = excluded.order_total, order_date = excluded.order_date, manifest_no = coalesce(excluded.manifest_no, d.manifest_no),
    -- a run without the Metrc snapshot sends no driver: keep what we knew (a real change is non-null)
    driver_name = coalesce(excluded.driver_name, d.driver_name), driver_label = coalesce(excluded.driver_label, d.driver_label),
    transporter_name = coalesce(excluded.transporter_name, d.transporter_name), is_pickup = coalesce(excluded.is_pickup, d.is_pickup),
    departs_at = coalesce(excluded.departs_at, d.departs_at), received_at = coalesce(excluded.received_at, d.received_at),
    updated_at = now();
  get diagnostics n_up = row_count;
  delete from public.delivery_orders
   where ((delivery_date >= p_from or delivery_date is null)       -- undated open orders are re-sent every run too
          and so_num not in (select r->>'so_num' from jsonb_array_elements(p_rows) r where r->>'so_num' is not null))
      or delivery_date < current_date - 120;
  get diagnostics n_del = row_count;
  return jsonb_build_object('ok', true, 'upserted', n_up, 'removed', n_del);
end $$;
revoke all on function public.delivery_orders_save(text, date, jsonb) from public;
grant execute on function public.delivery_orders_save(text, date, jsonb) to anon, authenticated;
