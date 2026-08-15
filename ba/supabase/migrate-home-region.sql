-- ── home_region: "the region I personally work in" ─────────────────────────
-- Until now one column did two jobs: profiles.region meant BOTH "the region I
-- administer" and "the region I belong to". That works while everyone is either a
-- field worker in one state or an oversight admin over all of them — and breaks the
-- moment someone is both.
--
-- Amanda is exactly that case: a Universal Admin (sees every board, approves work)
-- who ALSO drives to CA stores and files her own reimbursements every period. As a
-- universal admin her region must be NULL (that is what is_universal_admin() keys
-- on), but a null region would:
--   • stamp state=NULL on every trip/expense/hours row she creates, because
--     trg_item_state_default reads profiles.region — her own mileage would vanish
--     from the CA reports and from the BA→Sales bridge; and
--   • drop her from the Saturday 11am reminder, which deliberately skips oversight
--     admins, so nothing would chase her own unsubmitted reimbursements.
--
-- home_region carries the personal half. Everyone who is only a field worker leaves
-- it NULL and behaves exactly as before, because every reader uses
-- coalesce(region, home_region).
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

alter table public.profiles add column if not exists home_region text
  check (home_region is null or home_region in ('CA','FL','NY'));

comment on column public.profiles.home_region is
  'The region this person personally works in, for people whose `region` is NULL because '
  'they administer everywhere. Drives: the state stamped on their own trips/expenses/hours, '
  'which region''s alerts they receive, and whether the pay-period reminder chases them. '
  'Leave NULL for everyone whose `region` already says where they work.';

-- ── their own rows get stamped with their own state ─────────────────────────
create or replace function public.trg_item_state_default()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.state is null then
    new.state := (select coalesce(p.region, p.home_region) from public.profiles p where p.id = new.ba_id);
  end if;
  return new;
end $$;

-- ── the person this is for ──────────────────────────────────────────────────
-- Universal Admin (sees both boards + the CA/NY switcher, can approve), but her own
-- field work, alerts and reminders stay CA.
update public.profiles
   set role = 'admin', region = null, home_region = 'CA'
 where email = 'amanda@wizardtrees.com';

-- her existing rows were stamped 'CA' while she was a CA BA and stay that way;
-- this only backfills anything that slipped through with a null state
update public.trips    t set state = 'CA' where t.state is null
  and t.ba_id = (select id from public.profiles where email = 'amanda@wizardtrees.com');
update public.expenses e set state = 'CA' where e.state is null
  and e.ba_id = (select id from public.profiles where email = 'amanda@wizardtrees.com');
update public.hours    h set state = 'CA' where h.state is null
  and h.ba_id = (select id from public.profiles where email = 'amanda@wizardtrees.com');

-- The schedule exception that gave her the CA/NY switcher is now redundant — a
-- universal admin sees every board — and a stale grant is exactly what bites later.
update public.schedule_board
   set allowed_emails = array_remove(allowed_emails, 'amanda@wizardtrees.com'), updated_at = now()
 where 'amanda@wizardtrees.com' = any(allowed_emails);

-- Verify:
--   select full_name, role, region, home_region from public.profiles where email='amanda@wizardtrees.com';
--   select public.schedule_states();   -- as her: {CA,NY}
