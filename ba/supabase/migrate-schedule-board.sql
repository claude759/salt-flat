-- ── Schedule board (workbook viewer) ────────────────────────────────────────
-- In-app read-only board of the WIZARD TREES WORKBOOK weekly schedule.
-- The workbook is an anyone-with-link Google Sheet, so its document id is the
-- de-facto secret. It therefore lives HERE, behind RLS — never hardcoded in the
-- client — and the same row doubles as the feature's allowlist: users whose
-- email isn't in allowed_emails read zero rows and never see the Schedule tab.
create table if not exists public.schedule_board (
  id             int primary key default 1 check (id = 1),
  workbook_id    text not null,
  allowed_emails text[] not null default '{}',   -- store lowercase
  updated_at     timestamptz not null default now()
);
alter table public.schedule_board enable row level security;

drop policy if exists schedule_board_select on public.schedule_board;
create policy schedule_board_select on public.schedule_board for select to authenticated
  using ( lower(coalesce(auth.jwt()->>'email','')) = any(allowed_emails) );

-- writes: universal admins only (and the trusted service/SQL contexts that bypass RLS)
drop policy if exists schedule_board_write on public.schedule_board;
create policy schedule_board_write on public.schedule_board for all to authenticated
  using ( public.is_universal_admin() ) with check ( public.is_universal_admin() );

insert into public.schedule_board (id, workbook_id, allowed_emails) values
  (1, '1jJN6slCjxGhctALfcNTrnrNeCNPKE_ldBY0s6EECvtM',
   array['gianni@wizardtrees.com','joanna@wizardtrees.com','victoria@wizardtrees.com','amanda@wizardtrees.com'])
on conflict (id) do update
  set workbook_id = excluded.workbook_id,
      allowed_emails = excluded.allowed_emails,
      updated_at = now();
