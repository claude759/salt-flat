-- ── Schedule board: per-state boards (CA + NY) ─────────────────────────────
-- The board was a singleton pointing at the California workbook. New York has
-- its own scheduling workbook with a different grid layout, so the table becomes
-- ONE ROW PER STATE and every row carries the layout its parser needs.
--
-- Who sees which board:
--   • allowed_emails      — the per-board allowlist (unchanged mechanism)
--   • Universal Admins    — role='admin' AND region is null (Gianni, Victoria):
--                           see EVERY board, which is what makes the CA/NY
--                           switcher appear for them and nobody else.
--   • Regional users      — a BA/regional admin sees the board for their own
--                           profiles.region, so NY staff get NY and CA staff get
--                           CA without anyone maintaining a second list.
-- The switcher is therefore DERIVED (you get it iff you can see >1 board), not a
-- hardcoded pair of names: granting someone both boards is the only way to get it.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

-- ── 1. schedule_board gains state + layout, and stops being a singleton ─────
alter table public.schedule_board add column if not exists state  text;
alter table public.schedule_board add column if not exists layout text not null default 'ca';
alter table public.schedule_board add column if not exists label  text;

-- the id=1 check constraint has to go before a second board can exist
do $$ declare c text;
begin
  select conname into c from pg_constraint
   where conrelid='public.schedule_board'::regclass and contype='c' and pg_get_constraintdef(oid) like '%id%=%1%';
  if c is not null then execute format('alter table public.schedule_board drop constraint %I', c); end if;
end $$;
-- the existing row is California
update public.schedule_board set state='CA', layout='ca', label='California' where id=1;
alter table public.schedule_board alter column state set not null;
create unique index if not exists schedule_board_state_idx on public.schedule_board(state);

-- ── 2. the New York board ──────────────────────────────────────────────────
-- NY staff = the region's BAs + its regional admin; the two universal admins are
-- listed too so the board is reachable even if the is_universal_admin() path is
-- ever narrowed.
insert into public.schedule_board (id, state, layout, label, workbook_id, allowed_emails) values
  (2, 'NY', 'ny', 'New York', '1ydmn66agfAysDNZpJnxdC_49wzwyBPIap3Cz4pTTKlo',
   array['gianni@wizardtrees.com','victoria@wizardtrees.com','maddy@wizardtrees.com',
         'rachel@wizardtrees.com','terrance@wizardtrees.com','jackie@wizardtrees.com',
         'chandler@wizardtrees.com'])
on conflict (id) do update
  set state=excluded.state, layout=excluded.layout, label=excluded.label,
      workbook_id=excluded.workbook_id, allowed_emails=excluded.allowed_emails, updated_at=now();

-- ── 3. visibility: allowlist OR universal admin OR your own region ──────────
-- Every branch is gated on the caller still being ACTIVE. Deactivating someone in
-- Admin → Users is the only offboarding step the app offers, and it must actually
-- revoke this board: the workbook id is the de-facto secret for an
-- anyone-with-the-link Google Sheet, and board access also carries task write/delete.
-- One helper, used by both the policy and schedule_states(), so the two predicates
-- can never drift apart.
create or replace function public.schedule_can_see(p_state text, p_emails text[])
 returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.active)
     and (
       lower(coalesce(auth.jwt()->>'email','')) = any(p_emails)
       or public.is_universal_admin()
       or p_state = (select region from public.profiles where id = auth.uid() and active)
     );
$$;
grant execute on function public.schedule_can_see(text, text[]) to authenticated;

drop policy if exists schedule_board_select on public.schedule_board;
create policy schedule_board_select on public.schedule_board for select to authenticated
  using ( public.schedule_can_see(state, allowed_emails) );

-- ── 4. tasks belong to a board ─────────────────────────────────────────────
-- NOTE: schedule_tasks.region is the CA workbook's DELIVERY ZONE column, not a
-- state — hence a separate `state` column here rather than reusing it.
alter table public.schedule_tasks add column if not exists state text not null default 'CA';
create index if not exists schedule_tasks_state_date_idx on public.schedule_tasks(state, task_date);

-- the set of board states this user may see — same predicate as the policy above,
-- via the same helper, so an inactive user loses tasks exactly when they lose boards
create or replace function public.schedule_states() returns text[]
 language sql stable security definer set search_path=public as $$
  select coalesce(array_agg(state), '{}') from public.schedule_board
   where public.schedule_can_see(state, allowed_emails);
$$;
grant execute on function public.schedule_states() to authenticated;

-- a task is readable/writable only on a board you can see: a NY BA can never
-- read or create a California task, and vice versa.
drop policy if exists schedule_tasks_select on public.schedule_tasks;
create policy schedule_tasks_select on public.schedule_tasks for select to authenticated
  using ( state = any(public.schedule_states()) );
drop policy if exists schedule_tasks_write on public.schedule_tasks;
create policy schedule_tasks_write on public.schedule_tasks for all to authenticated
  using ( state = any(public.schedule_states()) )
  with check ( state = any(public.schedule_states()) );

-- Verify:
--   select id,state,layout,label,workbook_id from public.schedule_board order by id;
--   select public.schedule_states();
-- Undo:
--   delete from public.schedule_board where id=2;
--   alter table public.schedule_tasks drop column state;
