-- ── Schedule tasks: backup, restore, and undelete ───────────────────────────
-- The calendar's VISITS are a mirror of the Google workbook, so the sheet is their
-- backup. Tasks are different: they exist only here, so a bad delete or a buggy
-- write is unrecoverable. (This project has already lost live rows to exactly that
-- once.) Three layers, cheapest first:
--
--   1. NOTHING IS EVER HARD-DELETED. "Delete" sets deleted_at; the DELETE privilege
--      is revoked from app users entirely, so no code path — and no future bug —
--      can destroy a row. Undo = clear deleted_at.
--   2. NIGHTLY SNAPSHOTS (pg_cron) of every board into schedule_backups, plus a
--      snapshot taken automatically before any restore, so a restore is itself
--      undoable. Retained 90 days; manual/pre-restore snapshots are kept forever.
--   3. RESTORE to any snapshot, and export/import JSON from the app for an
--      off-site copy.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

-- ── 1. soft delete ──────────────────────────────────────────────────────────
alter table public.schedule_tasks add column if not exists deleted_at timestamptz;
alter table public.schedule_tasks add column if not exists deleted_by uuid;
create index if not exists schedule_tasks_live_idx
  on public.schedule_tasks(state, task_date) where deleted_at is null;

-- Reads/writes stay board-scoped, but DELETE is no longer granted to anyone:
-- the blanket "for all" policy is replaced by explicit per-command policies.
drop policy if exists schedule_tasks_write   on public.schedule_tasks;
drop policy if exists schedule_tasks_select  on public.schedule_tasks;
drop policy if exists schedule_tasks_insert  on public.schedule_tasks;
drop policy if exists schedule_tasks_update  on public.schedule_tasks;
create policy schedule_tasks_select on public.schedule_tasks for select to authenticated
  using ( state = any(public.schedule_states()) );
create policy schedule_tasks_insert on public.schedule_tasks for insert to authenticated
  with check ( state = any(public.schedule_states()) );
create policy schedule_tasks_update on public.schedule_tasks for update to authenticated
  using ( state = any(public.schedule_states()) )
  with check ( state = any(public.schedule_states()) );
-- no DELETE policy on purpose; belt and braces:
revoke delete on public.schedule_tasks from authenticated, anon;

-- ── 2. snapshots ────────────────────────────────────────────────────────────
create table if not exists public.schedule_backups (
  id         bigserial primary key,
  taken_at   timestamptz not null default now(),
  state      text not null,
  kind       text not null default 'auto',      -- auto | manual | pre-restore
  note       text,
  taken_by   uuid,
  row_count  int  not null,
  rows       jsonb not null                     -- full task rows, including soft-deleted
);
create index if not exists schedule_backups_state_idx on public.schedule_backups(state, taken_at desc);
alter table public.schedule_backups enable row level security;

-- visible to anyone who can see that board; only admins may create/restore
drop policy if exists schedule_backups_select on public.schedule_backups;
create policy schedule_backups_select on public.schedule_backups for select to authenticated
  using ( state = any(public.schedule_states()) );

