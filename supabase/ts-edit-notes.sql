-- Manager Timesheets (timesheets.html): a manager adds a note to a shift, and the note goes to Gusto.
-- Gianni 2026-10-29: "can we add the feature to add gusto notes and see gusto notes?" He had given someone 8 hours for
-- their final day in Gusto and left a note there, and a manager could not see it on the board. Seeing Gusto's notes
-- needs no database change (the timesheet sync puts each shift's notes inside ts_days.shifts); adding one is this file.
--
-- Needs supabase/ts-edits.sql (apply that first, then this). Safe to re-run: each check is replaced only while it does
-- not take 'note' yet, and the function is create or replace. supabase/ts-edits.sql carries the same change (its table,
-- this same check upgrade and this same ts_edit_submit, word for word), so re-running it afterwards keeps notes.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, and only once the edit worker on his Mac
-- (~/gusto-sync/ts-edit-worker.mjs) knows the note kind: an older worker would read a note as a change of the shift.
-- Then run supabase/ts-edits-verify.sql, supabase/ts-edits-clear-verify.sql and supabase/ts-pay-periods-verify.sql
-- (each rolls back) and check every row says pass. Then reload every Manager Timesheets tab that was open before: a page
-- from before notes takes a note for the latest change of its shift, so it would hide a change waiting on that shift
-- until it is reloaded (it shows nothing wrong in Gusto and breaks nothing).
--
-- What it adds
--   ts_edits.action 'note'   a note for Gusto on one shift that changes nothing else:
--                              shift_id       the Gusto shift id
--                              before         the shift as Gusto has it now (the same snapshot a delete stores)
--                              after          null
--                              note           the note: one line with its whitespace evened out, 1 to 400
--                                             characters (as the page counts them), required
--                              times_status   'none'
--                              breaks_status  'pending': it rides the breaks part, so the scheduled browser task writes
--                                             it (with the shift's own times) at 5 AM, noon and 7 PM Pacific
--                            ts_edits_action_check and ts_edits_shape take it; both only get wider, so every row already
--                            stored still passes.
--   ts_edit_submit(p_day_id, p_shift_id, 'note', p_after (ignored), p_note = the note, p_expect (not checked))
--     The same who, window and shift rules as an update: an active Google sign-in who can see the day, the day in the
--     current or previous pay period and not in the future, the shift on the day row now, not just deleted in Gusto,
--     and not being sent to Gusto right now; ts-pay-periods.sql's guard refuses a day whose pay period Gusto has
--     closed. Also refused: hours entered in Gusto without clock times, a shift still clocked in (the note goes to
--     Gusto with the shift's own start and end), a shift waiting to be deleted (the delete is older, so the browser
--     task sends it first and the note would have nowhere to go: the page offers no note there, and a page opened
--     before the delete gets "That shift is waiting to be deleted"), and a blank note or one over 400 characters.
--     The note is stored as one line with its whitespace evened out, as the page sends it (cleanNoteText), and its
--     400 are counted as the page and Gusto count them: a character past U+FFFF, such as most emoji, counts two, so
--     "Note from <email>: " plus the note always fits Gusto's 560. A delete made after a note leaves the note waiting.
--     A note never supersedes and is never superseded: several notes on one shift all wait, and a time or break change
--     never cancels a waiting note. A waiting or cancelled note never counts as "Someone changed this shift since you
--     opened it" for a change's p_expect, nor as a waiting change for "Nothing changed". A note's own p_expect is not
--     checked: a change made since the page opened is no reason to refuse a note.
--   ts_edit_submit, every action: a note or a reason that holds the start of a line this app writes in Gusto's note
--     ("Note from <email>:", "Changed through Wizard Trees Manager Timesheets for <email>", where parseAppNote in
--     ts-edit-plan.mjs, ca-ts-core.mjs and the page finds one) is refused: the board would show what was typed as a
--     line someone else wrote through this app.
--   Nothing else changes: ts_edit_cancel (a manager cancels or clears a note like any edit), ts_edits_pending (a note
--   is in the breaks list, never the times list), ts_edit_mark, ts_edits_to_recheck, ts_edit_clear, the payroll guard
--   trigger and the SELECT policy never look at the action, so a note follows their rules as it is, and whoever sees a
--   day sees its notes. No new column, function or grant.
--
-- Until this file is applied, ts_edit_submit refuses p_action 'note' with "The action must be update, add or delete";
-- the page reads that as "Adding notes is not switched on yet".

begin;

do $$ begin
  if to_regclass('public.ts_edits') is null or to_regprocedure('public.ts_edit_shape(jsonb,text)') is null
     or to_regprocedure('public.ts_edit_key(jsonb,text)') is null or to_regprocedure('public.ts_edit_window(text,date)') is null
     or to_regprocedure('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)') is null then
    raise exception 'Apply supabase/ts-edits.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The table's checks take 'note' (the same block as in supabase/ts-edits.sql)
-- ---------------------------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_edits'::regclass
                and c.conname = 'ts_edits_action_check' and pg_get_constraintdef(c.oid) not like '%''note''%') then
    alter table public.ts_edits drop constraint ts_edits_action_check;
    alter table public.ts_edits add constraint ts_edits_action_check check (action in ('update', 'add', 'delete', 'note'));
  end if;
  if exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_edits'::regclass
                and c.conname = 'ts_edits_shape' and pg_get_constraintdef(c.oid) not like '%''note''%') then
    alter table public.ts_edits drop constraint ts_edits_shape;
    alter table public.ts_edits add constraint ts_edits_shape check (coalesce(
         (action = 'add'    and shift_id is null     and before is null
                            and jsonb_typeof(after) = 'object')
      or (action = 'update' and shift_id is not null and jsonb_typeof(before) = 'object'
                            and jsonb_typeof(after) = 'object')
      or (action = 'delete' and shift_id is not null and jsonb_typeof(before) = 'object'
                            and after is null and times_status = 'none')
      or (action = 'note'   and shift_id is not null and jsonb_typeof(before) = 'object'
                            and after is null and note is not null and length(note) <= 400
                            and times_status = 'none'), false));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- ts_edit_submit with notes (the same function as in supabase/ts-edits.sql, word for word)
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
    -- before = what Gusto has now: a part applied after the row's last sync is that edit's after
    select e.after into v_sent from public.ts_edits e
     where e.day_id = d.id and e.shift_id = v_shift_id and e.action = 'update'
       and e.times_status = 'applied' and e.times_applied_at > d.synced_at
     order by e.times_applied_at desc, e.created_at desc limit 1;
    if v_sent is not null then
      v_before := v_before || jsonb_build_object('in', v_sent->'in', 'out', v_sent->'out');
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
    v_after := jsonb_build_object('in', public.ts_edit_iso(v_in, v_tz), 'out', public.ts_edit_iso(v_out, v_tz),
                                  'breaks', v_breaks);
  end if;

  -- which parts change (against what Gusto has now); a delete and a note ride the breaks part
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
--   select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.ts_edits'::regclass
--      and conname in ('ts_edits_action_check', 'ts_edits_shape');   -- both name 'note'
--   then run supabase/ts-edits-verify.sql, ts-edits-clear-verify.sql and ts-pay-periods-verify.sql: every row
--   pass = true, and each rolls back.
