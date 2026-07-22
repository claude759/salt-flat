-- Order Tracker: payment re-ascription layer (order-tracker.html)
--
-- OUR overlay on the supplier's wire→invoice split; the supplier sheet is never
-- modified. Three modes:
--   mode='move'    reallocate `amount` WITHIN a wire from source_invoice → invoice_no.
--                  Only those two invoices change; open balance conserved.
--   mode='replace' restate a whole wire: drop its sheet split, rebuild from entries
--                  (invoice_no NULL = overall slice; remainder → overall balance).
--   mode='bucket'  attribute `amount` of payments to a balance bucket:
--                  invoice_no '__vape__' or '__nonvape__' (payment_key '__bucket__').
--                  Shifts open balance between the Vape (AIO) and Non-vape buckets.
--
-- Access: same anon-open pattern as ny_credits (internal click-to-edit tool).

create table if not exists public.order_payment_ascriptions (
  id             uuid primary key default gen_random_uuid(),
  state          text not null check (state in ('ca','ny')),
  payment_key    text not null,        -- first line of the payment column header, e.g. 'Payment 30'; '__bucket__' for bucket mode
  invoice_no     text,                 -- target invoice; NULL overall slice; '__vape__'/'__nonvape__' for bucket mode
  amount         numeric not null default 0 check (amount >= 0),
  note           text,
  mode           text not null default 'replace' check (mode in ('replace','move','bucket')),
  source_invoice text,                 -- move mode: the invoice the amount is taken off
  created_at     timestamptz not null default now()
);

alter table public.order_payment_ascriptions enable row level security;
drop policy if exists order_payment_ascriptions_anon_all on public.order_payment_ascriptions;
create policy order_payment_ascriptions_anon_all on public.order_payment_ascriptions
  for all to anon, authenticated using (true) with check (true);
grant all on public.order_payment_ascriptions to anon, authenticated;
