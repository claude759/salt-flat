-- Feed the sales web app the schedule tasks created inside the BA app so they
-- show up in the BA Report's "Upcoming" column alongside workbook rows.
-- The schedule_tasks table itself is RLS-locked to the schedule allowlist; this
-- function is the narrow public projection: FUTURE-ish rows only (last 14 days
-- forward), no created_by, mirroring what the workbook feed already exposes.
create or replace function public.schedule_tasks_feed()
returns table(task_date date, account text, driver text, notes text, so_num text)
language sql stable security definer set search_path=public as $$
  select task_date, account, driver, notes, so_num
  from public.schedule_tasks
  where task_date >= current_date - 14
  order by task_date;
$$;
grant execute on function public.schedule_tasks_feed() to anon, authenticated;
