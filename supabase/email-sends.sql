-- Send log for the automated AR reminder emails (ar-reminders.mjs writes it via the Management
-- API; the app reads it authenticated). One row per email actually handed to the mailer —
-- test-mode sends log with test=true so the dry-run history is auditable too.
create table if not exists public.email_sends (
  id bigint generated always as identity primary key,
  sent_at timestamptz not null default now(),
  acct_key text not null,
  acct_name text,
  kind text not null,              -- 'd1_before' | 'd1_after' | 'd7_after' | 'dry_run'
  to_addr text,
  cc text,
  subject text,
  invoices jsonb,                  -- [{no, source, due, days, outstanding}]
  total numeric,
  test boolean not null default true,
  status text
);
create index if not exists email_sends_acct_idx on public.email_sends (acct_key, sent_at desc);
alter table public.email_sends enable row level security;
drop policy if exists email_sends_read on public.email_sends;
create policy email_sends_read on public.email_sends for select to authenticated
  using ((auth.jwt() ->> 'email') ilike '%@wizardtrees.com');
-- no insert/update policies: writes come only from the local job (Management API, bypasses RLS)
