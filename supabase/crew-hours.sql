-- crew-hours.sql: hours for Norma's crew who are not on Gusto, entered by Diana on the Crew hours page
-- (crew-hours.html, opened from the Timesheet app), submitted once per pay period and approved by Gianni
-- (Gianni 2026-11-28: "1. me 2. once per pay period 3. only diana", Friday 6:30 pm reminder to submit by
-- Saturday 11 am, then Saturday and Sunday if she still hasn't).
--
-- The rows themselves stay in distro_shifts, the CA labor tracker's own table, so they show in that app at
-- once. This file adds who may enter and approve, one submission row per pay period, a lock that keeps a
-- submitted or approved period's crew rows from changing unless the approver changes them, and the
-- reminder log. Applied from Gianni's Mac: node ~/claude-sql/run-sql-ca.mjs supabase/crew-hours.sql
-- Safe to run again.

-- 1. who may enter and approve --------------------------------------------------------------------------
create table if not exists public.crew_hours_access (
  email       text primary key check (email = lower(email)),
  can_enter   boolean not null default true,
  can_approve boolean not null default false,
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now()
);
alter table public.crew_hours_access enable row level security;
-- no policies: the page asks crew_me()

insert into public.crew_hours_access (email, can_enter, can_approve, note) values
  ('diana@wizardtrees.com',  true, false, 'Enters and submits Norma''s crew hours (Gianni 2026-11-28)'),
  ('gianni@wizardtrees.com', true, true,  'Approves the crew hours (Gianni 2026-11-28)')
on conflict (email) do nothing;

create or replace function public.crew_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('can_enter', a.can_enter, 'can_approve', a.can_approve, 'email', a.email)
       from crew_hours_access a
      where a.email = lower(coalesce(auth.jwt() ->> 'email', '')) and a.active and is_staff()),
    jsonb_build_object('can_enter', false, 'can_approve', false));
$$;
revoke all on function public.crew_me() from public, anon;
grant execute on function public.crew_me() to authenticated;

-- 2. pay periods: 14 days from Saturday 2026-07-04, the CA tracker's anchor (labor-calculator.html) ------
create or replace function public.ca_period_start(d date) returns date
language sql immutable as $$
  select date '2026-07-04' + (floor((d - date '2026-07-04') / 14.0) * 14)::int;
$$;

-- today in Los Angeles
create or replace function public.crew_today() returns date
language sql stable as $$ select (now() at time zone 'America/Los_Angeles')::date; $$;

-- 3. one submission per pay period (no row = open) --------------------------------------------------------
create table if not exists public.crew_submissions (
  pay_period   date primary key,
  status       text not null check (status in ('submitted', 'approved')),
  submitted_by text,
  submitted_at timestamptz,
  approved_by  text,
  approved_at  timestamptz,
  summary      jsonb,          -- people, hours and lines when submitted
  updated_at   timestamptz not null default now(),
  constraint crew_submissions_period check (pay_period = public.ca_period_start(pay_period))
);
alter table public.crew_submissions enable row level security;
drop policy if exists crew_submissions_read on public.crew_submissions;
create policy crew_submissions_read on public.crew_submissions for select to authenticated using (public.is_staff());

create table if not exists public.crew_submission_log (
  id         bigint generated always as identity primary key,
  pay_period date not null,
  action     text not null,    -- submitted, approved, reopened
  by_email   text,
  at         timestamptz not null default now(),
  summary    jsonb
);
alter table public.crew_submission_log enable row level security;
drop policy if exists crew_submission_log_read on public.crew_submission_log;
create policy crew_submission_log_read on public.crew_submission_log for select to authenticated using (public.is_staff());

create table if not exists public.crew_reminder_log (
  pay_period date not null,
  kind       text not null,    -- friday, saturday, sunday, submitted
  sent_at    timestamptz not null default now(),
  sent_to    text,
  primary key (pay_period, kind)
);
alter table public.crew_reminder_log enable row level security;

-- 4. who entered a row from the Crew hours page --------------------------------------------------------------
alter table public.distro_shifts add column if not exists entered_by text;
alter table public.distro_shifts add column if not exists entered_via text;

