-- ── Accounts that aren't brand ambassadors ─────────────────────────────────
-- Two clean-ups after the 2026-08-15 reminder went to a shared mailbox:
--
--   distro@  — a shared mailbox, not a person. Signed in once the day it was made
--              and never again; no trips, expenses, hours or submissions. It was
--              matching the reminder rule purely because role='ba'. Deactivated.
--
--   lorenzo@ — a real person, but NOT a brand ambassador. He keeps his login so he
--              can file the occasional mileage/expense, but his hours aren't
--              tracked and everything he files is Non-BA activity, so his costs
--              never land in per-store BA spend or the BA reports.
--
-- `non_ba` is the general flag for that second shape (someone who can use the app
-- but isn't doing brand-ambassador work), so the next such hire is one UPDATE.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

alter table public.profiles add column if not exists non_ba boolean not null default false;
comment on column public.profiles.non_ba is
  'True = has a login but is not a brand ambassador: their trips/hours are forced to '
  '"Non-BA activity", their expenses are never attributed to a store, their hours are '
  'not tracked (no Gusto import, no labor reporting) and the pay-period reminder skips them.';

-- ── 1. the shared mailbox ───────────────────────────────────────────────────
update public.profiles set active = false where email = 'distro@wizardtrees.com';

-- ── 2. the non-BA login ─────────────────────────────────────────────────────
update public.profiles set non_ba = true, active = true where email = 'lorenzo@wizardtrees.com';

-- ── 3. enforce it server-side, so it holds no matter what the client sends ──
-- Runs BEFORE the existing normalize triggers (alphabetically 'aa_' sorts first),
-- so the kind it forces is the one those triggers then attribute with.
create or replace function public.trg_force_non_ba() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_non_ba boolean;
begin
  select non_ba into v_non_ba from public.profiles where id = new.ba_id;
  if not coalesce(v_non_ba, false) then return new; end if;
  -- No store attribution on anything they file: a non-BA's mileage and spending must
  -- never land in per-store BA spend (ba_sales_metrics reads trips.dispensary_id
  -- directly, so the kind alone would not have kept their miles out of it).
  if tg_table_name in ('trips','hours') then
    new.kind := 'Non-BA activity';
    new.dispensary_id := null;
  end if;
  if tg_table_name in ('hours','expenses') then
    new.dispensary_ids := null; new.alloc := null;
  end if;
  if tg_table_name = 'expenses' then new.dispensary_id := null; end if;
  return new;
end $$;

drop trigger if exists aa_force_non_ba on public.trips;
create trigger aa_force_non_ba before insert or update on public.trips
  for each row execute function public.trg_force_non_ba();
drop trigger if exists aa_force_non_ba on public.hours;
create trigger aa_force_non_ba before insert or update on public.hours
  for each row execute function public.trg_force_non_ba();
drop trigger if exists aa_force_non_ba on public.expenses;
create trigger aa_force_non_ba before insert or update on public.expenses
  for each row execute function public.trg_force_non_ba();

-- Verify:
--   select full_name, role, active, non_ba from public.profiles
--    where email in ('distro@wizardtrees.com','lorenzo@wizardtrees.com');
-- Undo:
--   update public.profiles set active=true  where email='distro@wizardtrees.com';
--   update public.profiles set non_ba=false where email='lorenzo@wizardtrees.com';
