-- Manager Timesheets (timesheets.html): a forgotten clock-out that Gusto ran past midnight into the NEXT pay period, fixed from
-- the app with a new end on its first day.
-- (Gianni 2026-11-21: "yes, give me a way to fix this from the app") A New York person clocked in on a Friday morning and never
-- clocked out. Gusto keeps a shift still running at midnight as ONE id shown on two days: from the clock-in to 11:59:59 PM on
-- day N, and from 12:00:00 AM on day N+1 (there still clocked in, or ended by a later tap). That Friday was the last day of a
-- pay period, so the 12:00 AM part is in the next one. Within one pay period the page already fixes such a shift with a new end
-- on day N's part (the edit worker's 'midnight-split': one save that moves the shift's clock-out, both days at once); the
-- worker reads and saves one pay period at a time, so it refused this case, and the page said to fix it in Gusto.
--
-- Needs every earlier ts-*.sql file, ts-edit-whole-shift-blank-day.sql last of them (the guard below checks for it). Re-run this
-- file after any of them. Safe to re-run (create or replace). This file re-creates the ts_edit_submit of
-- ts-edit-whole-shift-blank-day.sql, the latest one, with the same single signature, unchanged except as below. No new table,
-- column, constraint, policy, function or grant; the ts_edits_select policy is not touched.
-- Apply on the CA project from Gianni's computer, and only after the edit worker on his Mac knows
-- before.carried on an update (~/gusto-sync/ts-edit-plan.mjs isCrossEnd and the 'midnight-split-cross' kind). An older worker
-- refuses such an edit as a period-edge conflict and sends nothing, which is safe. Then run
-- supabase/ts-edit-cross-period-midnight-verify.sql, plus ts-edit-whole-shift-blank-day-verify.sql, ts-edit-start-waits-verify.sql,
-- ts-edit-jobs-verify.sql, ts-edits-verify.sql, ts-edits-clear-verify.sql, ts-pay-periods-verify.sql and
-- ts-flag-dismissals-verify.sql (each rolls back), and check every row says pass.
--
-- What changes: the end fix of a first day that ends a pay period
--   No marker: such a fix is found by its shape. An UPDATE that gives the shift an end (after.out is a time, not a start alone)
--   is one when ALL of these hold:
--     a. day N is the last day of a pay period (periods end on the Fridays 2026-10-09 + 14k, as in ts_edit_window), and the part
--        ends 11:59:59 PM and does not start 12:00 AM (midnight on the row zone's clock, or as Gusto wrote the punch), on the day
--        row and on what Gusto has now (the usual applied-after-sync merge: a new end sent there since the last sync makes it a
--        plain update);
--     b. day N+1 has a row, the caller can see it on its own company, department and person, and it shows the same id, punched
--        (not hours only), from 12:00 AM.
--   When any of these fails, the update is stored exactly as before (no carried part), and no new answer tells about a day the
--   caller cannot see. So is one that puts the part back exactly as Gusto has it (start, end and breaks to the minute, the job
--   left out or the same: the page's take-back of a waiting fix, which then replaces it). When all hold, it takes the lock of
--   day N, then of day N+1 (always in that order, as a whole delete does), and it is refused, in this order, when:
--     day N does not carry the sync's midnight_split flag, or (the flag is per day, not per shift) the 12:00 AM part has a
--     clock-out and this shift does not look like a missed clock-out by the sync's rule, as a whole delete checks it: over
--     14 hours from its start to that end, or a new clock-in on day N+1 within 5 minutes of it, and day N+1 flagged too (a
--     12:00 AM part still clocked in is the shift's own sign: the sync flags every chain whose last part is still open);
--     the 12:00 AM part ends 11:59:59 PM again (a shift on more than two days);
--     the 12:00 AM part has a break (a new end on day N would leave it outside the shift);
--     day N+1 is in the future;
--     another change of that id on day N+1 (notes aside) is waiting, being sent, or was sent after that row's last sync;
--     Gusto has closed day N+1's pay period (ts_edit_period_closed);
--     and, once the new times are read, the new end is not on day N before 11:59 PM.
--   It is stored as an ordinary update of day N's part (action 'update', day_id day N's id, the usual times and breaks status),
--   with before = the first part as Gusto has it now plus before.carried = the 12:00 AM part as the caller saw it, in the same
--   shape {in, out, breaks, job?} (out null while it still runs), and its day {date: 'YYYY-MM-DD'} (the shape a whole delete
--   uses; on a delete before.carried still means a whole delete). The payroll guard on day N works as before: a pay period sent
--   to payroll still takes it (the daily list asks for the payroll to be checked), a processed or locked one refuses it.
--   The worker reads both pay periods, checks Gusto's 12:00 AM part against before.carried, and sends the one save of day N's
--   part with the new end, a new write kind 'midnight-split-cross' that stays held from the scheduled runs until Gianni watches a
--   supervised run, in California and New York apart.
--   While such a fix waits, is being sent, or was sent after day N+1's last sync, nothing else changes that id on day N+1 (a
--   note neither), as for a whole delete: the fix takes that part away.
--
-- Refused, in these words (new in this file):
--   Only a shift the sync marked as a likely missed clock-out can have its end fixed here across two pay periods. Fix it in Gusto
--   Gusto has a break after midnight on this shift (on <Dy Mon D>), which a new end here would leave outside it. Fix it in Gusto
--   The rest of this shift (on <Dy Mon D>) is in a pay period Gusto has closed, so its end cannot be fixed here. Fix it in Gusto
--   This shift ran past midnight in Gusto: end it before midnight on <Dy Mon D> here (that fixes both days at once). To end it after midnight, change it in Gusto
--   The end of this shift waits to be fixed from <Dy Mon D>. Cancel that change first, or reload after the next sync      (on day N+1)
-- and, in the words they already had:
--   Gusto keeps this shift on more than two days under one id. Change it in Gusto
--   You cannot edit a day that has not happened yet          (day N+1 is in the future)
--   A change of this shift on <Dy Mon D> is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again
-- Every other rule holds as before (a whole delete still refuses a shift across two pay periods).
--
-- Until this file is applied such a fix is stored as a plain update; the page takes it back at once and says to fix the end in
-- Gusto.

begin;

do $$ begin
  if to_regclass('public.ts_edits') is null or to_regprocedure('public.ts_edit_shape(jsonb,text)') is null
     or to_regprocedure('public.ts_edit_key(jsonb,text)') is null or to_regprocedure('public.ts_edit_window(text,date)') is null
     or to_regprocedure('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)') is null then
    raise exception 'Apply supabase/ts-edits.sql first';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_edits'::regclass
                    and c.conname = 'ts_edits_action_check' and pg_get_constraintdef(c.oid) like '%''note''%') then
    raise exception 'Apply supabase/ts-edit-notes.sql first';
  end if;
  if to_regclass('public.ts_people') is null
     or not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.ts_people')
                       and a.attname = 'jobs' and not a.attisdropped) then
    raise exception 'Apply supabase/ts-edit-jobs.sql first';
  end if;
  if to_regprocedure('public.ts_edit_period_closed(text,date)') is null then
    raise exception 'Apply supabase/ts-pay-periods.sql first';
  end if;
  if pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) not like '%v_start_only%' then
    raise exception 'Apply supabase/ts-edit-start-waits.sql first';
  end if;
  if pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) not like '%v_whole%'
     or pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) not like '%v_blank%' then
    raise exception 'Apply supabase/ts-edit-whole-shift-blank-day.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- ts_edit_submit with the end fix of a first day that ends a pay period (the function of