-- 5. a crew row: Norma's Team, paid on her list, not by Gusto (the tracker's isGustoPaidRow, by roster id) ---
create or replace function public.crew_row_is_crew(r public.distro_shifts) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(r.team, '') ilike 'norma%'
     and coalesce(r.source_id, '') !~ '^gusto-'
     and coalesce(r.team, '') !~* 'gusto'
     and (coalesce(r.category, 'distro') = 'harvest'
          or coalesce(r.note, '') ~* '\[crew pay\]'
          or not exists (select 1 from distro_roster e
                          where e.id = r.roster_id and e.gusto_distro
                            and (e.gusto_distro_from is null or r.work_date >= e.gusto_distro_from)));
$$;

create or replace function public.crew_row_period(r public.distro_shifts) returns date
language sql stable as $$ select coalesce(r.pay_period, public.ca_period_start(r.work_date)); $$;

-- 6. the lock: once a period is submitted, its crew rows change only through the approver ---------------------
create or replace function public.crew_lock_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s record;
  who text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  -- jobs, imports and Claude's SQL run as service_role or postgres: not locked
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then return coalesce(new, old); end if;
  if exists (select 1 from crew_hours_access a where a.email = who and a.can_approve and a.active) then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and public.crew_row_is_crew(old) then
    select * into s from crew_submissions where pay_period = public.crew_row_period(old);
    if found then
      raise exception 'crew_period_locked: the crew hours for the pay period starting % were % on %. Ask Gianni to change them.',
        to_char(s.pay_period, 'Mon FMDD'), s.status, to_char(coalesce(s.approved_at, s.submitted_at) at time zone 'America/Los_Angeles', 'Mon FMDD')
        using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.crew_row_is_crew(new) then
    select * into s from crew_submissions where pay_period = public.crew_row_period(new);
    if found then
      raise exception 'crew_period_locked: the crew hours for the pay period starting % were % on %. Ask Gianni to change them.',
        to_char(s.pay_period, 'Mon FMDD'), s.status, to_char(coalesce(s.approved_at, s.submitted_at) at time zone 'America/Los_Angeles', 'Mon FMDD')
        using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists crew_lock_guard on public.distro_shifts;
create trigger crew_lock_guard before insert or update or delete on public.distro_shifts
  for each row execute function public.crew_lock_guard();

-- 7. a period's crew lines, the numbers a submission carries -----------------------------------------------------
create or replace function public.crew_period_summary(p_period date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pay_period', p_period,
    'lines',  count(*),
    'people', count(distinct coalesce(s.roster_id::text, lower(s.last || ' ' || s.first))),
    'hours',  round(coalesce(sum(s.hours), 0), 2),
    'total',  round(coalesce(sum(s.total), 0), 2))
  from distro_shifts s
  where public.crew_row_is_crew(s) and public.crew_row_period(s) = p_period
    and s.company <> 'WTNY';
$$;
revoke all on function public.crew_period_summary(date) from public, anon;
grant execute on function public.crew_period_summary(date) to authenticated;

-- 8. the email job's shared secret (made here, never leaves the database) -----------------------------------------
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'crew_notify_secret',
                           'crew-hours-notify: cron and crew_submit prove themselves with this')
 where not exists (select 1 from vault.secrets where name = 'crew_notify_secret');

create or replace function public.crew_notify_authorized(candidate text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(candidate, '') <> '' and exists (
    select 1 from vault.decrypted_secrets where name = 'crew_notify_secret' and decrypted_secret = candidate);
$$;
revoke all on function public.crew_notify_authorized(text) from public, anon, authenticated;
grant execute on function public.crew_notify_authorized(text) to service_role;

create or replace function public.crew_notify(p_job text, p_period date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/crew-hours-notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-notify-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'crew_notify_secret')),
    body := jsonb_build_object('job', p_job, 'pay_period', p_period));
exception when others then
  raise warning 'crew_notify % failed: %', p_job, sqlerrm;   -- an email failure never undoes a submit
end $$;
revoke all on function public.crew_notify(text, date) from public, anon, authenticated;

