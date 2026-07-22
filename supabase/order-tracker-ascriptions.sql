-- Order Tracker: payment re-ascription layer (order-tracker.html)
--
-- The supplier's sheet spreads each wire (Payment N column) across invoice
-- rows, sometimes to the wrong invoices from our perspective. This table is
-- OUR overlay: restating a payment replaces the sheet's per-invoice split in
-- the app's adjusted view. Rows with invoice_no send money to that invoice;
-- invoice_no NULL is an explicit overall-balance slice; any remainder of the
-- wire falls to the overall balance automatically. The supplier sheet itself
-- is never modified.
--
-- Access: same anon-open pattern as ny_credits (internal click-to-edit tool).

create table if not exists public.order_payment_ascriptions (
  id          uuid primary key default gen_random_uuid(),
  state       text not null check (state in ('ca','ny')),
  payment_key text not null,           -- first line of the payment column header, e.g. 'Payment 30'
  invoice_no  text,                    -- null = explicitly ascribed to the overall balance
  amount      numeric not null default 0 check (amount >= 0),
  note        text,
  created_at  timestamptz not null default now()
);

alter table public.order_payment_ascriptions enable row level security;
drop policy if exists order_payment_ascriptions_anon_all on public.order_payment_ascriptions;
create policy order_payment_ascriptions_anon_all on public.order_payment_ascriptions
  for all to anon, authenticated using (true) with check (true);
grant all on public.order_payment_ascriptions to anon, authenticated;
