-- Manager Gusto Timesheets (timesheets.html), round 5: managers edit timesheets in the app (phase 1).
-- Needs supabase/ts-ca-timesheets.sql, ts-views.sql, ts-view-grants.sql (and ts-ny-company.sql for
-- New York); apply those first, then this.
--
-- What an edit is
--   One row of ts_edits = the manager's DESIRED FINAL STATE of one shift on one employee-day, plus a
--   snapshot of that shift as it stood when the edit was made:
--     before  the shift as Gusto has it right now: the ts_days row's shift, except that a part a worker
--             applied to Gusto after the row's last sync (applied_at later than ts_days.synced_at)
--             counts as that edit's after (null for a new shift)
--     after   what it should become (null for a delete)
--   both shaped {in, out, breaks: [{start, end, kind}]}, kind 'rest' (paid) or 'meal' (unpaid), every
--   time an ISO 8601 string with seconds and the offset of the row's time zone (Pacific for CA, Eastern
--   for NY), breaks in time order.
--   action 'update' (shift_id = the Gusto shift id), 'add' (shift_id null: a forgotten clock-in),
--   'delete' (shift_id = the shift to remove) or 'note' (shift_id = the shift a manager writes a note
--   on for Gusto: before as for a delete, after null, note = the note itself; see Notes below).
--   Each edit has two parts that reach Gusto separately:
--     times   start and end, applied through the Gusto API by a worker on Gianni's Mac (phase 2)
--     breaks  breaks (and deleting a shift, and notes), applied by a scheduled browser task at 5 AM, noon and 7 PM PT
--             (phase 2), because the API cannot add, remove or relabel breaks
--   times_status / breaks_status: 'none' (that part does not change), 'pending', 'applying' (a worker
--   claimed it and is writing it to Gusto now), 'applied', 'conflict', 'failed' or 'cancelled'.
--     update  times pending when start or end differ from before, breaks pending when the breaks do
--             (compared to the minute: seconds never count)
--     add     times pending; breaks pending when it has breaks, else none
--     delete  times none; breaks pending (the browser task deletes the shift)
--     note    times none; breaks pending (the browser task writes the note, with the shift's own times)
--   Edits go straight through (no approver) and every one is kept: nothing deletes ts_edits rows.
--
-- Who can edit
--   ts_edit_submit(p_day_id, p_shift_id, p_action, p_after, p_note, p_expect default null) -> the saved
--   edit row (jsonb)
--     The caller must be an ACTIVE allowlisted Google sign-in (ts_access + ts_my_email: a password,
--     magic-link or OTP session never counts, and automation@ has no ts_access row) who can SEE that
--     ts_days row under the same rule as its RLS policy (ts_can_view(company, department,
--     employee_uuid): admins, ts_grants, view members). A day that does not exist and a day the
--     caller cannot see get the same refusal.
--     Window: the row's work_date must be in the CURRENT or PREVIOUS pay period and not after today,
--     both in the row's time zone. Pay periods are 14 days ending on Fridays, anchored on Friday
--     2026-10-09 (so 2026-09-26 to 10-09, 10-10 to 10-23, ...). One schedule for every company.
--     after (update and add) must be:
--       in and out: ISO times with an explicit offset ('Z' or +hh:mm), in < out, out at most 5 minutes
--         after now (no hours that have not been worked yet)
--       in on the row's work_date in the row's time zone (an update may also keep the date its start
--         already has), and out on the same date, or on the next date with the whole shift at most
--         16 hours
--       not overlapping any other shift of the day as it will be once the waiting edits land (the
--         row's shifts without those waiting to be deleted, with the new times of those waiting to
--         change, plus the shifts waiting to be added; one may start the minute another ends;
--         hours-only entries and shifts still clocked in are left out, as on the page)
--       breaks: a list (empty for none) of at most 6 objects {start, end, kind}; each 1 to 240
--         minutes, kind 'rest' or 'meal', inside the shift and none overlapping, both to the minute
--         (Gusto's own minute arithmetic: a break Gusto put a few seconds before the clock-in, in the
--         same minute, is inside; one may start the minute another ends)
--     update and delete need the shift id to be on the row now, and refuse an hours-only entry (hours
--     entered in Gusto without clock times: they are changed in Gusto); add must not carry one. A
--     delete ignores p_after (its after is always null).
--     note (the optional reason) is trimmed, blank = none, at most 500 characters. For a note edit it
--     is the note: one line with its whitespace evened out (as the page's cleanNoteText sends it),
--     required, at most 400 characters counted as the page counts them (a character past U+FFFF, such
--     as most emoji, counts two). Neither may hold the start of a line this app writes in Gusto's note
--     ("Note from <email>:", "Changed through Wizard Trees Manager Timesheets for <email>"): the board
--     would show what was typed as a line someone else wrote through this app.
--     Refused: an update that changes nothing and replaces no pending edit, and an add identical (to
--     the minute) to an add of the same day that is still waiting.
--     A shift with a part being written to Gusto right now ('applying'), and a shift whose delete
--     reached Gusto after the last sync, cannot be edited until that settles.
--     p_expect (optional, update and delete): the ids of the edits of that shift that were waiting
--     ('pending') when the caller opened it, as a JSON list. When another edit of the shift is
--     waiting now, or one of those was cancelled or replaced since, the submit is refused ("Someone
--     changed this shift since you opened it"), so a page loaded earlier never silently replaces a
--     change it did not show. Edits a worker finished since (applied, conflict, failed) are fine. Null
--     skips the check.
--   Supersede: a new edit of the SAME shift (same day_id + shift_id) replaces every older edit of it
--     that still has a pending part: those parts become 'cancelled' with cancelled_by 'superseded'
--     (parts already applied, in conflict or failed keep their status). The new edit carries the whole
--     desired state, so nothing is lost. Adds (no shift id yet) never supersede each other.
--   Notes (action 'note', added by supabase/ts-edit-notes.sql): a note for Gusto on one shift that
--     changes nothing else. The same who, window and shift rules as an update (and the closed pay
--     periods of ts-pay-periods.sql), and also refused for a shift still clocked in (the note goes to
--     Gusto with the shift's own start and end) and for a shift waiting to be deleted (the delete is
--     older, so the browser task sends it first and the note would have nowhere to go; the page
--     offers no note there, a page opened before the delete gets the refusal). A delete made after a
--     note leaves the note waiting. A note never supersedes and is never superseded:
--     several notes on one shift all wait. A note never counts as a waiting change of its shift for
--     p_expect or "Nothing changed", and its own p_expect is not checked: a time or break change made
--     since the page opened is no reason to refuse a note.
--   ts_edit_cancel(p_id) -> the edit row: the edit's creator or a ts_access admin (active Google
--     sign-in); a creator who is not an admin must still be able to see the day (its current ts_days
--     row, or the edit's own company / department / person once the row is gone). Pending parts are
--     cancelled; so are parts in 'conflict' or 'failed' (the manager checked Gusto and Gusto is
--     right: "Needs a look" is cleared, the error text is kept). The parts become 'cancelled' and
--     cancelled_by = the caller. Applied parts stay applied. Refused while a part is 'applying', and
--     for an edit already cancelled or replaced.
--
-- Who sees edits
--   ts_edits has RLS with one SELECT policy: the ts_days policy word for word on the edit's own
--   company, department and employee_uuid (copied from the day row when the edit is made), OR the
--   edit's day row (ts_days.id = day_id) is one the caller can see under the ts_days policy. So
--   whoever sees a day sees all of its edits, also after a sync moved the person to another
--   department, and the edits of a day row that is gone stay visible by their own keys. Admins see
--   every edit; inactive users, non-Google sessions and anon see nothing.
--   Nobody writes the table directly: authenticated has SELECT only, anon nothing, no write policies.
--
-- The workers (phase 2): signed in as automation@wizardtrees.com AND sending the sync key as the
-- x-ts-sync-key header, exactly like ts_sync (see ts-ca-timesheets.sql):
--   ts_edits_pending(p_part)  'times' or 'breaks': the edits with that part pending, plus those whose
--                             claim is older than 15 minutes (a worker that stopped half way), oldest
--                             first (jsonb array of edit rows)
--   ts_edit_mark(p_id, p_part, p_status, p_error)
--     'applying'  claims the part BEFORE writing it to Gusto: pending -> applying (stamps
--                 *_claimed_at); a claim older than 15 minutes may be taken again. While a part is
--                 applying nobody can cancel or replace it, so what the worker writes is what the log
--                 says.
--     'applied' (stamps *_applied_at), 'conflict' or 'failed' (p_error kept, at most 1000
--                 characters; a blank one is stored as 'No details given'): only a part that is
--                 'applying', i.e. claimed first.
--     Anything else is refused with errcode 55000 (a cancelled or replaced part, an unclaimed one, a
--     finished one), so a worker that gets 55000 on its claim writes nothing to Gusto.
--   An added shift's Gusto id is not recorded here (no column for it yet): phase 2 decides how the
--   breaks task finds the new shift.
--
-- Grants: Supabase's default privileges hand anon/authenticated ALL on every new public table and
-- EXECUTE on every new public function, so every grant below starts with an explicit revoke naming
-- them. The four RPCs above are granted to authenticated (their bodies check who is calling); the
-- helpers are internal and granted to nobody. Every function is security definer with
-- search_path = public.
--
-- This file replaces nothing the earlier ts files define, so re-running any of them leaves edits
-- alone. (After re-running ts-ca-timesheets.sql, re-run ts-view-grants.sql as its header says: the
-- ts_edits policy uses whichever ts_my_grant_keys() and ts_days policy are in place, exactly like
-- ts_days.)
-- No rows are seeded. Safe to re-run: create ... if not exists, create or replace, drop policy if exists.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, then run
-- supabase/ts-edits-verify.sql (it rolls itself back) and check every row says pass.

do $$ begin
  if to_regclass('public.ts_days') is null or to_regclass('public.ts_companies') is null
     or to_regclass('public.ts_access') is null or to_regclass('public.ts_sync_keys') is null
     or to_regprocedure('public.ts_my_email()') is null or to_regprocedure('public.ts_is_admin()') is null
     or to_regprocedure('public.ts_my_grant_keys()') is null then
    raise exception 'Apply supabase/ts-ca-timesheets.sql first';
  end if;
  if to_regclass('public.ts_views') is null then
    raise exception 'Apply supabase/ts-views.sql first';
  end if;
  if to_regclass('public.ts_view_grants') is null or to_regprocedure('public.ts_can_view(text,text,text)') is null then
    raise exception 'Apply supabase/ts-view-grants.sql first (edits use its person-aware ts_can_view)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ts_edits (
  id uuid primary key default gen_random_uuid(),
  day_id text not null,                 -- ts_days.id when submitted ('<company>:<employee_uuid>:<date>'); no foreign key: the log outlives the day row
  company text not null references public.ts_companies(key),
  region text not null,
  employee_uuid text not null,
  department text not null,             -- copied from the day row (for RLS on the edit itself)
  work_date date not null,
  shift_id text,                        -- Gusto shift id; null = a NEW shift to add
  action text not null check (action in ('update', 'add', 'delete', 'note')),
  before jsonb,                         -- the shift as Gusto had it (null for add): {in, out, breaks: [{start, end, kind}]}
  after jsonb,                          -- desired state (null for delete and note): {in, out, breaks: [{start, end, kind}]}, kind rest|meal
  note text check (note is null or length(note) between 1 and 500),   -- optional reason (the note itself for a note, at most 400)
  times_status text not null default 'pending'
    check (times_status in ('none', 'pending', 'applying', 'applied', 'conflict', 'failed', 'cancelled')),
  breaks_status text not null default 'pending'
    check (breaks_status in ('none', 'pending', 'applying', 'applied', 'conflict', 'failed', 'cancelled')),
  times_error text,
  breaks_error text,
  times_claimed_at timestamptz,         -- when a worker claimed the part (status applying)
  breaks_claimed_at timestamptz,
  times_applied_at timestamptz,
  breaks_applied_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  cancelled_by text,                    -- who cancelled, or 'superseded'
  cancelled_at timestamptz,
  -- (coalesce: a CHECK that comes out null passes, and jsonb_typeof(null) is null)
  constraint ts_edits_shape check (coalesce(
       (action = 'add'    and shift_id is null     and before is null
                          and jsonb_typeof(after) = 'object')
    or (action = 'update' and shift_id is not null and jsonb_typeof(before) = 'object'
                          and jsonb_typeof(after) = 'object')
    or (action = 'delete' and shift_id is not null and jsonb_typeof(before) = 'object'
                          and after is null and times_status = 'none')
    or (action = 'note'   and shift_id is not null and jsonb_typeof(before) = 'object'
                          and after is null and note is not null and length(note) <= 400
                          and times_status = 'none'), false))
);
-- a table made by the first draft of this file (never applied live) gets the claim columns and the
-- 'applying' status
alter table public.ts_edits add column if not exists times_claimed_at timestamptz;
alter table public.ts_edits add column if not exists breaks_claimed_at timestamptz;
do $$
declare p text;
begin
  foreach p in array array['times', 'breaks'] loop
    if exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_edits'::regclass
                  and c.conname = 'ts_edits_' || p || '_status_check' and pg_get_constraintdef(c.oid) not like '%applying%') then
      execute format('alter table public.ts_edits drop constraint %I', 'ts_edits_' || p || '_status_check');
      execute format('alter table public.ts_edits add constraint %I check (%I in (''none'', ''pending'', ''applying'', ''applied'', ''conflict'', ''failed'', ''cancelled''))',
                     'ts_edits_' || p || '_status_check', p || '_status');
    end if;
  end loop;
end $$;
-- a table made before notes (the live one until supabase/ts-edit-notes.sql, which runs this same block)
-- takes the 'note' action and its shape. Both checks only get wider, so every stored row still passes.
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
create index if not exists ts_edits_day_shift_idx on public.ts_edits (day_id, shift_id);
create index if not exists ts_edits_work_date_idx on public.ts_edits (work_date);
create index if not exists ts_edits_times_pending_idx on public.ts_edits (created_at) where times_status = 'pending';
create index if not exists ts_edits_breaks_pending_idx on public.ts_edits (created_at) where breaks_status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Helpers (internal, granted to nobody)
-- ---------------------------------------------------------------------------------------------

-- A row's time zone from its region (the producer's per-company tz): NY Eastern, everything else Pacific.
create or replace function public.ts_edit_tz(p_region text)
returns text language sql immutable security definer set search_path = public as $$
  select case when p_region = 'NY' then 'America/New_York' else 'America/Los_Angeles' end
