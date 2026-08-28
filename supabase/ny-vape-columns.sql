-- Vape tasks (2026-08-27): three new unit columns on the Labor/Packaging day row.
-- vape_fill / vape_pack roll into tot_pack, vape_label into tot_label; all three
-- contribute 0 lbs (oil, not flower) so $-per-lb metrics stay flower-only.
alter table public.ny_units_days
  add column if not exists vape_fill  numeric,
  add column if not exists vape_pack  numeric,
  add column if not exists vape_label numeric;
