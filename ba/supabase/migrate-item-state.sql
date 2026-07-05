-- Per-item state (CA/NY/…). Every trip/expense/hours row carries the state it
-- belongs to; it defaults to the BA's own region (profiles.region) but is editable
-- and stored per row for future multi-state reporting.
alter table public.trips    add column if not exists state text;
alter table public.expenses add column if not exists state text;
alter table public.hours    add column if not exists state text;

-- backfill existing rows from the owning BA's region
update public.trips    t set state=p.region from public.profiles p where p.id=t.ba_id and t.state is null and p.region is not null;
update public.expenses e set state=p.region from public.profiles p where p.id=e.ba_id and e.state is null and p.region is not null;
update public.hours    h set state=p.region from public.profiles p where p.id=h.ba_id and h.state is null and p.region is not null;

-- auto-default state = the BA's region on any insert that doesn't set it (grid, Gusto
-- import, anywhere). A separate BEFORE trigger so the big normalize triggers stay untouched.
create or replace function public.trg_item_state_default()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.state is null then new.state := (select region from public.profiles where id=new.ba_id); end if;
  return new;
end $$;

drop trigger if exists item_state_default on public.trips;
create trigger item_state_default before insert on public.trips    for each row execute function public.trg_item_state_default();
drop trigger if exists item_state_default on public.expenses;
create trigger item_state_default before insert on public.expenses for each row execute function public.trg_item_state_default();
drop trigger if exists item_state_default on public.hours;
create trigger item_state_default before insert on public.hours    for each row execute function public.trg_item_state_default();

select
  (select count(*) from public.trips    where state is not null) as trips_stated,
  (select count(*) from public.expenses where state is not null) as expenses_stated,
  (select count(*) from public.hours    where state is not null) as hours_stated;