-- 9. submit, approve, reopen ---------------------------------------------------------------------------------------
create or replace function public.crew_submit(p_period date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me jsonb := public.crew_me();
  who text := me ->> 'email';
  sm jsonb;
begin
  if not coalesce((me ->> 'can_enter')::boolean, false) then raise exception 'not_allowed: only Diana and Gianni can submit crew hours'; end if;
  if p_period is distinct from public.ca_period_start(p_period) then raise exception 'bad_period: % does not start a pay period', p_period; end if;
  if public.crew_today() < p_period + 13 then
    raise exception 'too_early: this pay period runs until %; submit it on its last day or after', to_char(p_period + 13, 'Dy Mon FMDD');
  end if;
  if exists (select 1 from crew_submissions where pay_period = p_period) then
    raise exception 'already_submitted: this pay period was already submitted';
  end if;
  sm := public.crew_period_summary(p_period);
  insert into crew_submissions (pay_period, status, submitted_by, submitted_at, summary)
  values (p_period, 'submitted', who, now(), sm);
  insert into crew_submission_log (pay_period, action, by_email, summary) values (p_period, 'submitted', who, sm);
  perform public.crew_notify('submitted', p_period);
  return sm;
end $$;
revoke all on function public.crew_submit(date) from public, anon;
grant execute on function public.crew_submit(date) to authenticated;

create or replace function public.crew_approve(p_period date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me jsonb := public.crew_me();
  who text := me ->> 'email';
  sm jsonb;
begin
  if not coalesce((me ->> 'can_approve')::boolean, false) then raise exception 'not_allowed: only Gianni approves crew hours'; end if;
  if p_period is distinct from public.ca_period_start(p_period) then raise exception 'bad_period: % does not start a pay period', p_period; end if;
  sm := public.crew_period_summary(p_period);
  insert into crew_submissions (pay_period, status, submitted_by, submitted_at, approved_by, approved_at, summary)
  values (p_period, 'approved', null, null, who, now(), sm)
  on conflict (pay_period) do update
    set status = 'approved', approved_by = who, approved_at = now(), summary = excluded.summary, updated_at = now();
  insert into crew_submission_log (pay_period, action, by_email, summary) values (p_period, 'approved', who, sm);
  return sm;
end $$;
revoke all on function public.crew_approve(date) from public, anon;
grant execute on function public.crew_approve(date) to authenticated;

create or replace function public.crew_reopen(p_period date) returns void
language plpgsql security definer set search_path = public as $$
declare
  me jsonb := public.crew_me();
begin
  if not coalesce((me ->> 'can_approve')::boolean, false) then raise exception 'not_allowed: only Gianni reopens crew hours'; end if;
  delete from crew_submissions where pay_period = p_period;
  insert into crew_submission_log (pay_period, action, by_email) values (p_period, 'reopened', me ->> 'email');
end $$;
revoke all on function public.crew_reopen(date) from public, anon;
grant execute on function public.crew_reopen(date) to authenticated;

-- 10. who is on Gusto on a day (for the page's check: a Gusto person's hours are never crew pay) -------------------
create or replace function public.crew_gusto_day(p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me jsonb := public.crew_me();
begin
  if not (coalesce((me ->> 'can_enter')::boolean, false) or coalesce((me ->> 'can_approve')::boolean, false)) then
    raise exception 'not_allowed';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'name', d.employee_name, 'company', d.company,
             'shifts', (select coalesce(jsonb_agg(jsonb_build_object(
                          'in', substr(x ->> 'in', 12, 5), 'out', substr(coalesce(x ->> 'out', ''), 12, 5),
                          'job', x -> 'job' ->> 'title', 'site', x -> 'place' ->> 'site')
                          order by x ->> 'in'), '[]'::jsonb)
                        from jsonb_array_elements(d.shifts::jsonb) x)))
      from ts_days d
     where d.work_date = p_day and d.company in ('filifera', 'slane', 'imperial')), '[]'::jsonb);
end $$;
revoke all on function public.crew_gusto_day(date) from public, anon;
grant execute on function public.crew_gusto_day(date) to authenticated;

-- 11. the reminders: every half hour; the function sends only at their times (Friday 6:30 pm, Saturday 11 am,
--     Sunday 11 am, Los Angeles), only while the period is not submitted, each once (crew_reminder_log)
select cron.unschedule('crew-hours-reminders') where exists (select 1 from cron.job where jobname = 'crew-hours-reminders');
select cron.schedule('crew-hours-reminders', '0,30 * * * *', $cron$
  select net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/crew-hours-notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-notify-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'crew_notify_secret')),
    body := jsonb_build_object('job', 'remind'));
$cron$);
