-- BA app Schedule: an email a few minutes after a task is given to someone (2026-11-23).
--
-- Amanda, 2026-11-23: "Would it be possible to send an email notification to the team member when a task is
-- assigned to them? I know it appears on their schedule, but an email would also be helpful as we make this
-- transition." Before this, a new task reached its person only in the next 9 AM "Your tasks" email (New for
-- you), and one dated today and added after 9 AM was never emailed at all.
--
-- Every 5 minutes, while there is something to send, the ba-notify function's job 'task-notices' asks
-- schedule_task_notices() who has new tasks, sends each person one email, and records each task it told them
-- about in schedule_task_notice_log. A task is announced to a person once: a task moved to someone else is
-- announced to the new person; a change of day, time or notes is not announced. Tasks people add for
-- themselves, deliveries, done tasks and tasks dated before today are never announced. Emails go out between
-- 7 AM and 9 PM on the board's clock; a task added later waits for 7 AM. Each email gets one try: one that
-- fails is not sent again by this job, and the next 9 AM email lists its tasks under New for you. The 9 AM
-- email's New for you leaves out what was announced (its Today and Past due lists are unchanged).
--
-- Order: deploy ba-notify with job 'task-notices' first (the timer below calls it; deploy it with
-- --no-verify-jwt, ba/supabase/config.toml), then this file after ba-store-planning.sql, then
-- ba-schedule-people.sql: once schedule_people answers, the page tells whoever saves a task that its person gets
-- an email. Safe to run again.

-- ── 1. who was told about which task ───────────────────────────────────────────────────────────────
-- A row means the task is never announced to that person (again). sent_at: when its email went out (null: known
-- before this started). told: false while its email is being sent, and for good when that send failed or the task
-- was known before this started but still due in the next 9 AM email; New for you skips only told rows.
create table if not exists public.schedule_task_notice_log (
  task_id   uuid not null,
  person_id uuid not null,
  sent_at   timestamptz,
  told      boolean not null default true,
  primary key (task_id, person_id)
);
alter table public.schedule_task_notice_log add column if not exists told boolean not null default true;
alter table public.schedule_task_notice_log enable row level security;
revoke all on public.schedule_task_notice_log from anon, authenticated;

-- Every task older than 2 days when this starts counts as known, done and deleted ones too, so a later edit, a
-- Not done, an undelete or a restore never announces it as new. The ones changed in the last 2 days that no
-- email of their person has listed get told = false: no email now, and the next 9 AM email still lists them.
-- Tasks added in the last 2 days by someone else are announced when this starts, as the 9 AM email's New for you
-- would have done the next morning. Runs again harmlessly.
insert into public.schedule_task_notice_log (task_id, person_id, sent_at, told)
select s.id, p.person, null,
       not (s.deleted_at is null and s.done_at is null
            and s.updated_at > now() - interval '2 days'
            and s.created_by is distinct from p.person
            and not exists (select 1 from public.schedule_task_digest_log l
                             where l.person_id = p.person and s.id = any(l.task_ids)))
  from public.schedule_tasks s
  cross join lateral (select public.schedule_person(s.state, s.driver) as person) p
 where p.person is not null
   and s.created_at <= now() - interval '2 days'
on conflict (task_id, person_id) do nothing;

