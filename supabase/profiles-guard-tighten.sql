-- Tighten the profiles guard (shared CA project). Found 2026-11-10.
--
-- The gap: profiles_update lets anyone update their own row, and the old guard blocked only role, active,
-- rate_override and base coordinates for non-admins, and nothing at all for admins. So a BA could set their own
-- hourly_rate, salary_per_period, gusto_name (Gusto hours of a coworker land on them), region / home_region
-- (another state's stores and schedule), non_ba, non_ba_from, email or reminder_cc; and a regional admin (role admin,
-- region FL or NY) could set their own region to NULL and become a universal admin.
--
-- The fix, in the same trigger (still SECURITY INVOKER, so req_is_enduser() sees the caller's role):
--   * server code, SQL by hand and SECURITY DEFINER functions are not end users and pass, as before;
--   * nobody signed in can change a row's id;
--   * an admin who is not already a universal admin cannot change their OWN role, region or home_region
--     (decided from the row as it was, not as it is being written);
--   * everyone else may change only what the BA app's "Your profile" sheet and first sign-in write:
--     full_name, phone, base_address, must_change_password, and base_lat / base_lng back to NULL.
--     Every other column is refused. This is an allowlist on purpose: a column added later is admin-only until
--     someone adds it here.
-- Admin edits of other people are unchanged: the profiles_update policy already keeps a regional admin to rows in
-- their own region and requires the saved row to stay in that region.

create or replace function public.trg_profile_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_self_ok constant text[] := array['full_name', 'phone', 'base_address', 'must_change_password', 'base_lat', 'base_lng'];
  v_changed text;
begin
  if not public.req_is_enduser() then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'a profile''s id cannot be changed' using errcode = '42501';
  end if;

  if public.is_admin() then
    if old.id = v_uid and not (old.role = 'admin' and old.region is null and old.active) then
      if new.role is distinct from old.role then
        raise exception 'only a universal admin can change their own profile type' using errcode = '42501';
      end if;
      if new.region is distinct from old.region then
        raise exception 'only a universal admin can change their own region' using errcode = '42501';
      end if;
      if new.home_region is distinct from old.home_region then
        raise exception 'only a universal admin can change their own home region' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  if new.base_lat is distinct from old.base_lat and new.base_lat is not null then
    raise exception 'base coordinates are set by the server' using errcode = '42501';
  end if;
  if new.base_lng is distinct from old.base_lng and new.base_lng is not null then
    raise exception 'base coordinates are set by the server' using errcode = '42501';
  end if;

  select string_agg(n.key, ', ' order by n.key) into v_changed
    from jsonb_each(to_jsonb(new)) n
   where not (n.key = any (v_self_ok))
     and n.value is distinct from (to_jsonb(old) -> n.key);
  if v_changed is not null then
    raise exception 'only admins can change %', v_changed using errcode = '42501';
  end if;

  return new;
end;
$$;

-- the trigger itself is unchanged (BEFORE UPDATE, for each row); recreate it only if it went missing
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_guard') then
    create trigger profiles_guard before update on public.profiles
      for each row execute function public.trg_profile_guard();
  end if;
end $$;
