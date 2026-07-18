-- Retail flag on locations (2026-07-17). A location is a "retail store / dispensary"
-- by default; unchecking it in the location editor marks it an ERRAND STOP (post office,
-- gas, food). legAttribution() (ba/index.html) files a leg whose destination is a
-- retail=false stop under the * General BA activity bucket instead of the stop itself,
-- so those costs never masquerade as a store visit. Idempotent.
alter table public.dispensaries add column if not exists retail boolean not null default true;
