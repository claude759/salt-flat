-- One-off "don't send this one" blocks, set from the Reminders page. A block is per
-- account+tier+invoice — exactly the key the sender's idempotency gate uses — so blocking
-- tomorrow's reminder never silences a future invoice or a different tier.
create table if not exists public.email_blocks (
  acct_key text not null,
  kind text not null,
  invoice_no text not null,
  blocked_at timestamptz not null default now(),
  blocked_by text,
  primary key (acct_key, kind, invoice_no)
);
alter table public.email_blocks enable row level security;
drop policy if exists email_blocks_rw on public.email_blocks;
create policy email_blocks_rw on public.email_blocks for all to authenticated
  using ((auth.jwt() ->> 'email') ilike '%@wizardtrees.com')
  with check ((auth.jwt() ->> 'email') ilike '%@wizardtrees.com');
