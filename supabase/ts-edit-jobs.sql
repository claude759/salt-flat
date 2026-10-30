-- Manager Timesheets (timesheets.html): which Gusto job each shift is under, and a manager moves a shift (or a shift
-- they add) to another of that person's jobs, which the edit worker writes to Gusto.
-- Gianni 2026-10-30: "We also need a job selector in the timesheet app that will sync with google" (Gusto). Some people
-- have several Gusto jobs (since 10/26 one per site), but the crew still clocks in under one of them, so a manager needs
-- to see each shift's job and pick the right one. Seeing it needs no database change (the timesheet sync puts each
-- shift's job inside ts_days.shifts); the person's list of jobs and picking one is this file.
--
-- Needs supabase/ts-ca-timesheets.sql, ts-view-grants.sql, ts-edits.sql and ts-edit-notes.sql (apply those first, then
-- this). Safe to re-run: add column if not exists, the check is added only while it is missing, and every function is
-- create or replace. Those earlier files define ts_sync, ts_edit_shape, ts_edit_key and ts_edit_submit without jobs, so
-- re-running one of them afterwards takes jobs out again (the column and what it holds stay): re-run this file after it.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, and only once the edit worker on his Mac
-- (~/gusto-sync/ts-edit-worker.mjs) knows the job: an older worker reads a change of the job alone as a shift Gusto
-- already has as asked, and marks it applied without writing it. Then run supabase/ts-edit-jobs-verify.sql,
-- ts-edits-verify.sql, ts-edits-clear-verify.sql, ts-pay-periods-verify.sql and ts-ca-timesheets-verify.sql (each rolls
-- back) and check every row says pass, except A6 in ts-ca-timesheets-verify.sql: it fails before and after this file,
-- because its list of functions was written before ts-pay-periods.sql added ts_pay_periods_sync (A3b in
-- ts-edit-jobs-verify.sql passes only when that is the one difference).
--
-- What it adds
--   ts_people.jobs          the person's Gusto jobs as the timesheet sync (~/gusto-sync/ca-timesheets.mjs) last read
--                           them: a jsonb list, primary first, of {id, title, primary, start}:
--                             id       Gusto's job id (1 to 100 characters)
--                             title    the job's title in Gusto, '' for a job with no title (at most 200 characters)
--                             primary  true for the person's primary job
--                             start    the first day the job has a pay rate in Gusto (YYYY-MM-DD), or null
--                           Nothing else: no pay rate or any other pay field is ever stored (ts_sync keeps a clean copy
--                           of these four keys only). null = not known yet. Read with the person's row under its policy.
--   ts_sync(...)            p_people rows may carry jobs: checked (a bad list fails the whole sync, like a bad row) and
--                           stored as that clean copy; null or left out keeps the stored list, so an older producer and a
--                           person known only from their shifts never blank it. Everything else as before.
--   ts_days.shifts[].job    (written by the sync, no column) {id, title, src}: the shift's job when it is known; id null
--                           when only the title is.
--   ts_edits before/after   gain "job": {id, title} (the title as ts_people has it, never the browser's):
--                             before  the shift's job when the day row knows it by its id (key left out otherwise),
--                                     or the job of an update whose times reached Gusto after the row's last sync
--                             after   update: the job the manager picked, else before's (the shift keeps its job);
--                                     add: the job the manager picked, else none (the worker picks, as before)
--                           A change of the job rides the times part (times_status): Gusto keeps the job on the shift
--                           record with its start and end. A change of the job alone is a change (not "Nothing
--                           changed"), and two adds with the same times but different jobs are not the same add (the
--                           second still overlaps the first, so it is refused as an overlap).
--   ts_edit_submit, update and add: p_after.job left out or null = as above; else it must be {id} with the id one of
--     ts_people.jobs for that person (the shift's own job again counts as none). Refused, in these words:
--       This person's Gusto jobs are not loaded yet, so the job can't be changed here.   (ts_people.jobs is null)
--       That job is not one of this person's jobs in Gusto.
--       That job starts on <Mon D> in Gusto, after this day.                             (its start is after the day)
--   Nothing else changes: notes, deletes, the window, the payroll guard, supersede and the workers' functions work as
--   they did, and a shift without a job gives exactly the before and after it gave. No new function and no new grant.
--
-- Until this file is applied, ts_sync ignores a person's jobs and ts_edit_submit drops after.job, so a change of the job
-- alone gets "Nothing changed"; the page reads that as "Changing jobs is not switched on yet", and reads ts_people
-- without jobs when the column is not there.

begin;

do $$ begin
  if to_regclass('public.ts_people') is null or to_regprocedure('public.ts_sync(text,date,date,jsonb,jsonb,jsonb)') is null then
    raise exception 'Apply supabase/ts-ca-timesheets.sql first';
  end if;
  if to_regprocedure('public.ts_can_view(text,text,text)') is null then
    raise exception 'Apply supabase/ts-view-grants.sql first';
  end if;
  if to_regclass('public.ts_edits') is null or to_regprocedure('public.ts_edit_shape(jsonb,text)') is null
     or to_regprocedure('public.ts_edit_key(jsonb,text)') is null or to_regprocedure('public.ts_edit_window(text,date)') is null
     or to_regprocedure('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)') is null then
    raise exception 'Apply supabase/ts-edits.sql first';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_edits'::regclass
                    and c.conname = 'ts_edits_action_check' and pg_get_constraintdef(c.oid) like '%''note''%') then
    raise exception 'Apply supabase/ts-edit-notes.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- ts_people.jobs
-- ---------------------------------------------------------------------------------------------

alter table public.ts_people add column if not exists jobs jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_people'::regclass and c.conname = 'ts_people_jobs_check') then
    alter table public.ts_people add constraint ts_people_jobs_check check (jobs is null or jsonb_typeof(jobs) = 'array');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- ts_sync with jobs (the function of supabase/ts-ca-timesheets.sql, plus the jobs)
-- ---------------------------------------------------------------------------------------------
-- p_days   : ts_days rows (keys = column names; synced_at is set here). Every id must start
--            with '<p_company>:' and a row's company, when present, must equal p_company.
-- p_people : [{employee_uuid, name, department, job_title, active, jobs}] for p_company. jobs = the
--            person's Gusto jobs [{id, title, primary, start}] (see the header); null or left out
--            keeps what is stored.
-- p_meta   : {active_uuids:[...], label_csv_at, gusto_uuid, allow_mass_delete}
-- Deletes only rows of p_company with work_date in [p_from, p_to], whose id is not in p_days and
-- whose employee_uuid is in active_uuids. An empty p_days never deletes anything.
-- Holds (keeps, and reports in held / held_people) the rows of an active person who has no day
-- at all in p_days: Gusto returning nothing for someone it still lists as active (a termination
-- in progress, a partial pull) must not wipe their history, because once Gusto hides those
-- shifts they never come back. allow_mass_delete releases held rows and overrides the breaker.
-- When p_people is not empty, people of p_company missing from it are set active = false
-- (never deleted).
-- Returns {ok, upserted, deleted, people, deactivated, held[, held_people][, note]}.
create or replace function public.ts_sync(p_company text, p_from date, p_to date,
                                          p_days jsonb, p_people jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_days    jsonb := coalesce(p_days, '[]'::jsonb);
  v_people  jsonb := coalesce(p_people, '[]'::jsonb);
  v_meta    jsonb := coalesce(p_meta, '{}'::jsonb);
  v_active  text[];      -- employee_uuids Gusto lists as active (only their rows may be deleted)
  v_ids     text[];      -- day ids in the payload
  v_have    text[];      -- employee_uuids with at least one day in the payload
  v_listed  text[];      -- employee_uuids in p_people
  v_force   boolean;
  v_region  text;
  v_window  int := 0;    -- in-window rows of active people: the breaker's 100%
  v_del     int := 0;
  v_held    int := 0;
  v_held_people jsonb := '[]'::jsonb;
  v_ups     int := 0;
  v_ppl     int := 0;
  v_off     int := 0;
  v_note    text;
  v_bad     text;
begin
  if public.ts_my_email() is distinct from 'automation@wizardtrees.com' then
    raise exception 'ts_sync is for the timesheet sync account only' using errcode = '42501';
  end if;
  -- the account's password alone is not enough (BA-app admins can reset it): the request must
  -- also carry the sync key that only the producer's Mac holds
  if not exists (select 1 from public.ts_sync_keys k
                  where k.revoked_at is null
                    and k.key_hash = encode(sha256(convert_to(coalesce(
                          nullif(current_setting('request.headers', true), '')::jsonb->>'x-ts-sync-key', ''), 'utf8')), 'hex')) then
    raise exception 'ts_sync needs the sync key' using errcode = '42501';
  end if;
  select c.region into v_region from public.ts_companies c where c.key = p_company;
  if not found then raise exception 'Unknown company: %', p_company; end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Bad sync window: % to %', p_from, p_to;
  end if;
  if jsonb_typeof(v_days) <> 'array' or jsonb_typeof(v_people) <> 'array' or jsonb_typeof(v_meta) <> 'object' then
    raise exception 'p_days and p_people must be arrays, p_meta an object';
  end if;
  if jsonb_typeof(coalesce(v_meta->'active_uuids', '[]'::jsonb)) <> 'array' then
    raise exception 'p_meta.active_uuids must be an array';
  end if;

  -- payload sanity: a bad row fails the whole sync loudly instead of landing half-written
  select coalesce(d->>'id', '(no id)') into v_bad from jsonb_array_elements(v_days) d
   where left(coalesce(d->>'id', ''), length(p_company) + 1) <> p_company || ':'
      or coalesce(d->>'employee_uuid', '') = '' or coalesce(d->>'employee_name', '') = ''
      or coalesce(d->>'work_date', '') = ''
      or (d ? 'company' and d->>'company' is distinct from p_company)
   limit 1;
  if v_bad is not null then raise exception 'Bad day row for %: %', p_company, v_bad; end if;
  select coalesce(p->>'employee_uuid', '(no employee_uuid)') into v_bad from jsonb_array_elements(v_people) p
   where coalesce(p->>'employee_uuid', '') = '' or coalesce(p->>'name', '') = ''
   limit 1;
  if v_bad is not null then raise exception 'Bad person row for %: %', p_company, v_bad; end if;
  -- a person's jobs: null or left out (not known this time), or a list of {id, title, primary, start} with
  -- the id 1 to 100 characters, the title at most 200 ('' for a job with no title), primary true or false
  -- and start a date (YYYY-MM-DD) or null
  select coalesce(p->>'employee_uuid', '(no employee_uuid)') into v_bad from jsonb_array_elements(v_people) p
   where coalesce(jsonb_typeof(p->'jobs'), 'null') not in ('null', 'array')
      or exists (select 1 from jsonb_array_elements(case jsonb_typeof(p->'jobs') when 'array' then p->'jobs' else '[]'::jsonb end) j
                  where jsonb_typeof(j) is distinct from 'object'
                     or jsonb_typeof(j->'id') is distinct from 'string' or length(j->>'id') not between 1 and 100
                     or jsonb_typeof(j->'title') is distinct from 'string' or length(j->>'title') > 200
                     or jsonb_typeof(j->'primary') is distinct from 'boolean'
                     or coalesce(jsonb_typeof(j->'start'), 'null') not in ('null', 'string')
                     or (jsonb_typeof(j->'start') = 'string'
                         and not (j->>'start' ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(j->>'start', 'date'))))
   limit 1;
  if v_bad is not null then raise exception 'Bad jobs for %: % (a list of {id, title, primary, start})', p_company, v_bad; end if;
  -- ... kept as a clean copy of exactly those four keys, in the order given: nothing else a Gusto job
  -- carries (its pay rate, its compensations) is ever stored
  v_people := (select coalesce(jsonb_agg(case when jsonb_typeof(p->'jobs') = 'array'
                 then p || jsonb_build_object('jobs', (
                        select coalesce(jsonb_agg(jsonb_build_object('id', j->>'id', 'title', j->>'title',
                                                                     'primary', (j->>'primary')::boolean, 'start', (j->>'start')::date)
                                                  order by o), '[]'::jsonb)
                          from jsonb_array_elements(p->'jobs') with ordinality x(j, o)))
                 else p - 'jobs' end order by po), '[]'::jsonb)
                 from jsonb_array_elements(v_people) with ordinality y(p, po));

  -- (none of these can hold a null: ids and uuids were checked above)
  v_active := array(select jsonb_array_elements_text(coalesce(v_meta->'active_uuids', '[]'::jsonb)));
  v_ids    := array(select d->>'id' from jsonb_array_elements(v_days) d);
  v_have   := array(select distinct d->>'employee_uuid' from jsonb_array_elements(v_days) d);
  v_listed := array(select distinct p->>'employee_uuid' from jsonb_array_elements(v_people) p);
  v_force  := coalesce((v_meta->>'allow_mass_delete')::boolean, false);

  -- one sync per company at a time
  perform pg_advisory_xact_lock(hashtext('ts_sync:' || p_company));

  if jsonb_array_length(v_days) = 0 then
    if exists (select 1 from public.ts_days t where t.company = p_company and t.work_date between p_from and p_to) then
      v_note := 'empty payload, nothing deleted';
    end if;
  else
    select count(*) into v_window from public.ts_days t
     where t.company = p_company and t.work_date between p_from and p_to and t.employee_uuid = any (v_active);
    -- stale = in window, person active in Gusto, id not in the payload; held = stale rows of a
    -- person with no day at all in the payload
    select count(*) filter (where v_force or t.employee_uuid = any (v_have)),
           count(*) filter (where not v_force and not (t.employee_uuid = any (v_have))),
           coalesce(jsonb_agg(distinct t.employee_uuid)
                      filter (where not v_force and not (t.employee_uuid = any (v_have))), '[]'::jsonb)
      into v_del, v_held, v_held_people
      from public.ts_days t
     where t.company = p_company and t.work_date between p_from and p_to
       and t.employee_uuid = any (v_active) and not (t.id = any (v_ids));
    if v_del > 25 and v_del > 0.3 * v_window and not v_force then
      raise exception 'ts_sync breaker: would delete % of % active-person day rows for % (% to %); pass allow_mass_delete to override',
        v_del, v_window, p_company, p_from, p_to;
    end if;
    if v_held > 0 then
      v_note := format('kept %s day rows of %s active people with no shifts in this pull; allow_mass_delete removes them',
                       v_held, jsonb_array_length(v_held_people));
    end if;
  end if;

  insert into public.ts_people as tp (company, employee_uuid, name, department, job_title, jobs, active, updated_at)
  select distinct on (p.employee_uuid)
         p_company, p.employee_uuid, p.name, coalesce(nullif(p.department, ''), 'No department'),
         nullif(p.job_title, ''), p.jobs, coalesce(p.active, true), now()
    from jsonb_to_recordset(v_people) as p(employee_uuid text, name text, department text,
                                           job_title text, jobs jsonb, active boolean)
   order by p.employee_uuid
  on conflict (company, employee_uuid) do update
     set name = excluded.name, department = excluded.department, job_title = excluded.job_title,
         jobs = coalesce(excluded.jobs, tp.jobs), active = excluded.active, updated_at = now();
  get diagnostics v_ppl = row_count;

  -- a full people list is the roster: whoever of this company is missing from it is inactive
  if jsonb_array_length(v_people) > 0 then
    update public.ts_people tp set active = false, updated_at = now()
     where tp.company = p_company and tp.active and not (tp.employee_uuid = any (v_listed));
    get diagnostics v_off = row_count;
  end if;

  insert into public.ts_days as td (id, company, region, employee_uuid, employee_name, department,
         job_title, work_date, first_in, last_out, shifts, span_min, worked_min, paid_break_min,
         unpaid_break_min, reg_min, ot_min, dt_min, ot_src, label_src, gusto_total_min, approval,
         note, flags, "open", hours_only, synced_at)
  select distinct on (d.id)
         d.id, p_company, coalesce(nullif(d.region, ''), v_region, 'CA'), d.employee_uuid,
         d.employee_name, coalesce(nullif(d.department, ''), 'No department'), nullif(d.job_title, ''),
         d.work_date, d.first_in, d.last_out, coalesce(d.shifts, '[]'::jsonb),
         coalesce(d.span_min, 0), coalesce(d.worked_min, 0), coalesce(d.paid_break_min, 0),
         coalesce(d.unpaid_break_min, 0), d.reg_min, d.ot_min, d.dt_min, nullif(d.ot_src, ''),
         coalesce(nullif(d.label_src, ''), 'none'), d.gusto_total_min, d.approval, d.note,
         coalesce(d.flags, '[]'::jsonb), coalesce(d."open", false), coalesce(d.hours_only, false), now()
    from jsonb_to_recordset(v_days) as d(id text, region text, employee_uuid text, employee_name text,
         department text, job_title text, work_date date, first_in timestamptz, last_out timestamptz,
         shifts jsonb, span_min int, worked_min int, paid_break_min int, unpaid_break_min int,
         reg_min int, ot_min int, dt_min int, ot_src text, label_src text, gusto_total_min int,
         approval text, note text, flags jsonb, "open" boolean, hours_only boolean)
   order by d.id
  on conflict (id) do update
     set company = excluded.company, region = excluded.region, employee_uuid = excluded.employee_uuid,
         employee_name = excluded.employee_name,
         -- a finished day keeps the department it was synced under (filling in a missing one is fine)
         department = case when td.work_date < (now() at time zone 'America/Los_Angeles')::date
                                and td.department <> 'No department'
                           then td.department else excluded.department end,
         job_title = excluded.job_title, work_date = excluded.work_date, first_in = excluded.first_in,
         last_out = excluded.last_out, shifts = excluded.shifts, span_min = excluded.span_min,
         worked_min = excluded.worked_min, paid_break_min = excluded.paid_break_min,
         unpaid_break_min = excluded.unpaid_break_min, reg_min = excluded.reg_min,
         ot_min = excluded.ot_min, dt_min = excluded.dt_min, ot_src = excluded.ot_src,
         label_src = excluded.label_src, gusto_total_min = excluded.gusto_total_min,
         approval = excluded.approval, note = excluded.note, flags = excluded.flags,
         "open" = excluded."open", hours_only = excluded.hours_only, synced_at = now();
  get diagnostics v_ups = row_count;

  if v_del > 0 then
    delete from public.ts_days t
     where t.company = p_company and t.work_date between p_from and p_to
       and t.employee_uuid = any (v_active) and not (t.id = any (v_ids))
       and (v_force or t.employee_uuid = any (v_have));
    get diagnostics v_del = row_count;
  end if;

  update public.ts_companies c
     set connected = true, last_sync_at = now(), sync_from = p_from, sync_to = p_to,
         label_csv_at = nullif(v_meta->>'label_csv_at', '')::timestamptz,
         gusto_uuid = coalesce(nullif(v_meta->>'gusto_uuid', ''), c.gusto_uuid),
         day_rows = (select count(*) from public.ts_days t where t.company = p_company),
         updated_at = now()
   where c.key = p_company;

  return jsonb_build_object('ok', true, 'upserted', v_ups, 'deleted', v_del, 'people', v_ppl,
                            'deactivated', v_off, 'held', v_held)
         || case when v_held > 0 then jsonb_build_object('held_people', v_held_people) else '{}'::jsonb end
         || case when v_note is null then '{}'::jsonb else jsonb_build_object('note', v_note) end;
end $$;
revoke all on function public.ts_sync(text, date, date, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ts_sync(text, date, date, jsonb, jsonb, jsonb) to authenticated;   -- body checks the email

-- ---------------------------------------------------------------------------------------------
-- The edit helpers with the job (those of supabase/ts-edits.sql, plus the job; internal, granted to nobody)
-- ---------------------------------------------------------------------------------------------

-- A ts_days shift in the stored shape {in, out, breaks: [{start, end, kind}]}, breaks in time order:
-- the before snapshot. An open shift or break keeps its null end. job: {id, title} when the day row
-- knows the shift's job by its id (left out otherwise, also when only its title is known); any other
-- key is left out.
create or replace function public.ts_edit_shape(p_shift jsonb, p_tz text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'in',  public.ts_edit_iso(public.ts_edit_ts(p_shift->'in', 'Start'), p_tz),
    'out', public.ts_edit_iso(public.ts_edit_ts(p_shift->'out', 'End'), p_tz),
    'breaks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'start', public.ts_edit_iso(public.ts_edit_ts(b->'start', 'Break start'), p_tz),
               'end',   public.ts_edit_iso(public.ts_edit_ts(b->'end', 'Break end'), p_tz),
               'kind',  coalesce(b->'kind', 'null'::jsonb))
             order by public.ts_edit_ts(b->'start', 'Break start'), public.ts_edit_ts(b->'end', 'Break end'))
        from jsonb_array_elements(case jsonb_typeof(p_shift->'breaks') when 'array' then p_shift->'breaks' else '[]'::jsonb end) b
       where jsonb_typeof(b) = 'object'), '[]'::jsonb))
  || case when jsonb_typeof(p_shift->'job'->'id') = 'string' and p_shift->'job'->>'id' <> ''
          then jsonb_build_object('job', jsonb_build_object('id', p_shift->'job'->>'id',
                                                            'title', coalesce(p_shift->'job'->>'title', '')))
          else '{}'::jsonb end