-- supabase/ts-edit-whole-shift-blank-day.sql, plus that)
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
  -- (Gianni 2026-11-09: clock-in tap fix) an update with no end: only the start of a shift still clocked in changes
  v_start_only boolean := false;
  -- (Gianni 2026-11-16: hours for someone with no time that day) an add on a day with no ts_days row yet
  v_blank    boolean := false;
  v_person   public.ts_people%rowtype;
  v_region   text;
  v_wd       date;
  -- (Gianni 2026-11-16: whole-shift delete) a forgotten clock-out Gusto ran past midnight, deleted from both days
  v_whole    boolean := false;
  v_next     public.ts_days%rowtype;
  v_next_id  text;
  v_carried  jsonb;
  v_c_out    timestamptz;
  -- (Gianni 2026-11-21: cross-period end fix) the first day's part of a forgotten clock-out Gusto ran past midnight into the
  -- next pay period, given its real end: it reuses v_next, v_next_id and v_carried
  v_cross    boolean := false;
  -- the reason the page sends with "Delete the whole shift" (timesheets.html DELETE_WHOLE_NOTE, ts-edit-plan.mjs
  -- DELETE_WHOLE_NOTE): byte for byte the same in all three
  c_whole    constant text := 'Delete the whole shift on both days';
  -- a run of whitespace as JavaScript's \s finds it (the page's cleanNoteText, the browser task's noteFor)
  v_ws       constant text := '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+';
