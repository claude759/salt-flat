-- ── hours: a labor entry (hours worked as a BA, optionally tagged to a dispensary) ──
create table if not exists public.hours (
  id            uuid primary key default gen_random_uuid(),
  ba_id         uuid not null references public.profiles(id) on delete cascade,
  work_date     date not null,
  dispensary_id uuid references public.dispensaries(id),     -- optional; auto-linkable by date later
  hours         numeric(7,3) not null default 0,
  rate          numeric(8,2) not null default 0,             -- $/hr, set authoritatively by trigger
  amount        numeric(10,2) not null default 0,            -- hours*rate, set by trigger
  job           text,                                        -- e.g. 'Brand Ambassador'
  source        text not null default 'manual' check (source in ('manual','gusto')),
  period_id     uuid references public.pay_periods(id),
  status        text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  note          text,
  reject_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists hours_ba_period_idx on public.hours(ba_id, period_id);
create index if not exists hours_status_idx on public.hours(status);

-- per-BA hourly pay rate (null = fall back to the global default)
alter table public.profiles     add column if not exists hourly_rate numeric(8,2);
alter table public.app_settings add column if not exists hourly_rate numeric(8,2) default 0;

create or replace function public.effective_hourly_rate(p uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select hourly_rate from public.profiles where id = p),
    (select hourly_rate from public.app_settings where id = 1),
    0
  );
$$;

create or replace function public.trg_hours_before()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pid uuid;
begin
  if tg_op='UPDATE' and new.status in ('submitted','approved') and public.is_admin() then
    new.rate   := old.rate;
    new.amount := round(coalesce(new.hours,0) * coalesce(old.rate, public.effective_hourly_rate(new.ba_id)), 2);
  elsif tg_op='UPDATE' and new.status in ('submitted','approved') then
    new.hours := old.hours; new.rate := old.rate; new.amount := old.amount;
  else
    new.rate   := public.effective_hourly_rate(new.ba_id);
    new.amount := round(coalesce(new.hours,0) * new.rate, 2);
  end if;
  select id into v_pid from public.pay_periods where new.work_date between start_date and end_date order by start_date desc limit 1;
  if v_pid is not null then new.period_id := v_pid; end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists hours_before on public.hours;
create trigger hours_before before insert or update on public.hours for each row execute function public.trg_hours_before();

-- RLS (mirror trips/expenses; admin may also INSERT on a BA's behalf for the Gusto import)
alter table public.hours enable row level security;
drop policy if exists hours_select on public.hours;
create policy hours_select on public.hours for select to authenticated
  using (ba_id = auth.uid() or public.is_admin());
drop policy if exists hours_insert on public.hours;
create policy hours_insert on public.hours for insert to authenticated
  with check ((ba_id = auth.uid() and status = 'draft') or public.is_admin());
drop policy if exists hours_update on public.hours;
create policy hours_update on public.hours for update to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin())
  with check ((ba_id = auth.uid() and status in ('draft','submitted')) or public.is_admin());
drop policy if exists hours_delete on public.hours;
create policy hours_delete on public.hours for delete to authenticated
  using ((ba_id = auth.uid() and status in ('draft','rejected')) or public.is_admin());

select 'hours table + rate + trigger + RLS created' as result;