-- Snapshot one board. Skips when nothing changed since the last snapshot, so the
-- nightly job doesn't pile up identical copies of a quiet month.
create or replace function public.schedule_snapshot(p_state text, p_kind text default 'manual', p_note text default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_rows jsonb; v_n int; v_prev jsonb; v_id bigint;
begin
  -- auth.uid() is null in the SQL editor / service contexts: that is the break-glass
  -- path (used when the app itself is the thing that's broken) and stays open. A
  -- signed-in non-admin is refused.
  if p_kind <> 'auto' and auth.uid() is not null and not public.is_admin() then
    raise exception 'only an admin can take a named snapshot';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb), count(*)
    into v_rows, v_n
    from public.schedule_tasks t where t.state = p_state;
  select b.rows into v_prev from public.schedule_backups b
   where b.state = p_state order by b.taken_at desc limit 1;
  if v_prev is not null and v_prev = v_rows and p_kind = 'auto' then
    return null;                                  -- unchanged; nothing to record
  end if;
  insert into public.schedule_backups (state, kind, note, taken_by, row_count, rows)
  values (p_state, p_kind, p_note, auth.uid(), v_n, v_rows)
  returning id into v_id;
  return v_id;
end $$;

-- ── 3. restore ──────────────────────────────────────────────────────────────
-- Restores a board to exactly the snapshot's contents: rows in the snapshot are
-- re-inserted or updated in place (by id, so a row edited since then goes back to
-- its snapshot values), and rows created since are soft-deleted. A pre-restore
-- snapshot is taken FIRST, so the restore itself can be undone.
-- the shared worker: restore one board to exactly the rows given
create or replace function public.schedule_restore_rows(p_state text, p_rows jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_added int; v_removed int; v_pre bigint;
begin
  -- break-glass rule: open from SQL (auth.uid() null), admin-only in the app
  if auth.uid() is not null
     and (not public.is_admin() or not (p_state = any(public.schedule_states()))) then
    raise exception 'you cannot restore the % board', p_state;
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'backup rows must be a JSON array'; end if;
  -- a row belonging to another board would silently jump states — refuse the whole restore
  if exists(select 1 from jsonb_array_elements(p_rows) r
             where coalesce(r->>'state', p_state) <> p_state) then
    raise exception 'this backup contains rows from another board';
  end if;

  v_pre := public.schedule_snapshot(p_state, 'pre-restore', p_note);

  -- rows created after the snapshot: soft-delete (recoverable, never destroyed)
  with keep as (select (r->>'id')::uuid as id from jsonb_array_elements(p_rows) r)
  update public.schedule_tasks t set deleted_at = now(), deleted_by = auth.uid()
   where t.state = p_state and t.deleted_at is null
     and t.id not in (select id from keep);
  get diagnostics v_removed = row_count;

  insert into public.schedule_tasks
    (id, task_date, account, inv_total, region, driver, so_num, notes,
     created_by, created_at, updated_at, state, deleted_at, deleted_by)
  select (r->>'id')::uuid, (r->>'task_date')::date, r->>'account',
         nullif(r->>'inv_total','')::numeric, r->>'region', r->>'driver', r->>'so_num', r->>'notes',
         nullif(r->>'created_by','')::uuid,
         coalesce(nullif(r->>'created_at','')::timestamptz, now()), now(), p_state,
         nullif(r->>'deleted_at','')::timestamptz, nullif(r->>'deleted_by','')::uuid
    from jsonb_array_elements(p_rows) r
  on conflict (id) do update set
     task_date=excluded.task_date, account=excluded.account, inv_total=excluded.inv_total,
     region=excluded.region, driver=excluded.driver, so_num=excluded.so_num, notes=excluded.notes,
     updated_at=now(), deleted_at=excluded.deleted_at, deleted_by=excluded.deleted_by;
  get diagnostics v_added = row_count;

  return jsonb_build_object('restored', v_added, 'removed', v_removed,
                            'state', p_state, 'undo_backup_id', v_pre);
end $$;

create or replace function public.schedule_restore(p_backup_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_b public.schedule_backups;
begin
  select * into v_b from public.schedule_backups where id = p_backup_id;
  if v_b.id is null then raise exception 'no such backup: %', p_backup_id; end if;
  return public.schedule_restore_rows(v_b.state, v_b.rows,
           format('taken automatically before restoring backup #%s (%s)', p_backup_id, v_b.taken_at))
         || jsonb_build_object('from', v_b.taken_at);
end $$;

-- restore from a JSON file the user downloaded earlier (the off-site copy)
create or replace function public.schedule_restore_json(p_state text, p_rows jsonb)
returns jsonb language sql security definer set search_path=public as $$
  select public.schedule_restore_rows(p_state, p_rows, 'taken automatically before restoring an uploaded file');
$$;

-- Undo a single deletion (or every deletion in the last N minutes) — the fast path
-- for "I just deleted the wrong thing", without a full restore.
create or replace function public.schedule_undelete(p_id uuid default null, p_minutes int default null)
returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  update public.schedule_tasks t set deleted_at = null, deleted_by = null, updated_at = now()
   where t.deleted_at is not null
     and (auth.uid() is null or t.state = any(public.schedule_states()))
     and (p_id is null or t.id = p_id)
     and (p_minutes is null or t.deleted_at > now() - make_interval(mins => p_minutes));
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function public.schedule_snapshot(text, text, text)      to authenticated;
grant execute on function public.schedule_restore(bigint)                to authenticated;
grant execute on function public.schedule_restore_json(text, jsonb)      to authenticated;
grant execute on function public.schedule_undelete(uuid, int)            to authenticated;
-- the worker is reachable only through the two wrappers above
revoke execute on function public.schedule_restore_rows(text, jsonb, text) from authenticated, anon;

-- ── 4. nightly automatic snapshots + retention ──────────────────────────────
create or replace function public.schedule_backup_nightly() returns void
 language plpgsql security definer set search_path=public as $$
declare s text;
begin
  for s in select state from public.schedule_board loop
    perform public.schedule_snapshot(s, 'auto', null);
  end loop;
  -- keep automatic snapshots 90 days; manual and pre-restore ones are kept for good
  delete from public.schedule_backups
   where kind = 'auto' and taken_at < now() - interval '90 days';
end $$;

do $$ begin
  perform cron.unschedule('schedule-backup-nightly');
exception when others then null; end $$;
select cron.schedule('schedule-backup-nightly', '17 9 * * *',
                     $$select public.schedule_backup_nightly()$$);

-- seed one snapshot per board so a restore point exists immediately (idempotent:
-- only for boards that have none, so re-running this file adds nothing)
select public.schedule_snapshot(b.state, 'manual', 'initial snapshot')
  from public.schedule_board b
 where not exists (select 1 from public.schedule_backups k where k.state = b.state);

-- Verify:
--   select id,taken_at,state,kind,row_count,note from public.schedule_backups order by id desc limit 10;
--   select jobname,schedule,active from cron.job where jobname='schedule-backup-nightly';
-- Undo everything:
--   select cron.unschedule('schedule-backup-nightly');
--   drop function public.schedule_restore(bigint), public.schedule_snapshot(text,text,text),
--                 public.schedule_undelete(uuid,int), public.schedule_backup_nightly();
--   drop table public.schedule_backups;