begin
  -- who: an active allowlisted Google sign-in (automation@ has no ts_access row)
  if v_me is null or not exists (select 1 from public.ts_access a where a.email = v_me and a.active) then
    raise exception 'Only timesheet sign-ins can edit timesheets' using errcode = '42501';
  end if;
  -- which day: one the caller can see (a missing day and a hidden day get the same answer)
  select * into d from public.ts_days t where t.id = p_day_id;
  if not found then
    -- (Gianni 2026-11-16: hours for someone with no time that day) an add on a day the sync has not written: the id is
    -- '<company>:<employee_uuid>:<YYYY-MM-DD>' (the id the sync gives that day's row later), its date is a real date, and
    -- it names an active person the caller can see, at a company in ts_companies. The day is made up here, empty, and
    -- never stored. Anything else gets the same answer as a hidden day, and before the window check, so the answer never
    -- tells whether a person exists. A real row, when there is one, always wins (it is read first).
    if v_action = 'add' and p_day_id ~ '^[a-z0-9_]+:[A-Za-z0-9_-]{1,64}:[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      begin
        v_wd := to_date(split_part(p_day_id, ':', 3), 'YYYY-MM-DD');
      exception when others then
        v_wd := null;
      end;
      if v_wd is not null and to_char(v_wd, 'YYYY-MM-DD') = split_part(p_day_id, ':', 3) then
        select * into v_person from public.ts_people p
         where p.company = split_part(p_day_id, ':', 1) and p.employee_uuid = split_part(p_day_id, ':', 2);
        if found and v_person.active
           and coalesce(public.ts_can_view(v_person.company, coalesce(v_person.department, 'No department'), v_person.employee_uuid), false) then
          select c.region into v_region from public.ts_companies c where c.key = v_person.company;
          if found then
            d.id            := p_day_id;
            d.company       := v_person.company;
            d.region        := coalesce(v_region, 'CA');
            d.employee_uuid := v_person.employee_uuid;
            d.employee_name := v_person.name;
            d.department    := coalesce(v_person.department, 'No department');
            d.work_date     := v_wd;
            d.shifts        := '[]'::jsonb;
            d.flags         := '[]'::jsonb;
            -- no sync yet: every applied add of this day id still counts in the overlap and duplicate checks below
            d.synced_at     := '-infinity'::timestamptz;
            v_blank := true;
          end if;
        end if;
      end if;
    end if;
    if not v_blank then
      raise exception 'No such day, or you cannot edit it' using errcode = '42501';
    end if;
  elsif not coalesce(public.ts_can_view(d.company, d.department, d.employee_uuid), false) then
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
  -- (Gianni 2026-11-16: whole-shift delete) a delete whose reason starts with the marker (in any case) asks for the whole
  -- shift, on this day and the next
  v_whole := v_action = 'delete' and v_note is not null and left(lower(v_note), length(c_whole)) = lower(c_whole);
  if v_whole then
    v_next_id := d.company || ':' || d.employee_uuid || ':' || to_char(d.work_date + 1, 'YYYY-MM-DD');
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
  -- (Gianni 2026-11-21: cross-period end fix) an update that gives a shift an end, on the last day of a pay period (periods end
  -- on the Fridays 2026-10-09 + 14k, as in ts_edit_window), of a part that ends 11:59:59 PM and does not start 12:00 AM (on the
  -- row zone's clock, or as Gusto wrote the punch): a first look at the day row's shift (checked again below, on what Gusto has
  -- now and on the next day's row)
  v_cross := coalesce(v_action = 'update' and v_shift is not null
                      and jsonb_typeof(p_after) = 'object' and jsonb_typeof(p_after->'out') = 'string'
                      and mod(d.work_date - date '2026-10-09', 14) = 0
                      and (coalesce(to_char(public.ts_edit_ts(v_shift->'out', 'End') at time zone v_tz, 'HH24:MI:SS') = '23:59:59', false)
                           or coalesce(v_shift->>'out' ~ '[T ]23:59:59', false))
                      and not (coalesce(to_char(public.ts_edit_ts(v_shift->'in', 'Start') at time zone v_tz, 'HH24:MI:SS') = '00:00:00', false)
                               or coalesce(v_shift->>'in' ~ '[T ]00:00:00', false)), false);
  if v_cross then
    v_next_id := d.company || ':' || d.employee_uuid || ':' || to_char(d.work_date + 1, 'YYYY-MM-DD');
  end if;

  -- one submit per day at a time (ts_edit_cancel and ts_edit_mark take the same lock), so what is
  -- read below about the day's other edits still holds when this edit is saved
  perform pg_advisory_xact_lock(hashtext('ts_edit:' || d.id));
  -- (Gianni 2026-11-16: whole-shift delete) and the next day's: day N always before day N+1, so the order is fixed and two
  -- submits never wait on each other in a circle (2026-11-21: a cross-period end fix too)
  if v_whole or v_cross then
    perform pg_advisory_xact_lock(hashtext('ts_edit:' || v_next_id));
  end if;

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
    -- (Gianni 2026-11-16: whole-shift delete) this is the 12:00 AM part of a shift that waits to be deleted as a whole
    -- from the day before (or was, after this row's last sync): nothing else changes it here meanwhile
    if exists (select 1 from public.ts_edits e
                where e.day_id = d.company || ':' || d.employee_uuid || ':' || to_char(d.work_date - 1, 'YYYY-MM-DD')
                  and e.shift_id = v_shift_id and e.action = 'delete'
                  and jsonb_typeof(e.before->'carried') = 'object'
                  and (e.breaks_status in ('pending', 'applying')
                       or (e.breaks_status = 'applied' and e.breaks_applied_at > d.synced_at))) then
      raise exception 'This shift waits to be deleted as a whole from %. Cancel that change first, or reload after the next sync',
        to_char(d.work_date - 1, 'Dy Mon FMDD');
    end if;
    -- (review 2026-11-21) or the 12:00 AM part of a shift whose end waits to be fixed from the day before, across two pay
    -- periods (an update with before.carried, waiting, being sent, or sent after this row's last sync): that fix takes this
    -- part away, so nothing else changes it here meanwhile (a note neither: it would have nowhere to go)
    if exists (select 1 from public.ts_edits e
                where e.day_id = d.company || ':' || d.employee_uuid || ':' || to_char(d.work_date - 1, 'YYYY-MM-DD')
                  and e.shift_id = v_shift_id and e.action = 'update'
                  and jsonb_typeof(e.before->'carried') = 'object'
                  and ('pending' in (e.times_status, e.breaks_status) or 'applying' in (e.times_status, e.breaks_status)
                       or (e.times_status = 'applied' and e.times_applied_at > d.synced_at)
                       or (e.breaks_status = 'applied' and e.breaks_applied_at > d.synced_at))) then
      raise exception 'The end of this shift waits to be fixed from %. Cancel that change first, or reload after the next sync',
        to_char(d.work_date - 1, 'Dy Mon FMDD');
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
      -- (Gianni 2026-11-09: clock-in tap fix) a start alone has no end: the row's own end stays
      v_before := v_before || jsonb_build_object('in', v_sent->'in',
                                                 'out', case when jsonb_typeof(v_sent->'out') = 'string' then v_sent->'out' else v_before->'out' end)
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

  -- (Gianni 2026-11-21: cross-period end fix) still the first day's part as Gusto has it now (a new end sent there since the
  -- last sync makes this a plain update), and the next day's row, one the caller can see on its own company, department and
  -- person, shows the same id, punched (not hours only), from 12:00 AM. Anything else: the update is stored exactly as before,
  -- with no carried part, and nothing below tells about a day the caller cannot see.
  if v_cross and not (coalesce(to_char((v_before->>'out')::timestamptz at time zone v_tz, 'HH24:MI:SS') = '23:59:59', false)
                      or coalesce(v_shift->>'out' ~ '[T ]23:59:59' and (v_shift->>'out')::timestamptz = (v_before->>'out')::timestamptz, false)) then
    v_cross := false;
  end if;
  -- (review 2026-11-21) the part put back exactly as Gusto has it (start, end and breaks to the minute, the job left out or the
  -- same): the page's take-back of a waiting fix, stored as a plain update (it replaces the fix that waits, else "Nothing
  -- changed"), with no carried part and none of the checks below. Anything it cannot read is not a put-back: the checks below
  -- then say what is wrong with it.
  if v_cross then
    begin
      if jsonb_typeof(p_after->'breaks') = 'array'
         and public.ts_edit_min(public.ts_edit_ts(p_after->'in', 'Start')) = public.ts_edit_min((v_before->>'in')::timestamptz)
         and public.ts_edit_min(public.ts_edit_ts(p_after->'out', 'End')) = public.ts_edit_min((v_before->>'out')::timestamptz)
         and (coalesce(jsonb_typeof(p_after->'job'), 'null') = 'null' or p_after->'job'->>'id' is not distinct from v_before->'job'->>'id')
         and public.ts_edit_key(jsonb_build_object('breaks', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'start', b->'start', 'end', b->'end', 'kind', to_jsonb(lower(btrim(b->>'kind'))))), '[]'::jsonb)
                                  from jsonb_array_elements(p_after->'breaks') b)), 'breaks')
             = public.ts_edit_key(v_before, 'breaks') then
        v_cross := false;
      end if;
    exception when others then
      null;
    end;
  end if;
  if v_cross then
    select * into v_next from public.ts_days t where t.id = v_next_id;
    if not found or not coalesce(public.ts_can_view(v_next.company, v_next.department, v_next.employee_uuid), false) then
      v_cross := false;
    end if;
  end if;
  if v_cross then
    select e.s into v_carried
      from jsonb_array_elements(case jsonb_typeof(v_next.shifts) when 'array' then v_next.shifts else '[]'::jsonb end) as e(s)
     where jsonb_typeof(e.s) = 'object' and e.s->>'id' = v_shift_id
     limit 1;
    if v_carried is null or coalesce(v_next.hours_only, false) or v_carried->'hours_only' = 'true'::jsonb
       or not (coalesce(v_carried->>'in' ~ '[T ]00:00:00', false)
               or coalesce(to_char(public.ts_edit_ts(v_carried->'in', 'Start') at time zone v_tz, 'HH24:MI:SS') = '00:00:00', false)) then
      v_cross := false;
    end if;
  end if;
  -- the checks, in this order (see the header), then before carries the 12:00 AM part as the caller saw it (its out null while
  -- it still runs) and its day: what the worker checks Gusto's next pay period against before it closes the shift
  if v_cross then
    if not coalesce(d.flags @> '[{"code": "midnight_split"}]'::jsonb, false) then
      raise exception 'Only a shift the sync marked as a likely missed clock-out can have its end fixed here across two pay periods. Fix it in Gusto';
    end if;
    -- (review 2026-11-21) the sync's flag is per day, not per shift (as for a whole delete below): day N can carry it for
    -- ANOTHER shift while this one is real overnight work. A 12:00 AM part still clocked in is this shift's own sign (the sync
    -- flags every chain whose last part is still open). One with a clock-out must look like a missed clock-out by the sync's
    -- rule, as a whole delete checks it: over 14 hours from the start to that end, counted to the minute, or a new clock-in on
    -- day N+1 within 5 minutes of it; and day N+1 carries the flag too.
    if v_carried->>'out' is not null then
      v_c_out := public.ts_edit_ts(v_carried->'out', 'End');
      if not coalesce(v_next.flags @> '[{"code": "midnight_split"}]'::jsonb, false)
         or not coalesce(public.ts_edit_min(v_c_out) - public.ts_edit_min((v_before->>'in')::timestamptz) > 840
                 or exists (select 1
                              from jsonb_array_elements(case jsonb_typeof(v_next.shifts) when 'array' then v_next.shifts else '[]'::jsonb end) y
                             where jsonb_typeof(y) = 'object' and y->>'id' is distinct from v_shift_id
                               and (y->'hours_only') is distinct from 'true'::jsonb and jsonb_typeof(y->'in') = 'string'
                               and (y->>'in')::timestamptz >= v_c_out
                               and (y->>'in')::timestamptz <= v_c_out + interval '5 minutes'), false) then
        raise exception 'Only a shift the sync marked as a likely missed clock-out can have its end fixed here across two pay periods. Fix it in Gusto';
      end if;
    end if;
    if coalesce(v_carried->>'out' ~ '[T ]23:59:59', false)
       or coalesce(to_char(public.ts_edit_ts(v_carried->'out', 'End') at time zone v_tz, 'HH24:MI:SS') = '23:59:59', false) then
      raise exception 'Gusto keeps this shift on more than two days under one id. Change it in Gusto';
    end if;
    if exists (select 1 from jsonb_array_elements(case jsonb_typeof(v_carried->'breaks') when 'array' then v_carried->'breaks' else '[]'::jsonb end) b
                where jsonb_typeof(b) = 'object') then
      raise exception 'Gusto has a break after midnight on this shift (on %), which a new end here would leave outside it. Fix it in Gusto',
        to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    if v_next.work_date > v_today then
      raise exception 'You cannot edit a day that has not happened yet';
    end if;
    -- nothing else of this shift on the next day is waiting, being sent, or sent since that row's last sync (notes aside)
    if exists (select 1 from public.ts_edits e
                where e.day_id = v_next.id and e.shift_id = v_shift_id and e.action <> 'note'
                  and ('pending' in (e.times_status, e.breaks_status) or 'applying' in (e.times_status, e.breaks_status)
                       or (e.times_status = 'applied' and e.times_applied_at > v_next.synced_at)
                       or (e.breaks_status = 'applied' and e.breaks_applied_at > v_next.synced_at))) then
      raise exception 'A change of this shift on % is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again',
        to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    -- the next pay period still takes changes (the payroll guard below covers day N's)
    if public.ts_edit_period_closed(d.company, v_next.work_date) is not null then
      raise exception 'The rest of this shift (on %) is in a pay period Gusto has closed, so its end cannot be fixed here. Fix it in Gusto',
        to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    v_before := v_before || jsonb_build_object('carried', public.ts_edit_shape(v_carried, v_tz)
                                                          || jsonb_build_object('date', to_char(v_next.work_date, 'YYYY-MM-DD')));
  end if;

  -- (Gianni 2026-11-16: whole-shift delete) the first day's part of a shift Gusto ran past midnight under one id, from a
  -- forgotten clock-out, deleted with its 12:00 AM part on the next day (see the header). Midnight is read on the row
  -- zone's clock, or as Gusto wrote the punch (a punch in another zone keeps its own offset in the text).
  if v_whole then
    if not coalesce(d.flags @> '[{"code": "midnight_split"}]'::jsonb, false) then
      raise exception 'Only a shift the sync marked as a likely missed clock-out can be deleted as a whole here. Delete it in Gusto';
    end if;
    if not (coalesce(to_char((v_before->>'out')::timestamptz at time zone v_tz, 'HH24:MI:SS') = '23:59:59', false)
            or coalesce(v_shift->>'out' ~ '[T ]23:59:59' and (v_shift->>'out')::timestamptz = (v_before->>'out')::timestamptz, false))
       or coalesce(to_char((v_before->>'in')::timestamptz at time zone v_tz, 'HH24:MI:SS') = '00:00:00', false)
       or coalesce(v_shift->>'in' ~ '[T ]00:00:00' and (v_shift->>'in')::timestamptz = (v_before->>'in')::timestamptz, false) then
      raise exception 'Only the first day''s part of a shift Gusto ran past midnight can be deleted as a whole. Change it in Gusto';
    end if;
    -- the next day's row, one the caller can see on its own company, department and person
    select * into v_next from public.ts_days t where t.id = v_next_id;
    if not found or not coalesce(public.ts_can_view(v_next.company, v_next.department, v_next.employee_uuid), false) then
      raise exception 'The rest of this shift (on %) is not on a day you can change, so it cannot be deleted as a whole here. Delete it in Gusto',
        to_char(d.work_date + 1, 'Dy Mon FMDD');
    end if;
    -- the same id there, punched (not hours only), from 12:00 AM
    select e.s into v_carried
      from jsonb_array_elements(case jsonb_typeof(v_next.shifts) when 'array' then v_next.shifts else '[]'::jsonb end) as e(s)
     where jsonb_typeof(e.s) = 'object' and e.s->>'id' = v_shift_id
     limit 1;
    if v_carried is null or coalesce(v_next.hours_only, false) or v_carried->'hours_only' = 'true'::jsonb
       or not (coalesce(v_carried->>'in' ~ '[T ]00:00:00', false)
               or coalesce(to_char(public.ts_edit_ts(v_carried->'in', 'Start') at time zone v_tz, 'HH24:MI:SS') = '00:00:00', false)) then
      raise exception 'Gusto does not show the rest of this shift on %. Reload after the next sync', to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    if v_next.work_date > v_today then
      raise exception 'You cannot edit a day that has not happened yet';
    end if;
    if v_carried->>'out' is null then
      raise exception 'The rest of this shift (on %) is still clocked in, so it cannot be deleted here yet', to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    if coalesce(v_carried->>'out' ~ '[T ]23:59:59', false)
       or coalesce(to_char(public.ts_edit_ts(v_carried->'out', 'End') at time zone v_tz, 'HH24:MI:SS') = '23:59:59', false) then
      raise exception 'Gusto keeps this shift on more than two days under one id. Change it in Gusto';
    end if;
    -- (review 2026-11-16) the sync's flag is per day, not per shift: day N can carry it for ANOTHER shift (yesterday's
    -- missed clock-out carried into N at 12:00 AM) while this shift is real overnight work. So this shift must look like a
    -- missed clock-out by the sync's own rule for a two-day split that has a clock-out (~/gusto-sync/ca-ts-core.mjs, the
    -- midnight_split pass: LONG_DAY_MIN 840, RECLOCK_MS 5 minutes): from its start to the 12:00 AM part's end, counted to the
    -- minute as the sync counts it, is over 14 hours, or a new clock-in on day N+1 follows that end within 5 minutes. And
    -- day N+1 carries the flag too (the sync flags every day of a flagged shift that has a clock-out there).
    v_c_out := public.ts_edit_ts(v_carried->'out', 'End');
    if not coalesce(v_next.flags @> '[{"code": "midnight_split"}]'::jsonb, false)
       or not coalesce(public.ts_edit_min(v_c_out) - public.ts_edit_min((v_before->>'in')::timestamptz) > 840
               or exists (select 1
                            from jsonb_array_elements(case jsonb_typeof(v_next.shifts) when 'array' then v_next.shifts else '[]'::jsonb end) y
                           where jsonb_typeof(y) = 'object' and y->>'id' is distinct from v_shift_id
                             and (y->'hours_only') is distinct from 'true'::jsonb and jsonb_typeof(y->'in') = 'string'
                             and (y->>'in')::timestamptz >= v_c_out
                             and (y->>'in')::timestamptz <= v_c_out + interval '5 minutes'), false) then
      raise exception 'Only a shift the sync marked as a likely missed clock-out can be deleted as a whole here. Delete it in Gusto';
    end if;
    -- both days in one pay period: day N is not the last day of one (periods end on the Fridays 2026-10-09 + 14k, as in
    -- ts_edit_window), so the payroll guard on day N covers day N+1 too
    if mod(d.work_date - date '2026-10-09', 14) = 0 then
      raise exception 'The rest of this shift (on %) is in the next pay period, so it cannot be deleted as a whole here. Fix it in Gusto',
        to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    -- nothing else of this shift on the next day is waiting, being sent, or sent since that row's last sync
    if exists (select 1 from public.ts_edits e
                where e.day_id = v_next.id and e.shift_id = v_shift_id and e.action <> 'note'
                  and ('pending' in (e.times_status, e.breaks_status) or 'applying' in (e.times_status, e.breaks_status)
                       or (e.times_status = 'applied' and e.times_applied_at > v_next.synced_at)
                       or (e.breaks_status = 'applied' and e.breaks_applied_at > v_next.synced_at))) then
      raise exception 'A change of this shift on % is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again',
        to_char(v_next.work_date, 'Dy Mon FMDD');
    end if;
    -- before carries the 12:00 AM part and its day: what the worker deletes with the first part, and what it checks first
    v_before := v_before || jsonb_build_object('carried', public.ts_edit_shape(v_carried, v_tz)
                                                          || jsonb_build_object('date', to_char(v_next.work_date, 'YYYY-MM-DD')));
  end if;

  -- the desired state (a delete and a note have none)
  if v_action not in ('delete', 'note') then
    if p_after is null or jsonb_typeof(p_after) <> 'object' then
      raise exception 'Give the shift''s start, end and breaks';
    end if;
    v_in  := public.ts_edit_ts(p_after->'in', 'Start');
    v_out := public.ts_edit_ts(p_after->'out', 'End');
    if v_in is null then raise exception 'Start is missing'; end if;
    -- (Gianni 2026-11-09: clock-in tap fix) no end: a start alone, only for an update of a shift still clocked in, whose
    -- start changes and is not later than now (see the header)
    v_start_only := v_out is null and v_action = 'update' and v_shift is not null
                    and v_shift->>'out' is null and v_before->>'out' is null;
    if v_out is null and not v_start_only then raise exception 'End is missing'; end if;
    if v_start_only then
      if public.ts_edit_min(v_in) = public.ts_edit_min((v_before->>'in')::timestamptz) then
        raise exception 'This shift is still clocked in: without an end only its start can change, and this is the start it has';
      end if;
      if v_in > now() + interval '5 minutes' then
        raise exception 'Start cannot be later than now';
      end if;
    end if;
    if v_out <= v_in then raise exception 'End must be after start'; end if;
    -- (Gianni 2026-11-21: cross-period end fix) the new end is on day N, before 11:59 PM there (it closes the one Gusto shift,
    -- so both days are fixed at once; an end after midnight is a change of the next pay period)
    if v_cross and ((v_out at time zone v_tz)::date <> d.work_date or to_char(v_out at time zone v_tz, 'HH24:MI') >= '23:59') then
      raise exception 'This shift ran past midnight in Gusto: end it before midnight on % here (that fixes both days at once). To end it after midnight, change it in Gusto',
        to_char(d.work_date, 'Dy Mon FMDD');
    end if;
    v_day_in := (v_in at time zone v_tz)::date;
    if v_day_in <> d.work_date
       and (v_before is null or v_before->>'in' is null
            or v_day_in <> ((v_before->>'in')::timestamptz at time zone v_tz)::date) then
      raise exception 'Start must be on %', to_char(d.work_date, 'Dy Mon FMDD');
    end if;
    -- (a start alone has no end to check here)
    if v_start_only or (v_out at time zone v_tz)::date = v_day_in then
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
    if v_start_only then
      -- (Gianni 2026-11-09: clock-in tap fix) a start alone changes no break: the breaks sent are the shift's as the day
      -- row has them, to the minute (an open break stays open), and the row's own are stored, with their types as stored
      if (select coalesce(jsonb_agg(jsonb_build_array(public.ts_edit_min(public.ts_edit_ts(b->'start', 'Break start')),
                                                     public.ts_edit_min(public.ts_edit_ts(b->'end', 'Break end')))
                                    order by public.ts_edit_ts(b->'start', 'Break start'), public.ts_edit_ts(b->'end', 'Break end')), '[]'::jsonb)
            from jsonb_array_elements(p_after->'breaks') b)
         is distinct from
         (select coalesce(jsonb_agg(jsonb_build_array(public.ts_edit_min((b->>'start')::timestamptz),
                                                     public.ts_edit_min((b->>'end')::timestamptz))
                                    order by (b->>'start')::timestamptz, (b->>'end')::timestamptz), '[]'::jsonb)
            from jsonb_array_elements(case jsonb_typeof(v_before->'breaks') when 'array' then v_before->'breaks' else '[]'::jsonb end) b) then
        raise exception 'This shift is still clocked in: without an end only its start can change, so send its breaks as they are';
      end if;
      v_breaks := case jsonb_typeof(v_before->'breaks') when 'array' then v_before->'breaks' else '[]'::jsonb end;
      -- every break of the shift stays inside it with its new start, to the minute
      select b into v_brk from jsonb_array_elements(v_breaks) b
       where public.ts_edit_min((b->>'start')::timestamptz) < public.ts_edit_min(v_in)
       order by (b->>'start')::timestamptz limit 1;
      if v_brk is not null then
        raise exception 'The % break would be before the new start', public.ts_edit_hm((v_brk->>'start')::timestamptz, v_tz);
      end if;
    else
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
    end if;
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
      -- (Gianni 2026-11-09: clock-in tap fix) a start alone keeps the shift's job
      if v_start_only then
        raise exception 'This shift is still clocked in: without an end only its start can change, so its job stays as it is';
      end if;
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
  -- ((Gianni 2026-11-09: clock-in tap fix) a start alone, still clocked in, is checked from its new start to now)
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
       and public.ts_edit_min(o.s_in) < public.ts_edit_min(coalesce(v_out, now()))
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
--   select pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) like '%v_cross%'
--      and pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) like '%v_whole%'
--      and pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) like '%v_blank%'
--      and pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) like '%v_start_only%';   -- true
--   then run supabase/ts-edit-cross-period-midnight-verify.sql, ts-edit-whole-shift-blank-day-verify.sql,
--   ts-edit-start-waits-verify.sql, ts-edit-jobs-verify.sql, ts-edits-verify.sql, ts-edits-clear-verify.sql,
--   ts-pay-periods-verify.sql and ts-flag-dismissals-verify.sql: every row pass = true, and each rolls back.
