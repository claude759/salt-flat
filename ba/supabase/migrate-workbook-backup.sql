-- ── Back up the CALENDAR, not just the tasks ───────────────────────────────
-- The first cut of this feature snapshotted schedule_tasks only, on the reasoning that
-- the calendar's visits mirror the Google workbook and the sheet is therefore its own
-- backup. Two problems with that:
--   1. schedule_tasks has never had a single row, so the panel truthfully reported
--      "0 tasks" and looked broken;
--   2. "the sheet is its own backup" only holds while the sheet is intact. A deleted
--      tab, a bad paste, or a lost workbook takes the whole schedule with it, and the
--      app keeps no copy of what it parsed.
--
-- This stores the RAW CSV of each workbook tab the app loads. Raw rather than parsed
-- on purpose: it survives parser changes, it is exactly what Google served, and it can
-- be pasted straight back into Sheets to rebuild a lost tab.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create table if not exists public.schedule_workbook_backups (
  id          bigserial primary key,
  taken_at    timestamptz not null default now(),
  state       text not null,
  workbook_id text,
  tab         text not null,
  csv         text not null,
  bytes       int  not null,
  taken_by    uuid
);
create index if not exists schedule_wb_backups_idx
  on public.schedule_workbook_backups(state, tab, taken_at desc);
alter table public.schedule_workbook_backups enable row level security;

drop policy if exists schedule_wb_backups_select on public.schedule_workbook_backups;
create policy schedule_wb_backups_select on public.schedule_workbook_backups
  for select to authenticated using ( state = any(public.schedule_states()) );

-- Store one day's tabs for a board. Skips a tab whose newest copy is byte-identical,
-- so a quiet week doesn't pile up duplicates of the same sheet.
create or replace function public.schedule_workbook_snapshot(p_state text, p_workbook text, p_tabs jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r jsonb; v_new int := 0; v_same int := 0; v_prev text;
begin
  if not (p_state = any(public.schedule_states())) then
    raise exception 'you cannot snapshot the % workbook', p_state;
  end if;
  if jsonb_typeof(p_tabs) <> 'array' then raise exception 'tabs must be a JSON array'; end if;
  for r in select * from jsonb_array_elements(p_tabs) loop
    if coalesce(r->>'csv','') = '' or coalesce(r->>'tab','') = '' then continue; end if;
    select b.csv into v_prev from public.schedule_workbook_backups b
     where b.state = p_state and b.tab = r->>'tab' order by b.taken_at desc limit 1;
    if v_prev is not null and v_prev = r->>'csv' then v_same := v_same + 1; continue; end if;
    insert into public.schedule_workbook_backups (state, workbook_id, tab, csv, bytes, taken_by)
    values (p_state, p_workbook, r->>'tab', r->>'csv', length(r->>'csv'), auth.uid());
    v_new := v_new + 1;
  end loop;
  -- keep 60 days, but never drop the newest copy of a tab (an untouched tab must
  -- stay recoverable however long ago it was last edited)
  delete from public.schedule_workbook_backups b
   where b.taken_at < now() - interval '60 days'
     and exists (select 1 from public.schedule_workbook_backups n
                  where n.state = b.state and n.tab = b.tab and n.taken_at > b.taken_at);
  return jsonb_build_object('saved', v_new, 'unchanged', v_same);
end $$;
grant execute on function public.schedule_workbook_snapshot(text, text, jsonb) to authenticated;

-- how stale is each board's copy? (drives the "last backed up" line in the panel)
create or replace function public.schedule_workbook_status()
returns table(state text, tabs bigint, newest timestamptz, bytes bigint)
language sql stable security definer set search_path=public as $$
  select b.state, count(distinct b.tab), max(b.taken_at), sum(b.bytes)
    from public.schedule_workbook_backups b
   where b.state = any(public.schedule_states())
   group by b.state;
$$;
grant execute on function public.schedule_workbook_status() to authenticated;

-- Verify:
--   select state, tab, taken_at, bytes from public.schedule_workbook_backups order by id desc limit 10;
--   select * from public.schedule_workbook_status();