$$;
revoke all on function public.ts_edit_tz(text) from public, anon, authenticated;

-- The editable window in a time zone: the first day of the previous pay period through today.
-- Pay periods: 14 days ending on Fridays, anchored on Friday 2026-10-09. The current period is the
-- one whose end is the first anchor + 14k on or after today. p_today (for the verify script) stands
-- in for today; null = today in p_tz.
create or replace function public.ts_edit_window(p_tz text, p_today date default null,
                                                 out win_from date, out win_to date)
returns record language sql stable security definer set search_path = public as $$
  select e.period_end - 27, e.today
    from (select t.today, date '2026-10-09' + 14 * ceil((t.today - date '2026-10-09') / 14.0)::int as period_end
            from (select coalesce(p_today, (now() at time zone p_tz)::date) as today) t) e
$$;
revoke all on function public.ts_edit_window(text, date) from public, anon, authenticated;

-- One time of an edit: a JSON string in ISO 8601 (date, hours, minutes, optional seconds) WITH an
-- explicit offset ('Z' or +hh:mm), never a bare local time (the server would read it in its own
-- zone). JSON null or a missing key gives null. Fractions of a second are dropped.
create or replace function public.ts_edit_ts(p_val jsonb, p_what text)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if p_val is null or jsonb_typeof(p_val) = 'null' then return null; end if;
  if jsonb_typeof(p_val) <> 'string' then
    raise exception '% must be a time', p_what;
  end if;
  v := p_val #>> '{}';
  if v !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}(:?\d{2})?)$' then
    raise exception '% must be a full time with its zone offset, for example 2026-10-20T08:00:00-07:00', p_what;
  end if;
  begin
    return date_trunc('second', v::timestamptz);
  exception when others then
    raise exception '% is not a real time: %', p_what, left(v, 40);
  end;
