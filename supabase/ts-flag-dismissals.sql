-- Manager Timesheets (timesheets.html): mark a Job vs place warning as checked, for everyone.
-- (Gianni 2026-11-20, of a Distro Packager shift "At Slane" flagged "Job vs place" with the button "Move to Deleaf/Harvest -
-- Slane": "we should probably have an option to officially dismiss a job vs place warning in case it was actually correct")
-- The page's Job vs place flag (C.placeLooks, C.placeFlag) is its own guess from where a deleaf crew shift was clocked in;
-- sometimes the job Gusto has is right. A dismissal records that someone who can see the shift checked it: the page then
-- keeps the place under the job but drops the flag, the Move button and the shift's place in Move all clear ones, and shows
-- "Checked: job is right" with Undo.
-- This changes nothing in Gusto and nothing in hours or pay: it is a note to the board only, so it has no edit window and
-- no pay period check. No edit worker reads it.
--
-- Needs supabase/ts-ca-timesheets.sql and ts-view-grants.sql (the person-aware ts_can_view). Safe to re-run: create table
-- if not exists, create index if not exists, create or replace, drop policy if exists then create.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, then run supabase/ts-flag-dismissals-verify.sql
-- (it rolls itself back) and check every row says pass. Until this file is applied the page finds no table and shows no
-- dismiss controls, exactly as before.
--
-- What is stored: public.ts_flag_dismissals, one row per dismissal (undone ones stay, with undone_by and undone_at)
--   day_id         the ts_days id ('<company>:<employee_uuid>:<YYYY-MM-DD>'); no foreign key: a row outlives its day row
--   company, employee_uuid, work_date   copied from that day row
--   shift_id       the Gusto shift id, as text
--   code           'job_place' (the page's flag code), the only one
--   job            the shift's Gusto job title on the day row at that moment (shifts[i].job.title when it is text), else null
--   place          the shift's place on the day row at that moment (shifts[i].place = {site, how, at, other?}, as the sync
--                  writes it from ~/gusto-sync/ca-ts-core.mjs shiftPlace) as Postgres writes that jsonb as text: keys
--                  shortest first, then A to Z, with ", " and ": ". So {site: 'Slane', how: 'named', at: 'in'} is
--                  '{"at": "in", "how": "named", "site": "Slane"}'. The page reads it back with JSON.parse and compares site,
--                  how, at and other (timesheets.html placeKeyOf); its demo twin writes the same text (placeText).
--   reason         optional, one line with its whitespace evened out, at most 200 characters; null when blank
--   dismissed_by   the caller's sign-in email (lower case), dismissed_at when
--   undone_by      who undid it (their email), or 'superseded' (below); undone_at when
-- A dismissal counts on the page only while the shift's job and place on the day row (as Gusto has them now, not a waiting
-- edit) equal the stored ones, so a shift moved to another job, or read at another place, is checked afresh.
--
-- Who
--   ts_flag_dismiss(p_day_id, p_shift_id, p_code, p_reason default null) -> the stored row (jsonb)
--     The caller of ts_edit_submit: an ACTIVE allowlisted Google sign-in (ts_access + ts_my_email; a password, magic-link
--     or OTP session never counts, and automation@ has no ts_access row), admin or manager alike, who can see the day row
--     (ts_can_view(company, department, employee_uuid) on it). A day that does not exist and a day the caller cannot see
--     get the same answer. Job and place are read from the day row, never from the caller.
--     The same day, shift and code with an active dismissal whose job and place still match the row: that row comes back
--     unchanged (a second click, or someone else's, is no error). An active one whose job or place no longer match (Gusto
--     changed the shift since; the page no longer counts it and offers the button again) is closed, undone_by
--     'superseded', and a new one is stored.
--   ts_flag_undismiss(p_id) -> the row (jsonb)
--     The same sign-in rule, for someone who can see the check's day row (as ts_flag_dismiss, and the select policy
--     below). Sets undone_by and undone_at; a row already undone comes back as it is.
--   Refused, in these words (the page's DISMISS_WORDS, which its demo twin uses), checked in this order:
--     Only timesheet sign-ins can mark a warning as checked          (42501; both RPCs)
--     Only a Job vs place warning can be marked as checked           (a code other than job_place, in any case)
--     No such day, or you cannot see it                              (42501)
--     That shift is not on this day any more (it may have changed in Gusto). Reload and try again   (also no shift id)
--     That shift has no clock-in place, so it has no Job vs place warning
--     The reason can be at most 200 characters
--     No such check, or you cannot see it                            (42501, ts_flag_undismiss)
--
-- Who sees dismissals: RLS with one SELECT policy to authenticated: admins see all; anyone else sees a row whose day row
--   they can see (that subquery runs under the ts_days policy, as ts_edits_select does), so by the department on the day
--   row, never the person's department in ts_people today: the same people who may mark it, and undo it. A check whose
--   day row is gone is seen by admins only (the page has no shift to show it on). That is ts_can_view(company, department,
--   employee_uuid) on the day row; ts_flag_can_see states the rule as plain calls, for the verify script to compare.
--   Nobody writes the table directly: authenticated has SELECT only, anon and PUBLIC nothing, no write policies.
--
-- Grants: Supabase's default privileges hand anon/authenticated ALL on every new public table and EXECUTE on every new
-- public function, so every grant below starts with an explicit revoke naming them. Every function is security definer
-- with search_path = public; only the two RPCs are granted, to authenticated.

begin;

do $$ begin
  if to_regclass('public.ts_days') is null or to_regclass('public.ts_people') is null
     or to_regclass('public.ts_access') is null or to_regclass('public.ts_companies') is null
     or to_regprocedure('public.ts_my_email()') is null or to_regprocedure('public.ts_is_admin()') is null then
    raise exception 'Apply supabase/ts-ca-timesheets.sql first';
  end if;
  if to_regprocedure('public.ts_can_view(text,text,text)') is null then
    raise exception 'Apply supabase/ts-view-grants.sql first (dismissals use its person-aware ts_can_view)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ts_flag_dismissals (
  id            uuid primary key default gen_random_uuid(),
  day_id        text not null,
  company       text not null references public.ts_companies(key),
  employee_uuid text not null,
  work_date     date not null,
  shift_id      text not null,
  code          text not null check (code = 'job_place'),
  job           text,
  place         text,
  reason        text,
  dismissed_by  text not null,
  dismissed_at  timestamptz not null default now(),
  undone_by     text,
  undone_at     timestamptz,
  constraint ts_flag_dismissals_reason check (reason is null or length(reason) between 1 and 200),
  constraint ts_flag_dismissals_by check (dismissed_by = lower(dismissed_by)),
  constraint ts_flag_dismissals_undone check ((undone_at is null) = (undone_by is null))
);
-- one active dismissal per day, shift and code
create unique index if not exists ts_flag_dismissals_active_idx
  on public.ts_flag_dismissals (day_id, shift_id, code) where undone_at is null;
