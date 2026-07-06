-- ── Regional admins ────────────────────────────────────────────────────────
-- role stays {ba,admin}; region distinguishes scope:
--   Universal Admin = admin, region IS NULL   → sees/edits everything
--   Regional Admin  = admin, region='NY'/…    → sees/edits only that region + logs like a BA
--   BA              = ba,    region='CA'/…     → own data + own region's stores
-- is_admin() still means "any active admin"; the new helpers add the region scope.

create or replace function public.is_universal_admin() returns boolean
 language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles
                where id=auth.uid() and role='admin' and region is null and active);
$$;
create or replace function public.admin_region() returns text
 language sql stable security definer set search_path=public as $$
  select region from public.profiles where id=auth.uid() and role='admin' and active;
$$;
create or replace function public.ba_region(uid uuid) returns text
 language sql stable security definer set search_path=public as $$
  select region from public.profiles where id=uid;
$$;
-- may the current admin act on data owned by user `uid`?
create or replace function public.admin_sees_ba(uid uuid) returns boolean
 language sql stable security definer set search_path=public as $$
  select public.is_universal_admin()
      or (public.is_admin() and public.admin_region() is not null
          and public.admin_region() = public.ba_region(uid));
$$;

-- ── profiles: universal sees all; regional admin sees/edits only their region ──
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using ( id = auth.uid() or public.is_universal_admin()
       or (public.is_admin() and region = public.admin_region()) );
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using      ( id = auth.uid() or public.is_universal_admin() or (public.is_admin() and region = public.admin_region()) )
  with check ( id = auth.uid() or public.is_universal_admin() or (public.is_admin() and region = public.admin_region()) );

-- ── dispensaries: universal all; everyone else (incl. regional admin) by state ──
drop policy if exists dispensaries_select on public.dispensaries;
create policy dispensaries_select on public.dispensaries for select to authenticated
  using ( public.is_universal_admin()
       or (private = false and state = public.my_region())
       or (created_by = auth.uid()) );
drop policy if exists dispensaries_insert on public.dispensaries;
create policy dispensaries_insert on public.dispensaries for insert to authenticated
  with check ( public.is_universal_admin()
            or (created_by = auth.uid() and state = public.my_region()) );
drop policy if exists dispensaries_update on public.dispensaries;
create policy dispensaries_update on public.dispensaries for update to authenticated
  using      ( public.is_universal_admin() or (private = false and state = public.my_region()) or created_by = auth.uid() )
  with check ( public.is_universal_admin() or state = public.my_region() or created_by = auth.uid() );
drop policy if exists dispensaries_delete on public.dispensaries;
create policy dispensaries_delete on public.dispensaries for delete to authenticated
  using ( public.is_universal_admin() or (private = false and state = public.my_region()) or created_by = auth.uid() );

-- ── trips / expenses / submissions: own, or an admin scoped to the owner's region ──
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips for select to authenticated
  using ( ba_id = auth.uid() or public.admin_sees_ba(ba_id) );
drop policy if exists trips_insert on public.trips;
create policy trips_insert on public.trips for insert to authenticated
  with check ( (ba_id = auth.uid() and status = 'draft') or public.admin_sees_ba(ba_id) );
drop policy if exists trips_update on public.trips;
create policy trips_update on public.trips for update to authenticated
  using      ( (ba_id = auth.uid() and status in ('draft','rejected')) or public.admin_sees_ba(ba_id) )
  with check ( (ba_id = auth.uid() and status in ('draft','submitted')) or public.admin_sees_ba(ba_id) );
drop policy if exists trips_delete on public.trips;
create policy trips_delete on public.trips for delete to authenticated
  using ( (ba_id = auth.uid() and status in ('draft','rejected')) or public.admin_sees_ba(ba_id) );

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses for select to authenticated
  using ( ba_id = auth.uid() or public.admin_sees_ba(ba_id) );
drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses for insert to authenticated
  with check ( (ba_id = auth.uid() and status = 'draft') or public.admin_sees_ba(ba_id) );
drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses for update to authenticated
  using      ( (ba_id = auth.uid() and status in ('draft','rejected')) or public.admin_sees_ba(ba_id) )
  with check ( (ba_id = auth.uid() and status in ('draft','submitted')) or public.admin_sees_ba(ba_id) );
drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses for delete to authenticated
  using ( (ba_id = auth.uid() and status in ('draft','rejected')) or public.admin_sees_ba(ba_id) );

drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated
  using ( ba_id = auth.uid() or public.admin_sees_ba(ba_id) );
drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions for insert to authenticated
  with check ( (ba_id = auth.uid() and status in ('open','submitted')) or public.admin_sees_ba(ba_id) );
drop policy if exists submissions_update on public.submissions;
create policy submissions_update on public.submissions for update to authenticated
  using      ( (ba_id = auth.uid() and status in ('open','submitted','rejected')) or public.admin_sees_ba(ba_id) )
  with check ( (ba_id = auth.uid() and status in ('open','submitted')) or public.admin_sees_ba(ba_id) );

-- ── hours: admin-managed, scoped to the owner's region ──
drop policy if exists hours_select on public.hours;
create policy hours_select on public.hours for select to authenticated
  using ( ba_id = auth.uid() or public.admin_sees_ba(ba_id) );
drop policy if exists hours_insert on public.hours;
create policy hours_insert on public.hours for insert to authenticated
  with check ( public.admin_sees_ba(ba_id) );
drop policy if exists hours_update on public.hours;
create policy hours_update on public.hours for update to authenticated
  using ( public.admin_sees_ba(ba_id) ) with check ( public.admin_sees_ba(ba_id) );
drop policy if exists hours_delete on public.hours;
create policy hours_delete on public.hours for delete to authenticated
  using ( public.admin_sees_ba(ba_id) );

select 'regional-admin RLS applied' as result;