end $$;
revoke all on function public.ts_edit_ts(jsonb, text) from public, anon, authenticated;

-- A time as stored in before/after: 'YYYY-MM-DDTHH:MI:SS+hh:mm' in the row's zone (null stays null).
create or replace function public.ts_edit_iso(p_ts timestamptz, p_tz text)
returns text language sql stable security definer set search_path = public as $$
  select case when p_ts is null then null else
           to_char(p_ts at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS')
           || case when o.off < 0 then '-' else '+' end
           || lpad((abs(o.off) / 60)::text, 2, '0') || ':' || lpad((abs(o.off) % 60)::text, 2, '0') end
    from (select (extract(epoch from (p_ts at time zone p_tz) - (p_ts at time zone 'UTC')) / 60)::int as off) o
$$;
revoke all on function public.ts_edit_iso(timestamptz, text) from public, anon, authenticated;

-- A clock time for messages, e.g. '8:05 AM', in the row's zone.
create or replace function public.ts_edit_hm(p_ts timestamptz, p_tz text)
returns text language sql stable security definer set search_path = public as $$
  select to_char(p_ts at time zone p_tz, 'FMHH12:MI AM')
$$;
revoke all on function public.ts_edit_hm(timestamptz, text) from public, anon, authenticated;

-- A time's minute: minutes since the epoch, seconds dropped (the board's Gusto minute arithmetic), so
-- two times compare to the minute in every zone, also across a daylight-saving change.
create or replace function public.ts_edit_min(p_ts timestamptz)
returns bigint language sql stable security definer set search_path = public as $$
  select floor(extract(epoch from p_ts) / 60)::bigint