-- ── 2. who has new tasks to hear about ─────────────────────────────────────────────────────────────
-- One row per person with tasks to announce: open tasks from today on (the board's clock), given to them by
-- someone else (a task they added themselves is never announced), added or changed in the last 2 days, not
-- told to them before (this log or a 9 AM email), not a delivery. Only between 7 AM and 9 PM on the board's
-- clock, and only once the person's tasks have stood unchanged for 2 minutes, so a manager adding several in a
-- row sends one email. Only the notification function (service role) and the timer call it.
create or replace function public.schedule_task_notices()
returns table(person_id uuid, email text, full_name text, state text, tasks jsonb)
language sql stable security definer set search_path = public as $$
  with t as (
    select s.id, s.state, s.task_date, s.task_time, s.title, s.account, s.notes, s.booking, s.created_by,
           greatest(s.created_at, s.updated_at) as touched,
           coalesce(s.kind, case when nullif(trim(coalesce(s.so_num, '')), '') is null then 'visit' else 'delivery' end) as k,
           public.schedule_person(s.state, s.driver) as person,
           (now() at time zone case when s.state in ('NY','FL') then 'America/New_York'
                                    else 'America/Los_Angeles' end) as here
      from public.schedule_tasks s
     where s.deleted_at is null and s.done_at is null
       and greatest(s.created_at, s.updated_at) > now() - interval '2 days'
  ), j as (
    select t.*, p.email, p.full_name as pname
      from t join public.profiles p on p.id = t.person and p.active and coalesce(p.email, '') <> ''
     where t.k <> 'delivery'
       and t.task_date >= t.here::date
       and t.here::time >= time '07:00' and t.here::time < time '21:00'
       and t.created_by is distinct from t.person
       and not exists (select 1 from public.schedule_task_notice_log n where n.task_id = t.id and n.person_id = t.person)
       and not exists (select 1 from public.schedule_task_digest_log l where l.person_id = t.person and t.id = any(l.task_ids))
  )
  select j.person, max(j.email), max(j.pname), max(j.state),
         jsonb_agg(jsonb_build_object('id', j.id, 'date', j.task_date, 'time', j.task_time, 'kind', j.k,
                     'title', j.title, 'account', j.account, 'notes', j.notes, 'booking', j.booking)
                   order by j.task_date, j.task_time nulls last)
    from j
   group by j.person
  having max(j.touched) <= now() - interval '2 minutes';
$$;
revoke all on function public.schedule_task_notices() from public, anon, authenticated;
grant execute on function public.schedule_task_notices() to service_role;

-- ── 3. the 9 AM email leaves out what was announced ────────────────────────────────────────────────
-- schedule_task_digest as in ba-store-planning.sql, with one more test in is_new: a task whose new-task email
-- went out (or that was known when the announcements started) is not New for you again.
create or replace function public.schedule_task_digest(p_today date)
returns table(person_id uuid, email text, full_name text, state text,
              new_tasks jsonb, today_tasks jsonb, overdue_tasks jsonb)
language sql stable security definer set search_path = public as $$
  with t as (
    select s.*, public.schedule_person(s.state, s.driver) as person,
           coalesce(s.kind, case when nullif(trim(coalesce(s.so_num, '')), '') is null then 'visit' else 'delivery' end) as k
      from public.schedule_tasks s
     where s.deleted_at is null and s.done_at is null and s.task_date >= p_today - 30
  ), j as (
    select t.*, p.email, p.full_name as pname
      from t join public.profiles p on p.id = t.person and p.active and coalesce(p.email, '') <> ''
     where t.k <> 'delivery'
  ), pick as (
    select j.*,
      (j.task_date >= p_today and j.created_by is distinct from j.person
         and greatest(j.created_at, j.updated_at) > now() - interval '2 days'
         and not exists (select 1 from public.schedule_task_digest_log l
                          where l.person_id = j.person and j.id = any(l.task_ids))
         and not exists (select 1 from public.schedule_task_notice_log n
                          where n.task_id = j.id and n.person_id = j.person and n.told)) as is_new,
      (j.task_date = p_today) as is_today,
      (j.k in ('training','followup') and j.task_date < p_today) as is_overdue
      from j
  ), item as (
    select pick.*, jsonb_build_object('id', pick.id, 'date', pick.task_date, 'time', pick.task_time, 'kind', pick.k,
             'title', pick.title, 'account', pick.account, 'notes', pick.notes, 'booking', pick.booking) as obj
      from pick where pick.is_new or pick.is_today or pick.is_overdue
  )
  select i.person, max(i.email), max(i.pname), max(i.state),
         coalesce(jsonb_agg(i.obj order by i.task_date, i.task_time nulls last) filter (where i.is_new and not i.is_today), '[]'),
         coalesce(jsonb_agg(i.obj order by i.task_time nulls last) filter (where i.is_today), '[]'),
         coalesce(jsonb_agg(i.obj order by i.task_date) filter (where i.is_overdue), '[]')
    from item i
   where not exists (select 1 from public.schedule_task_digest_log l where l.person_id = i.person and l.sent_on = p_today)
   group by i.person;
$$;
revoke all on function public.schedule_task_digest(date) from public, anon, authenticated;
grant execute on function public.schedule_task_digest(date) to service_role;

-- ── 4. the timer: every 5 minutes, and it calls the function only when someone has something new ────
-- The call waits up to 30 seconds for the answer (pg_net's 5-second default gave up before an email was sent and
-- logged a timeout; the function itself carried on), so net._http_response shows what each run did.
select cron.schedule('ba-task-notices', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
    body := jsonb_build_object('job','task-notices'),
    timeout_milliseconds := 30000)
  where exists (select 1 from public.schedule_task_notices());
$cron$);
