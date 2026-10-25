-- Manager Timesheets (timesheets.html): a "Needs a look" that Gusto has since settled clears itself.
-- Gianni 2026-10-25, on a daily list of 12 "needs a look": "are you able to fix these? I feel like we shouldn't
-- have this many 'needs a look' notices". Most of them had already been fixed by hand in Gusto, and the notice
-- stayed until someone pressed Clear.
--
-- Needs supabase/ts-edits.sql (apply that first, then this). Safe to re-run: add column if not exists, create or
-- replace. Re-running ts-edits.sql afterwards leaves everything here in place (it replaces none of it).
-- Apply on the CA project (dhiqhgtmelxwelyoowle), then run supabase/ts-edits-clear-verify.sql and
-- supabase/ts-edits-verify.sql (both roll back) and check every row says pass.
--
-- What it adds
--   ts_edits.cancel_reason   why the timesheet sync cleared an edit by itself (null for every other edit), at most
--                            300 characters, e.g. 'Gusto now matches' or 'Fixed in Gusto by hand: ...'
--   The workers' RPCs below, signed in as automation@wizardtrees.com AND sending the sync key as the x-ts-sync-key
--   header (ts_edit_worker_gate, exactly like ts_edits_pending and ts_edit_mark):
--   ts_edits_to_recheck()    every edit that needs a look and nothing else: a part in 'conflict' or 'failed', no part
--                            'pending' or 'applying', not cancelled, its day inside the editable window of its own
--                            region (ts_edit_window: the current and previous pay periods), oldest first (jsonb
--                            array of edit rows). The worker (ts-edit-worker.mjs) reads Gusto again for each one.
--   ts_edit_clear(p_id, p_reason)
--                            clears such an edit: every part in 'conflict' or 'failed' becomes 'cancelled',
--                            cancelled_by = 'gusto-sync', cancelled_at = now(), cancel_reason = the reason (trimmed,
--                            required, cut to 300 characters). The parts' error texts stay, so the history still
--                            says what went wrong; a part already 'applied' stays applied. It is the same change a
--                            manager's Clear makes (ts_edit_cancel), with the reason instead of a person.
--                            Refused with errcode 55000 (and nothing changes) when the edit is already cancelled or
--                            replaced, has a part 'pending' or 'applying' (it is still going to Gusto), or has no
--                            part in 'conflict' or 'failed'. The worker clears an edit only when Gusto, read again,
--                            shows the shift it was about is gone, reads as the edit asked, or has changed since the
--                            edit was marked (someone fixed it by hand).
--   Both take the same per-day lock as ts_edit_submit, ts_edit_cancel and ts_edit_mark.
--
-- Grants: as in ts-edits.sql, each function starts with an explicit revoke from public, anon and authenticated
-- (Supabase's default privileges grant EXECUTE on every new function), then EXECUTE to authenticated only (the
-- bodies check who is calling). security definer, search_path = public.

do $$ begin
  if to_regclass('public.ts_edits') is null or to_regprocedure('public.ts_edit_worker_gate(text)') is null
     or to_regprocedure('public.ts_edit_window(text,date)') is null or to_regprocedure('public.ts_edit_tz(text)') is null then
    raise exception 'Apply supabase/ts-edits.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The reason column
-- ---------------------------------------------------------------------------------------------

alter table public.ts_edits add column if not exists cancel_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_edits'::regclass and c.conname = 'ts_edits_cancel_reason_check') then
    alter table public.ts_edits add constraint ts_edits_cancel_reason_check
      check (cancel_reason is null or length(cancel_reason) between 1 and 300);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- ts_edits_to_recheck: the edits that need a look, inside the editable window
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_edits_to_recheck()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.ts_edit_worker_gate('ts_edits_to_recheck');
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
                     from public.ts_edits e
                     cross join lateral public.ts_edit_window(public.ts_edit_tz(e.region)) w
                    where e.cancelled_at is null
                      and (e.times_status in ('conflict', 'failed') or e.breaks_status in ('conflict', 'failed'))
                      and e.times_status not in ('pending', 'applying')
                      and e.breaks_status not in ('pending', 'applying')
                      and e.work_date between w.win_from and w.win_to), '[]'::jsonb);
end $$;
revoke all on function public.ts_edits_to_recheck() from public, anon, authenticated;
grant execute on function public.ts_edits_to_recheck() to authenticated;   -- body checks the email + key

-- ---------------------------------------------------------------------------------------------
-- ts_edit_clear: the timesheet sync clears a "Needs a look" that Gusto has settled
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_edit_clear(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_day    text;
  v_row    public.ts_edits%rowtype;
begin
  perform public.ts_edit_worker_gate('ts_edit_clear');
  if v_reason is null then
    raise exception 'Say why the edit is cleared';
  end if;
  select e.day_id into v_day from public.ts_edits e where e.id = p_id;
  if not found then
    raise exception 'No such edit: %', p_id;
  end if;
  perform pg_advisory_xact_lock(hashtext('ts_edit:' || v_day));   -- the same lock as ts_edit_submit, _cancel and _mark
  select * into v_row from public.ts_edits e where e.id = p_id for update;
  if v_row.cancelled_at is not null then
    raise exception 'Edit % is already cancelled or replaced', p_id using errcode = '55000';
  end if;
  if v_row.times_status in ('pending', 'applying') or v_row.breaks_status in ('pending', 'applying') then
    raise exception 'Edit % is still going to Gusto (times %, breaks %), so it is not cleared', p_id, v_row.times_status, v_row.breaks_status
      using errcode = '55000';
  end if;
  if not (v_row.times_status in ('conflict', 'failed') or v_row.breaks_status in ('conflict', 'failed')) then
    raise exception 'Edit % does not need a look (times %, breaks %)', p_id, v_row.times_status, v_row.breaks_status using errcode = '55000';
  end if;
  update public.ts_edits e
     set times_status  = case when e.times_status  in ('conflict', 'failed') then 'cancelled' else e.times_status end,
         breaks_status = case when e.breaks_status in ('conflict', 'failed') then 'cancelled' else e.breaks_status end,
         cancelled_by = 'gusto-sync', cancelled_at = now(), cancel_reason = v_reason
   where e.id = p_id
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.ts_edit_clear(uuid, text) from public, anon, authenticated;
grant execute on function public.ts_edit_clear(uuid, text) to authenticated;   -- body checks the email + key

notify pgrst, 'reload schema';

-- Post-apply checks: run supabase/ts-edits-clear-verify.sql and supabase/ts-edits-verify.sql (each rolls back):
-- every row pass = true. ts-edits-verify.sql's list of the ts_ functions authenticated may execute takes these two
-- when this file is applied.