$$;
revoke all on function public.ts_edit_min(timestamptz) from public, anon, authenticated;

-- A ts_days shift in the stored shape {in, out, breaks: [{start, end, kind}]}, breaks in time order:
-- the before snapshot. An open shift or break keeps its null end; any other key is left out.
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
$$;
revoke all on function public.ts_edit_shape(jsonb, text) from public, anon, authenticated;

-- What one part of a stored shape is, to the minute (seconds never count; minutes since the epoch,
-- so a time is the same minute in every zone, also across a daylight-saving change):
--   'times'   [in, out]
--   'breaks'  [[start, end, kind], ...] in time order
create or replace function public.ts_edit_key(p_shape jsonb, p_part text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case p_part
    when 'times' then jsonb_build_array(
      floor(extract(epoch from (p_shape->>'in')::timestamptz) / 60),
      floor(extract(epoch from (p_shape->>'out')::timestamptz) / 60))
    else coalesce((
      select jsonb_agg(jsonb_build_array(floor(extract(epoch from (b->>'start')::timestamptz) / 60),
                                         floor(extract(epoch from (b->>'end')::timestamptz) / 60),
                                         b->'kind')
                       order by (b->>'start')::timestamptz, (b->>'end')::timestamptz, b->>'kind')
        from jsonb_array_elements(case jsonb_typeof(p_shape->'breaks') when 'array' then p_shape->'breaks' else '[]'::jsonb end) b),
      '[]'::jsonb) end
$$;
revoke all on function public.ts_edit_key(jsonb, text) from public, anon, authenticated;

-- The workers' gate, the same two checks as ts_sync: the sync account's email AND the sync key in
-- the x-ts-sync-key request header (its sha256 in ts_sync_keys, not revoked).
create or replace function public.ts_edit_worker_gate(p_fn text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.ts_my_email() is distinct from 'automation@wizardtrees.com' then
    raise exception '% is for the timesheet sync account only', p_fn using errcode = '42501';
  end if;
  if not exists (select 1 from public.ts_sync_keys k
                  where k.revoked_at is null
                    and k.key_hash = encode(sha256(convert_to(coalesce(
                          nullif(current_setting('request.headers', true), '')::jsonb->>'x-ts-sync-key', ''), 'utf8')), 'hex')) then
    raise exception '% needs the sync key', p_fn using errcode = '42501';
  end if;
end $$;
revoke all on function public.ts_edit_worker_gate(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- ts_edit_submit: a manager's edit of one shift (see the header for every rule)
-- ---------------------------------------------------------------------------------------------

-- The first draft was the five-argument function public.ts_edit_submit(p_day_id text, p_shift_id text, p_action text, p_after jsonb, p_note text).
-- It goes first: PostgREST would otherwise see two candidates for the page's five named arguments.
drop function if exists public.ts_edit_submit(text, text, text, jsonb, text);

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

-- ---------------------------------------------------------------------------------------------
-- ts_edit_cancel: the creator or an admin, while a part is still pending, in conflict or failed
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_edit_cancel(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me  text := public.ts_my_email();
  v_day text;
  v_row public.ts_edits%rowtype;
  dd    public.ts_days%rowtype;
begin
  if v_me is null or not exists (select 1 from public.ts_access a where a.email = v_me and a.active) then
    raise exception 'Only timesheet sign-ins can cancel edits' using errcode = '42501';
  end if;
  select e.day_id into v_day from public.ts_edits e where e.id = p_id;
  if not found then
    raise exception 'No such edit';
  end if;
  perform pg_advisory_xact_lock(hashtext('ts_edit:' || v_day));   -- the same lock as ts_edit_submit
  select * into v_row from public.ts_edits e where e.id = p_id for update;
  if v_row.created_by is distinct from v_me and not public.ts_is_admin() then
    raise exception 'Only the person who made this edit, or an admin, can cancel it' using errcode = '42501';
  end if;
  -- the creator must still see the day: its row as it is now, or the edit's own keys once it is gone
  if not public.ts_is_admin() then
    select * into dd from public.ts_days t where t.id = v_row.day_id;
    if not coalesce(case when found then public.ts_can_view(dd.company, dd.department, dd.employee_uuid)
                         else public.ts_can_view(v_row.company, v_row.department, v_row.employee_uuid) end, false) then
      raise exception 'You can no longer see this day, so you cannot cancel its edits' using errcode = '42501';
    end if;
  end if;
  if 'applying' in (v_row.times_status, v_row.breaks_status) then
    raise exception 'This change is being sent to Gusto right now, so it cannot be cancelled. Try again in a few minutes';
  end if;
  if v_row.cancelled_at is not null
     or not (v_row.times_status in ('pending', 'conflict', 'failed') or v_row.breaks_status in ('pending', 'conflict', 'failed')) then
    raise exception 'This edit is no longer waiting to go to Gusto, so it cannot be cancelled';
  end if;
  update public.ts_edits e
     set times_status  = case when e.times_status  in ('pending', 'conflict', 'failed') then 'cancelled' else e.times_status end,
         breaks_status = case when e.breaks_status in ('pending', 'conflict', 'failed') then 'cancelled' else e.breaks_status end,
         cancelled_by = v_me, cancelled_at = now()
   where e.id = p_id
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.ts_edit_cancel(uuid) from public, anon, authenticated;
grant execute on function public.ts_edit_cancel(uuid) to authenticated;   -- body checks the caller

-- ---------------------------------------------------------------------------------------------
-- Worker RPCs (automation@ + the sync key)
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_edits_pending(p_part text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_part text := lower(btrim(coalesce(p_part, '')));
begin
  perform public.ts_edit_worker_gate('ts_edits_pending');
  if v_part not in ('times', 'breaks') then
    raise exception 'The part must be times or breaks';
  end if;
  -- pending parts, and claims older than 15 minutes (a worker that stopped half way: take it again)
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
                     from public.ts_edits e
                    where (v_part = 'times' and (e.times_status = 'pending'
                             or (e.times_status = 'applying' and e.times_claimed_at < now() - interval '15 minutes')))
                       or (v_part = 'breaks' and (e.breaks_status = 'pending'
                             or (e.breaks_status = 'applying' and e.breaks_claimed_at < now() - interval '15 minutes')))), '[]'::jsonb);
end $$;
revoke all on function public.ts_edits_pending(text) from public, anon, authenticated;
grant execute on function public.ts_edits_pending(text) to authenticated;   -- body checks the email + key

create or replace function public.ts_edit_mark(p_id uuid, p_part text, p_status text, p_error text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_part    text := lower(btrim(coalesce(p_part, '')));
  v_status  text := lower(btrim(coalesce(p_status, '')));
  v_error   text := left(nullif(btrim(coalesce(p_error, '')), ''), 1000);
  v_day     text;
  v_row     public.ts_edits%rowtype;
  v_cur     text;
  v_claimed timestamptz;
begin
  perform public.ts_edit_worker_gate('ts_edit_mark');
  if v_part not in ('times', 'breaks') then
    raise exception 'The part must be times or breaks';
  end if;
  if v_status not in ('applying', 'applied', 'conflict', 'failed') then
    raise exception 'The status must be applying, applied, conflict or failed';
  end if;
  select e.day_id into v_day from public.ts_edits e where e.id = p_id;
  if not found then
    raise exception 'No such edit: %', p_id;
  end if;
  perform pg_advisory_xact_lock(hashtext('ts_edit:' || v_day));   -- the same lock as ts_edit_submit
  select * into v_row from public.ts_edits e where e.id = p_id for update;
  v_cur     := case v_part when 'times' then v_row.times_status else v_row.breaks_status end;
  v_claimed := case v_part when 'times' then v_row.times_claimed_at else v_row.breaks_claimed_at end;
  if v_status = 'applying' then
    -- the claim, before anything is written to Gusto
    if v_cur = 'applying' and v_claimed < now() - interval '15 minutes' then
      null;   -- a claim left behind by a worker that stopped: taken again
    elsif v_cur <> 'pending' then
      raise exception 'The % part of edit % is %, not pending', v_part, p_id, v_cur using errcode = '55000';
    end if;
    if v_part = 'times' then
      update public.ts_edits e set times_status = 'applying', times_claimed_at = now(), times_error = null
       where e.id = p_id returning * into v_row;
    else
      update public.ts_edits e set breaks_status = 'applying', breaks_claimed_at = now(), breaks_error = null
       where e.id = p_id returning * into v_row;
    end if;
    return to_jsonb(v_row);
  end if;
  if v_cur <> 'applying' then
    raise exception 'The % part of edit % is %, not applying (claim it with the status applying first)', v_part, p_id, v_cur
      using errcode = '55000';
  end if;
  if v_status <> 'applied' and v_error is null then
    v_error := 'No details given';
  end if;
  if v_part = 'times' then
    update public.ts_edits e
       set times_status = v_status, times_error = v_error,
           times_applied_at = case when v_status = 'applied' then now() end
     where e.id = p_id returning * into v_row;
  else
    update public.ts_edits e
       set breaks_status = v_status, breaks_error = v_error,
           breaks_applied_at = case when v_status = 'applied' then now() end
     where e.id = p_id returning * into v_row;
  end if;
  return to_jsonb(v_row);
end $$;
revoke all on function public.ts_edit_mark(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ts_edit_mark(uuid, text, text, text) to authenticated;   -- body checks the email + key

-- ---------------------------------------------------------------------------------------------
-- Row level security: SELECT only, to authenticated. No write policies (writes = RPCs above).
-- ---------------------------------------------------------------------------------------------

alter table public.ts_edits enable row level security;
revoke all on table public.ts_edits from public, anon, authenticated;
grant select on table public.ts_edits to authenticated;

-- the ts_days policy on the edit's own company / department / employee_uuid, or the edit's day row
-- is one the caller can see (that subquery runs under the ts_days policy)
drop policy if exists ts_edits_select on public.ts_edits;
create policy ts_edits_select on public.ts_edits for select to authenticated
  using ((select public.ts_is_admin())
         or (select public.ts_my_grant_keys())
            && array[case when left(department, 6) <> '@uuid:' then company || '|' || department end,
                     company || '|*',
                     company || '|@uuid:' || employee_uuid]
         or exists (select 1 from public.ts_days d where d.id = ts_edits.day_id));

notify pgrst, 'reload schema';

-- Post-apply checks (all read-only):
--   select relrowsecurity from pg_class where oid = 'public.ts_edits'::regclass;   -- true
--   anon GET /rest/v1/ts_edits?select=id -> 401/permission denied
--   then run supabase/ts-edits-verify.sql, and the three older verify scripts: every row pass = true,
--   and each rolls back. (Their lists of the ts_ functions authenticated may execute leave the four
--   edit RPCs out, so they hold with or without this file; ts-edits-verify.sql pins the full list.)