create index if not exists ts_flag_dismissals_work_date_idx on public.ts_flag_dismissals (work_date);

-- ---------------------------------------------------------------------------------------------
-- Helpers (internal, not granted)
-- ---------------------------------------------------------------------------------------------

-- A shift's place as stored text (see the header): the jsonb object as Postgres writes it. Null when not an object.
create or replace function public.ts_flag_place_text(p_place jsonb)
returns text language sql immutable security definer set search_path = public as $$
  select case when jsonb_typeof(p_place) = 'object' then p_place::text end
$$;
revoke all on function public.ts_flag_place_text(jsonb) from public, anon, authenticated;

-- May the caller see a dismissal of this day? The select policy's rule, as plain calls: an admin; or the day row as it is
-- now is one the caller can see (ts_flag_dismiss's own test).
create or replace function public.ts_flag_can_see(p_day_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ts_is_admin()
      or exists (select 1 from public.ts_days d
                  where d.id = p_day_id
                    and coalesce(public.ts_can_view(d.company, d.department, d.employee_uuid), false))
$$;
revoke all on function public.ts_flag_can_see(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- ts_flag_dismiss
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_flag_dismiss(p_day_id text, p_shift_id text, p_code text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me       text := public.ts_my_email();
  v_code     text := lower(btrim(coalesce(p_code, '')));
  v_shift_id text := nullif(btrim(coalesce(p_shift_id, '')), '');
  v_reason   text;
  d          public.ts_days%rowtype;
  v_shift    jsonb;
  v_job      text;
  v_place    text;
  v_row      public.ts_flag_dismissals%rowtype;
  -- a run of whitespace as JavaScript's \s finds it (as ts_edit_submit evens a note)
  v_ws       constant text := '[\t\n\v\f\r    -     　﻿]+';
begin
  -- who: an active allowlisted Google sign-in (automation@ has no ts_access row)
  if v_me is null or not exists (select 1 from public.ts_access a where a.email = v_me and a.active) then
    raise exception 'Only timesheet sign-ins can mark a warning as checked' using errcode = '42501';
  end if;
  if v_code <> 'job_place' then
    raise exception 'Only a Job vs place warning can be marked as checked';
  end if;
  -- one dismissal or undo of a day at a time, taken before the day row is read, so the job and place below and the
  -- check for an active dismissal are read after any press ahead of this one (ts_flag_undismiss takes the same lock)
  perform pg_advisory_xact_lock(hashtext('ts_flag:' || coalesce(p_day_id, '')));
  -- which day: one the caller can see (a missing day and a hidden day get the same answer)
  select * into d from public.ts_days t where t.id = p_day_id;
  if not found or not coalesce(public.ts_can_view(d.company, d.department, d.employee_uuid), false) then
    raise exception 'No such day, or you cannot see it' using errcode = '42501';
  end if;
  select e.s into v_shift
    from jsonb_array_elements(case jsonb_typeof(d.shifts) when 'array' then d.shifts else '[]'::jsonb end) as e(s)
   where jsonb_typeof(e.s) = 'object' and v_shift_id is not null and e.s->>'id' = v_shift_id
   limit 1;
  if v_shift is null then
    raise exception 'That shift is not on this day any more (it may have changed in Gusto). Reload and try again';
  end if;
  if jsonb_typeof(v_shift->'place') is distinct from 'object' then
    raise exception 'That shift has no clock-in place, so it has no Job vs place warning';
  end if;
  v_reason := nullif(btrim(regexp_replace(coalesce(p_reason, ''), v_ws, ' ', 'g')), '');
  if length(v_reason) > 200 then
    raise exception 'The reason can be at most 200 characters';
  end if;
  -- the job and place as the day row has them now (never the caller's)
  v_job   := case when jsonb_typeof(v_shift->'job') = 'object' and jsonb_typeof(v_shift->'job'->'title') = 'string'
                  then v_shift->'job'->>'title' end;
  v_place := public.ts_flag_place_text(v_shift->'place');

  select * into v_row from public.ts_flag_dismissals f
   where f.day_id = d.id and f.shift_id = v_shift_id and f.code = v_code and f.undone_at is null
   for update;
  if found then
    if v_row.job is not distinct from v_job and v_row.place is not distinct from v_place then
      return to_jsonb(v_row);   -- already checked, for this job and place
    end if;
    -- Gusto changed the shift's job or place since: that check no longer counts on the page, so this one replaces it
    update public.ts_flag_dismissals f set undone_by = 'superseded', undone_at = now() where f.id = v_row.id;
  end if;
  insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, job, place, reason, dismissed_by)
  values (d.id, d.company, d.employee_uuid, d.work_date, v_shift_id, v_code, v_job, v_place, v_reason, v_me)
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.ts_flag_dismiss(text, text, text, text) from public, anon, authenticated;
grant execute on function public.ts_flag_dismiss(text, text, text, text) to authenticated;   -- body checks the caller

-- ---------------------------------------------------------------------------------------------
-- ts_flag_undismiss
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_flag_undismiss(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me  text := public.ts_my_email();
  v_row public.ts_flag_dismissals%rowtype;
begin
  if v_me is null or not exists (select 1 from public.ts_access a where a.email = v_me and a.active) then
    raise exception 'Only timesheet sign-ins can mark a warning as checked' using errcode = '42501';
  end if;
  select * into v_row from public.ts_flag_dismissals f where f.id = p_id;
  if not found or not coalesce(public.ts_flag_can_see(v_row.day_id), false) then
    raise exception 'No such check, or you cannot see it' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('ts_flag:' || v_row.day_id));   -- the same lock as ts_flag_dismiss
  select * into v_row from public.ts_flag_dismissals f where f.id = p_id for update;
  if v_row.undone_at is not null then
    return to_jsonb(v_row);   -- already undone
  end if;
  update public.ts_flag_dismissals f set undone_by = v_me, undone_at = now() where f.id = p_id
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.ts_flag_undismiss(uuid) from public, anon, authenticated;
grant execute on function public.ts_flag_undismiss(uuid) to authenticated;   -- body checks the caller

-- ---------------------------------------------------------------------------------------------
-- Row level security: SELECT only, to authenticated. No write policies (writes = the two RPCs).
-- ---------------------------------------------------------------------------------------------

alter table public.ts_flag_dismissals enable row level security;
revoke all on table public.ts_flag_dismissals from public, anon, authenticated;
grant select on table public.ts_flag_dismissals to authenticated;

-- = ts_flag_can_see(day_id): the subquery runs under the ts_days policy, so by the department on the day row
drop policy if exists ts_flag_dismissals_select on public.ts_flag_dismissals;
create policy ts_flag_dismissals_select on public.ts_flag_dismissals for select to authenticated
  using ((select public.ts_is_admin())
         or exists (select 1 from public.ts_days d where d.id = ts_flag_dismissals.day_id));

notify pgrst, 'reload schema';

commit;

-- Post-apply checks (all read-only):
--   select relrowsecurity from pg_class where oid = 'public.ts_flag_dismissals'::regclass;   -- true
--   anon GET /rest/v1/ts_flag_dismissals?select=id -> 401/permission denied
--   then run supabase/ts-flag-dismissals-verify.sql: every row pass = true, and it rolls back.
