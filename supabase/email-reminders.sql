-- Automated Emails: per-account reminder settings + send history.
--
-- One row per sales account, keyed by the app's own tierNorm'd account key (the same key the
-- Automated Emails page joins everything else on) so a customer renamed in Distru/Nabis keeps
-- its settings. The three booleans are the reminder cadence Gianni asked for; last_sent is
-- written by whatever ends up doing the sending, and is NULL until then — the page shows "—"
-- rather than inventing a date.
--
-- Access: any signed-in @wizardtrees.com user may read and write. Reminder cadence is a shared
-- team setting, not per-person, and the page is CA-side sales tooling — same posture as
-- app_access reads. anon gets nothing (the published payload never carries this).
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create table if not exists public.email_reminders (
  acct_key    text primary key,
  acct_name   text not null default '',
  d1_before   boolean not null default false,
  d1_after    boolean not null default false,
  d7_after    boolean not null default false,
  rep         text,          -- designated rep OVERRIDE (Jesse / Joanna / Amanda); null = use the sheet
  email       text,          -- contact email OVERRIDE; null = use whatever the sheet/Catalyst doc gives
  cc          text,          -- CC list OVERRIDE (semicolon-separated); null = use the sheet
  last_sent   timestamptz,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.email_reminders enable row level security;

drop policy if exists email_reminders_read on public.email_reminders;
create policy email_reminders_read on public.email_reminders
  for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@wizardtrees.com');

drop policy if exists email_reminders_write on public.email_reminders;
create policy email_reminders_write on public.email_reminders
  for all to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@wizardtrees.com')
  with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@wizardtrees.com');

grant select, insert, update, delete on public.email_reminders to authenticated;

-- Verify: select count(*) from public.email_reminders;
-- Undo:   drop table public.email_reminders;
