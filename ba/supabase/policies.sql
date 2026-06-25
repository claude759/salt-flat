-- ============================================================================
-- Wizard Trees — BA Mileage & Expense app
-- policies.sql  ·  Row-Level Security + Storage buckets/policies
-- Run AFTER schema.sql.
--
-- Model: every BA can read/write ONLY their own rows; admins (is_admin()) can
-- read everything and perform approvals. The service-role key (used by edge
-- functions) bypasses RLS entirely, so privileged work is centralized there.
-- ============================================================================

alter table public.profiles      enable row level security;
alter table public.app_settings  enable row level security;
alter table public.dispensaries  enable row level security;
alter table public.pay_periods   enable row level security;
alter table public.trips         enable row level security;
alter table public.expenses      enable row level security;
alter table public.submissions   enable row level security;
alter table public.distance_cache enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- self-update (role/active changes blocked by trg_profile_guard) or admin
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- inserts happen via the admin-create-ba edge function / auth trigger (service
-- role), so no INSERT policy is granted to normal users.

-- ---------------------------------------------------------------------------
-- app_settings  (everyone reads the rate; only admins change it)
-- ---------------------------------------------------------------------------
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- dispensaries  (any signed-in user can read; admins manage)
-- ---------------------------------------------------------------------------
drop policy if exists dispensaries_select on public.dispensaries;
create policy dispensaries_select on public.dispensaries
  for select to authenticated using (true);

drop policy if exists dispensaries_write on public.dispensaries;
create policy dispensaries_write on public.dispensaries
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- pay_periods  (read all; admins manage)
-- ---------------------------------------------------------------------------
drop policy if exists pay_periods_select on public.pay_periods;
create policy pay_periods_select on public.pay_periods
  for select to authenticated using (true);

drop policy if exists pay_periods_write on public.pay_periods;
create policy pay_periods_write on public.pay_periods
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- trips
--   read   : own or admin
--   insert : own only, must start as draft
--   update : own while draft/rejected (incl. flipping to submitted, never
--            approved) ; admins can update anything (approve/reject)
--   delete : own draft, or admin
-- ---------------------------------------------------------------------------
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

drop policy if exists trips_insert on public.trips;
create policy trips_insert on public.trips
  for insert to authenticated
  with check (ba_id = auth.uid() and status = 'draft');

drop policy if exists trips_update on public.trips;
create policy trips_update on public.trips
  for update to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('draft','submitted')) or public.is_admin());

drop policy if exists trips_delete on public.trips;
create policy trips_delete on public.trips
  for delete to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin());

-- ---------------------------------------------------------------------------
-- expenses  (identical shape to trips)
-- ---------------------------------------------------------------------------
drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check (ba_id = auth.uid() and status = 'draft');

drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses
  for update to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('draft','submitted')) or public.is_admin());

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses
  for delete to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin());

-- ---------------------------------------------------------------------------
-- submissions
--   read   : own or admin
--   insert : own (open/submitted)
--   update : own up to 'submitted'; admin approve/reject
-- ---------------------------------------------------------------------------
drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions
  for insert to authenticated
  with check ((ba_id = auth.uid() and status in ('open','submitted')) or public.is_admin());

drop policy if exists submissions_update on public.submissions;
create policy submissions_update on public.submissions
  for update to authenticated
  using ((ba_id = auth.uid() and status in ('open','submitted','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('open','submitted')) or public.is_admin());

-- ---------------------------------------------------------------------------
-- distance_cache  (own rows only; written by the calc-distance service role)
-- ---------------------------------------------------------------------------
drop policy if exists distance_cache_select on public.distance_cache;
create policy distance_cache_select on public.distance_cache
  for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());

-- ===========================================================================
-- Storage : private buckets for receipt + odometer photos
-- Objects are keyed  <ba_id>/<uuid>.jpg  so the first path segment == owner.
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('receipts','receipts', false), ('odometer','odometer', false)
on conflict (id) do nothing;

-- a BA can read/write only objects under their own <ba_id>/ prefix
drop policy if exists storage_ba_rw on storage.objects;
create policy storage_ba_rw on storage.objects
  for all to authenticated
  using (
    bucket_id in ('receipts','odometer')
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id in ('receipts','odometer')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- admins can read every receipt/odometer object (for review + export)
drop policy if exists storage_admin_read on storage.objects;
create policy storage_admin_read on storage.objects
  for select to authenticated
  using (bucket_id in ('receipts','odometer') and public.is_admin());
