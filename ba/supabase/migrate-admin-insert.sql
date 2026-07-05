-- Let admins add trips/expenses on a BA's behalf (so the admin day-grid has the same
-- ＋ Mileage / ＋ Expense affordances the BA sees). Admins already UPDATE/DELETE any
-- row; this extends INSERT to them too. BAs are still limited to their own drafts.
drop policy if exists trips_insert on public.trips;
create policy trips_insert on public.trips
  for insert to authenticated
  with check ((ba_id = auth.uid() and status = 'draft') or public.is_admin());

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check ((ba_id = auth.uid() and status = 'draft') or public.is_admin());

select
  (select pg_get_expr(polwithcheck,polrelid) from pg_policy where polname='trips_insert')    as trips_insert_check,
  (select pg_get_expr(polwithcheck,polrelid) from pg_policy where polname='expenses_insert') as expenses_insert_check;