$$;
revoke all on function public.ts_edit_shape(jsonb, text) from public, anon, authenticated;

-- What one part of a stored shape is, to the minute (seconds never count; minutes since the epoch,
-- so a time is the same minute in every zone, also across a daylight-saving change):
--   'times'   [in, out], then the job's id when the shape has one (a change of the job rides the
--             times part; a shape without a job gives the key it always gave)
--   'breaks'  [[start, end, kind], ...] in time order
create or replace function public.ts_edit_key(p_shape jsonb, p_part text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case p_part
    when 'times' then jsonb_build_array(
      floor(extract(epoch from (p_shape->>'in')::timestamptz) / 60),
      floor(extract(epoch from (p_shape->>'out')::timestamptz) / 60))
      || case when jsonb_typeof(p_shape->'job'->'id') = 'string' and p_shape->'job'->>'id' <> ''
              then jsonb_build_array(p_shape->'job'->>'id') else '[]'::jsonb end
    else coalesce((
      select jsonb_agg(jsonb_build_array(floor(extract(epoch from (b->>'start')::timestamptz) / 60),
                                         floor(extract(epoch from (b->>'end')::timestamptz) / 60),
                                         b->'kind')
                       order by (b->>'start')::timestamptz, (b->>'end')::timestamptz, b->>'kind')
        from jsonb_array_elements(case jsonb_typeof(p_shape->'breaks') when 'array' then p_shape->'breaks' else '[]'::jsonb end) b),
      '[]'::jsonb) end
$$;
revoke all on function public.ts_edit_key(jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- ts_edit_submit with jobs (the function of supabase/ts-edit-notes.sql, plus the job)
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_edit_submit(p_day_id text, p_shift_id text, p_action text,
                                                 p_after jsonb, p_note text, p_expect jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me       text := public.ts_my_email();
  v_action   text := lower(btrim(coalesce(p_action, '')));
  v_shift_id text := nullif(btrim(coalesce(p_shift_id, '')), '');
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_expect   text[];
  d          public.ts_days%rowtype;
  v_tz       text;
  v_from     date;
  v_today    date;
  v_shift    jsonb;
  v_before   jsonb;
  v_sent     jsonb;
  v_after    jsonb;
  v_in       timestamptz;
  v_out      timestamptz;
  v_day_in   date;
  v_brk      jsonb;
  v_ord      bigint;
  v_bs       timestamptz;
  v_be       timestamptz;
  v_kind     text;
  v_breaks   jsonb := '[]'::jsonb;
  v_prev     jsonb;
  v_o_in     timestamptz;
  v_o_out    timestamptz;
  v_times    text;
  v_brks     text;
  v_pending  int;
  v_wide     int;
  v_job      jsonb;
  v_jobs     jsonb;
  v_pick     jsonb;
  v_row      public.ts_edits%rowtype;
  -- a run of whitespace as JavaScript's \s finds it (the page's cleanNoteText, the browser task's noteFor)
  v_ws       constant text := '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+';
begin
  -- who: an active allowlisted Google sign-in (automation@ has no ts_access row)
  if v_me is null or not exists (select 1 from public.ts_access a where a.email = v_me and a.active) then
    raise exception 'Only timesheet sign-ins can edit timesheets' using errcode = '42501';
  end if;
  -- which day: one the caller can see (a missing day and a hidden day get the same answer)
  select * into d from public.ts_days t where t.id = p_day_id;
  if not found or not coalesce(public.ts_can_view(d.company, d.department, d.employee_uuid), false) then
    raise exception 'No such day, or you cannot edit it' using errcode = '42501';
  end if;

  -- when: the current or previous pay period, not the future, in the row's time zone
  v_tz := public.ts_edit_tz(d.region);
  select w.win_from, w.win_to into v_from, v_today from public.ts_edit_window(v_tz) w;
  if d.work_date > v_today then
    raise exception 'You cannot edit a day that has not happened yet';
  end if;
  if d.work_date < v_from then
    raise exception 'Only the current and previous pay periods can be edited (from %)', to_char(v_from, 'Dy Mon FMDD');
  end if;

  -- a change's reason is optional; a note edit's text is the note, one line with its whitespace evened out
  -- (as the page sends it), at most the page's 400 counted as the page and Gusto count them (a character
  -- past U+FFFF, such as most emoji, counts two), which still fits Gusto's 560 with the app's
  -- "Note from <email>: " in front
  if v_action = 'note' then
    v_note := nullif(btrim(regexp_replace(coalesce(p_note, ''), v_ws, ' ', 'g')), '');
    if v_note is null then
      raise exception 'Write the note first';
    end if;
    v_wide := (select count(*)::int from regexp_split_to_table(v_note, '') c where ascii(c) > 65535);
    if length(v_note) > 400 - v_wide then
      raise exception 'A note can be at most 400 characters';
    end if;
  elsif length(v_note) > 500 then
    raise exception 'The reason can be at most 500 characters';
  end if;
  -- the start of a line this app writes in Gusto's note (where ts-edit-plan.mjs, ca-ts-core.mjs and the page
  -- find one, in the text as the browser task sends it) would show what was typed as a line someone else
  -- wrote through this app
  if regexp_replace(coalesce(v_note, ''), v_ws, ' ', 'g')
       ~ 'Changed through Wizard Trees Manager Timesheets for ([^ :@]+@[^ :]+|a manager)|Note from ([^ :@]+@[^ :]+):' then
    raise exception 'Leave "Note from <email>:" and "Changed through Wizard Trees Manager Timesheets for" out of the %: the board would show them as lines written through this app',
      case when v_action = 'note' then 'note' else 'reason' end;
  end if;
  if p_expect is not null and jsonb_typeof(p_expect) <> 'null' then
    if jsonb_typeof(p_expect) <> 'array' then
      raise exception 'p_expect must be a list of edit ids (the changes of this shift that were waiting when you opened it)';
    end if;
    v_expect := array(select lower(btrim(x)) from jsonb_array_elements_text(p_expect) x);
  end if;

  -- what: the shift
  if v_action not in ('update', 'add', 'delete', 'note') then
    raise exception 'The action must be update, add, delete or note';
  end if;
  if v_action = 'add' then
    if v_shift_id is not null then
      raise exception 'A new shift has no Gusto shift id yet: leave the shift id empty to add one';
    end if;
  else
    if v_shift_id is null and v_action = 'note' then
      raise exception 'Say which shift the note is for';
    end if;
    if v_shift_id is null then
      raise exception 'Say which shift to %', v_action;
    end if;
    select e.s into v_shift
      from jsonb_array_elements(case jsonb_typeof(d.shifts) when 'array' then d.shifts else '[]'::jsonb end) as e(s)
     where e.s->>'id' = v_shift_id
     limit 1;
    if v_shift is null then
      raise exception 'That shift is not on this day any more (it may have changed in Gusto). Reload and try again';
    end if;
    if v_shift->'hours_only' = 'true'::jsonb and v_action = 'note' then
      raise exception 'These are hours entered in Gusto without clock times: add the note in Gusto';
    end if;
    if v_shift->'hours_only' = 'true'::jsonb then
      raise exception 'These are hours entered in Gusto without clock times: change them in Gusto';
    end if;
    v_before := public.ts_edit_shape(v_shift, v_tz);
  end if;

  -- one submit per day at a time (ts_edit_cancel and ts_edit_mark take the same lock), so what is
  -- read below about the day's other edits still holds when this edit is saved
  perform pg_advisory_xact_lock(hashtext('ts_edit:' || d.id));

  if v_shift_id is not null then
    -- a worker is writing a change of this shift to Gusto right now: wait for it to finish
    if exists (select 1 from public.ts_edits e
                where e.day_id = d.id and e.shift_id = v_shift_id and 'applying' in (e.times_status, e.breaks_status)) then
      raise exception 'A change of this shift is being sent to Gusto right now. Try again in a few minutes';
    end if;
    -- Gusto no longer has the shift, the day row just does not know yet
    if exists (select 1 from public.ts_edits e
                where e.day_id = d.id and e.shift_id = v_shift_id and e.action = 'delete'
                  and e.breaks_status = 'applied' and e.breaks_applied_at > d.synced_at) then
      raise exception 'That shift was just deleted in Gusto. Reload after the next sync';
    end if;
    -- a note for a shift that is waiting to be deleted would have nowhere to go (the delete is older, so the
    -- browser task sends it first): the page offers no note there, a page opened before the delete gets this
    if v_action = 'note' and exists (select 1 from public.ts_edits e
                where e.day_id = d.id and e.shift_id = v_shift_id and e.action = 'delete' and e.breaks_status = 'pending') then
      raise exception 'That shift is waiting to be deleted, so a note has nowhere to go. Cancel the delete first';
    end if;
    -- the caller's page must have shown every change of this shift that is waiting now (notes are not
    -- changes of the shift: they never count here, and a note is never refused for a change since)
    if v_expect is not null and v_action <> 'note' and (
         exists (select 1 from public.ts_edits e
                  where e.day_id = d.id and e.shift_id = v_shift_id and e.action <> 'note'
                    and 'pending' in (e.times_status, e.breaks_status)
                    and not (e.id::text = any (v_expect)))
         or exists (select 1 from public.ts_edits e
                     where e.day_id = d.id and e.shift_id = v_shift_id and e.action <> 'note' and e.cancelled_at is not null
                       and e.id::text = any (v_expect))) then
      raise exception 'Someone changed this shift since you opened it. Reload and try again';
    end if;
    -- before = what Gusto has now: a part applied after the row's last sync is that edit's after (the job
    -- rides the times part, so an update whose times reached Gusto gave the shift its job too)
    select e.after into v_sent from public.ts_edits e
     where e.day_id = d.id and e.shift_id = v_shift_id and e.action = 'update'
       and e.times_status = 'applied' and e.times_applied_at > d.synced_at
     order by e.times_applied_at desc, e.created_at desc limit 1;
    if v_sent is not null then
      v_before := v_before || jsonb_build_object('in', v_sent->'in', 'out', v_sent->'out')
                  || case when jsonb_typeof(v_sent->'job') = 'object' then jsonb_build_object('job', v_sent->'job') else '{}'::jsonb end;
    end if;
    select e.after into v_sent from public.ts_edits e
     where e.day_id = d.id and e.shift_id = v_shift_id and e.action = 'update'
       and e.breaks_status = 'applied' and e.breaks_applied_at > d.synced_at
     order by e.breaks_applied_at desc, e.created_at desc limit 1;
    if v_sent is not null then
      v_before := v_before || jsonb_build_object('breaks', v_sent->'breaks');
    end if;
    -- a note goes to Gusto with the shift's own start and end: a shift still clocked in has no end yet
    if v_action = 'note' and (v_before->>'in' is null or v_before->>'out' is null) then
      raise exception 'This shift is still clocked in: add the note once it has an end';
    end if;
  end if;

  -- the desired state (a delete and a note have none)
  if v_action not in ('delete', 'note') then
    if p_after is null or jsonb_typeof(p_after) <> 'object' then
      raise exception 'Give the shift''s start, end and breaks';
    end if;
    v_in  := public.ts_edit_ts(p_after->'in', 'Start');
    v_out := public.ts_edit_ts(p_after->'out', 'End');
    if v_in is null then raise exception 'Start is missing'; end if;
    if v_out is null then raise exception 'End is missing'; end if;
    if v_out <= v_in then raise exception 'End must be after start'; end if;
    v_day_in := (v_in at time zone v_tz)::date;
    if v_day_in <> d.work_date
       and (v_before is null or v_before->>'in' is null
            or v_day_in <> ((v_before->>'in')::timestamptz at time zone v_tz)::date) then
      raise exception 'Start must be on %', to_char(d.work_date, 'Dy Mon FMDD');
    end if;
    if (v_out at time zone v_tz)::date = v_day_in then
      null;
    elsif (v_out at time zone v_tz)::date = v_day_in + 1 and v_out - v_in <= interval '16 hours' then
      null;
    else
      raise exception 'A shift must end the same day, or overnight within 16 hours of its start';
    end if;
    if v_out > now() + interval '5 minutes' then
      raise exception 'End cannot be later than now';
    end if;

    if jsonb_typeof(p_after->'breaks') is distinct from 'array' then
      raise exception 'Breaks must be a list (an empty list for none)';
    end if;
    if jsonb_array_length(p_after->'breaks') > 6 then
      raise exception 'A shift can have at most 6 breaks';
    end if;
    for v_brk, v_ord in select e, o from jsonb_array_elements(p_after->'breaks') with ordinality t(e, o) loop
      if jsonb_typeof(v_brk) <> 'object' then
        raise exception 'Break %: give its start, end and type', v_ord;
      end if;
      v_bs := public.ts_edit_ts(v_brk->'start', format('Break %s start', v_ord));
      v_be := public.ts_edit_ts(v_brk->'end', format('Break %s end', v_ord));
      if v_bs is null or v_be is null then
        raise exception 'Break %: needs a start and an end', v_ord;
      end if;
      v_kind := case when jsonb_typeof(v_brk->'kind') = 'string' then lower(btrim(v_brk->>'kind')) end;
      if v_kind is null or v_kind not in ('rest', 'meal') then
        raise exception 'Break %: the type must be rest (paid) or meal (unpaid)', v_ord;
      end if;
      if v_be - v_bs < interval '1 minute' or v_be - v_bs > interval '240 minutes' then
        raise exception 'Break %: must be 1 to 240 minutes long', v_ord;
      end if;
      -- inside the shift to the minute: Gusto records some breaks a few seconds before the clock-in
      -- (or after the clock-out) in the same minute, and the board counts those as inside
      if v_bs < v_in or v_be > v_out then
        if public.ts_edit_min(v_bs) < public.ts_edit_min(v_in) or public.ts_edit_min(v_be) > public.ts_edit_min(v_out) then
          raise exception 'Break %: must be inside the shift (% to %)', v_ord,
            public.ts_edit_hm(v_in, v_tz), public.ts_edit_hm(v_out, v_tz);
        end if;
      end if;
      v_breaks := v_breaks || jsonb_build_array(jsonb_build_object(
        'start', public.ts_edit_iso(v_bs, v_tz), 'end', public.ts_edit_iso(v_be, v_tz), 'kind', v_kind));
    end loop;
    -- in time order, each break starts at or after the minute the one before it ends
    select coalesce(jsonb_agg(b order by (b->>'start')::timestamptz, (b->>'end')::timestamptz), '[]'::jsonb)
      into v_breaks from jsonb_array_elements(v_breaks) b;
    v_prev := null;
    for v_brk in select b from jsonb_array_elements(v_breaks) b loop
      if v_prev is not null
         and public.ts_edit_min((v_brk->>'start')::timestamptz) < public.ts_edit_min((v_prev->>'end')::timestamptz) then
        raise exception 'Breaks cannot overlap (the % break and the % break)',
          public.ts_edit_hm((v_prev->>'start')::timestamptz, v_tz), public.ts_edit_hm((v_brk->>'start')::timestamptz, v_tz);
      end if;
      v_prev := v_brk;
    end loop;
    -- the job: left out or null = an update keeps the shift's job (before's) and an add leaves it to the
    -- worker; else {id}, one of the person's Gusto jobs (the shift's own job again is the same as none),
    -- stored as {id, title} with the title as ts_people has it, never the one sent
    if coalesce(jsonb_typeof(p_after->'job'), 'null') = 'null' then
      v_job := v_before->'job';
    elsif jsonb_typeof(p_after->'job'->'id') = 'string' and p_after->'job'->>'id' = v_before->'job'->>'id' then
      v_job := v_before->'job';
    else
      select tp.jobs into v_jobs from public.ts_people tp
       where tp.company = d.company and tp.employee_uuid = d.employee_uuid;
      if v_jobs is null then
        raise exception 'This person''s Gusto jobs are not loaded yet, so the job can''t be changed here.';
      end if;
      select j into v_pick from jsonb_array_elements(v_jobs) j
       where jsonb_typeof(p_after->'job'->'id') = 'string' and j->>'id' = p_after->'job'->>'id'
       limit 1;
      if v_pick is null then
        raise exception 'That job is not one of this person''s jobs in Gusto.';
      end if;
      if (v_pick->>'start')::date > d.work_date then
        raise exception 'That job starts on % in Gusto, after this day.', to_char((v_pick->>'start')::date, 'Mon FMDD');
      end if;
      v_job := jsonb_build_object('id', v_pick->>'id', 'title', coalesce(v_pick->>'title', ''));
    end if;
    v_after := jsonb_build_object('in', public.ts_edit_iso(v_in, v_tz), 'out', public.ts_edit_iso(v_out, v_tz),
                                  'breaks', v_breaks)
               || case when v_job is null then '{}'::jsonb else jsonb_build_object('job', v_job) end;
  end if;

  -- which parts change (against what Gusto has now); a delete and a note ride the breaks part, a change
  -- of the job rides the times part (ts_edit_key's times carry the job)
  if v_action in ('delete', 'note') then
    v_times := 'none'; v_brks := 'pending';
  elsif v_action = 'add' then
    v_times := 'pending';
    v_brks  := case when jsonb_array_length(v_after->'breaks') > 0 then 'pending' else 'none' end;
  else
    v_times := case when public.ts_edit_key(v_before, 'times') = public.ts_edit_key(v_after, 'times') then 'none' else 'pending' end;
    v_brks  := case when public.ts_edit_key(v_before, 'breaks') = public.ts_edit_key(v_after, 'breaks') then 'none' else 'pending' end;
  end if;

  -- (a waiting note is no change to go back from)
  select count(*) into v_pending from public.ts_edits e
   where e.day_id = d.id and e.shift_id = v_shift_id and e.action <> 'note' and 'pending' in (e.times_status, e.breaks_status);
  if v_times = 'none' and v_brks = 'none' and v_pending = 0 then
    raise exception 'Nothing changed: the shift already has these times and breaks';
  end if;
  if v_action = 'add' and exists (
       select 1 from public.ts_edits e
        where e.day_id = d.id and e.action = 'add'
          and 'pending' in (e.times_status, e.breaks_status)
          and public.ts_edit_key(e.after, 'times') = public.ts_edit_key(v_after, 'times')
          and public.ts_edit_key(e.after, 'breaks') = public.ts_edit_key(v_after, 'breaks')) then
    raise exception 'This shift is already waiting to be added';
  end if;

  -- no overlap with the day's other shifts as they will be once the waiting edits land: the row's
  -- shifts (not this one, not hours-only, not one waiting to be or just deleted) with the times of
  -- their latest waiting or just-applied update, plus the shifts waiting to be (or just) added
  if v_action not in ('delete', 'note') then
    select o.s_in, o.s_out into v_o_in, v_o_out
      from (select coalesce(u.after->>'in', s->>'in')::timestamptz as s_in,
                   coalesce(u.after->>'out', s->>'out')::timestamptz as s_out
              from jsonb_array_elements(case jsonb_typeof(d.shifts) when 'array' then d.shifts else '[]'::jsonb end) s
              left join lateral (
                     select e.after from public.ts_edits e
                      where e.day_id = d.id and e.shift_id = s->>'id' and e.action = 'update'
                        and (e.times_status in ('pending', 'applying')
                             or (e.times_status = 'applied' and e.times_applied_at > d.synced_at))
                      order by e.created_at desc, e.id desc limit 1) u on true
             where jsonb_typeof(s) = 'object'
               and s->>'id' is distinct from v_shift_id
               and (s->'hours_only') is distinct from 'true'::jsonb
               and not exists (select 1 from public.ts_edits e
                                where e.day_id = d.id and e.shift_id = s->>'id' and e.action = 'delete'
                                  and (e.breaks_status in ('pending', 'applying')
                                       or (e.breaks_status = 'applied' and e.breaks_applied_at > d.synced_at)))
            union all
            select (e.after->>'in')::timestamptz, (e.after->>'out')::timestamptz
              from public.ts_edits e
             where e.day_id = d.id and e.action = 'add'
               and (e.times_status in ('pending', 'applying')
                    or (e.times_status = 'applied' and e.times_applied_at > d.synced_at))) o
     where o.s_in is not null and o.s_out is not null
       and public.ts_edit_min(v_in) < public.ts_edit_min(o.s_out)
       and public.ts_edit_min(o.s_in) < public.ts_edit_min(v_out)
     order by o.s_in
     limit 1;
    if found then
      raise exception 'This shift overlaps the % to % shift', public.ts_edit_hm(v_o_in, v_tz), public.ts_edit_hm(v_o_out, v_tz);
    end if;
  end if;

  -- supersede (a note never replaces a waiting change, and is never replaced by one)
  update public.ts_edits e
     set times_status  = case when e.times_status  = 'pending' then 'cancelled' else e.times_status end,
         breaks_status = case when e.breaks_status = 'pending' then 'cancelled' else e.breaks_status end,
         cancelled_by = 'superseded', cancelled_at = now()
   where e.day_id = d.id and e.shift_id = v_shift_id and 'pending' in (e.times_status, e.breaks_status)
     and v_action <> 'note' and e.action <> 'note';

  insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, shift_id,
                               action, before, after, note, times_status, breaks_status, created_by)
  values (d.id, d.company, d.region, d.employee_uuid, d.department, d.work_date, v_shift_id,
          v_action, v_before, v_after, v_note, v_times, v_brks, v_me)
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.ts_edit_submit(text, text, text, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.ts_edit_submit(text, text, text, jsonb, text, jsonb) to authenticated;   -- body checks the caller

notify pgrst, 'reload schema';

commit;

-- Post-apply checks (all read-only):
--   select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.ts_people'::regclass
--      and attname = 'jobs';   -- jsonb
--   then run supabase/ts-edit-jobs-verify.sql, ts-edits-verify.sql, ts-edits-clear-verify.sql, ts-pay-periods-verify.sql
--   and ts-ca-timesheets-verify.sql: every row pass = true, and each rolls back. The one exception is A6 in
--   ts-ca-timesheets-verify.sql, which fails before and after this file (its list lacks ts_pay_periods_sync; A3b in
--   ts-edit-jobs-verify.sql passes when that is the only difference).
