-- Per-period "reopen for edits" override (applied to the live project 2026-08-03).
--
-- A just-ended period is editable by BAs only through a grace window (until the following
-- Sunday 11am). After that it flips to view-only. When a late submitter (e.g. Leti,
-- Makenna) still needs to add mileage/expenses, an admin can extend that window per period
-- instead of it being a hard, date-computed cutoff. edit_until = the instant the extended
-- window closes; null = normal grace only. Honored client-side in periodGraceEnd(); there
-- is no server-side period lock (BAs' own draft rows are always writable under RLS), so no
-- trigger change is needed. pay_periods writes are already admin-only (pay_periods_write).
alter table public.pay_periods add column if not exists edit_until timestamptz;
