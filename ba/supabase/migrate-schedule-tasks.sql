-- ── Schedule tasks (in-app additions to the workbook schedule) ──────────────
-- The workbook Google Sheet stays read-only from the app, so tasks created via
-- the Schedule tab's + button land here and the calendar renders the union.
-- Access mirrors the Schedule feature itself: anyone on the schedule_board
-- allowlist can read/write (Joanna & Amanda are BAs, not admins, so this can't
-- key off role).
create table if not exists public.schedule_tasks (
  id         uuid primary key default gen_random_uuid(),
  task_date  date not null,
  account    text not null,
  inv_total  numeric(12,2),
  region     text,
  driver     text,
  so_num     text,
  notes      text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists schedule_tasks_date_idx on public.schedule_tasks(task_date);
alter table public.schedule_tasks enable row level security;

-- is the current user on the schedule-board allowlist? (security definer so it
-- can read schedule_board regardless of that table's own RLS)
create or replace function public.schedule_allowed() returns boolean
 language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.schedule_board
    where lower(coalesce(auth.jwt()->>'email','')) = any(allowed_emails));
$$;

drop policy if exists schedule_tasks_select on public.schedule_tasks;
create policy schedule_tasks_select on public.schedule_tasks for select to authenticated
  using ( public.schedule_allowed() );
drop policy if exists schedule_tasks_write on public.schedule_tasks;
create policy schedule_tasks_write on public.schedule_tasks for all to authenticated
  using ( public.schedule_allowed() ) with check ( public.schedule_allowed() );
