-- NY Credits Track — accepted dispensary credits for the Sales Web App (ar-reports.html, NY side).
-- Open access model (anyone with the app link): anon role gets full CRUD via RLS-permissive policy.
-- Attachments (pics/PDFs) live in the public storage bucket 'ny-credit-files', metadata in `attachments` jsonb.
create extension if not exists pgcrypto;

create table if not exists public.ny_credits (
  id            uuid primary key default gen_random_uuid(),
  dispensary    text not null,
  amount        numeric(12,2) not null default 0,
  note          text not null default '',
  status        text not null default 'active' check (status in ('active','used')),
  used_date     date,                       -- set when moved active → used
  used_invoice  text,                       -- invoice # the credit was applied to
  attachments   jsonb not null default '[]'::jsonb,   -- [{name,path,type,size}]
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ny_credits_status_idx on public.ny_credits(status);

alter table public.ny_credits enable row level security;
drop policy if exists ny_credits_anon_all on public.ny_credits;
create policy ny_credits_anon_all on public.ny_credits for all to anon, authenticated using (true) with check (true);
grant all on public.ny_credits to anon, authenticated;

-- keep updated_at fresh
create or replace function public.ny_credits_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists ny_credits_touch on public.ny_credits;
create trigger ny_credits_touch before update on public.ny_credits for each row execute function public.ny_credits_touch();

-- Public storage bucket for attachments
insert into storage.buckets (id, name, public)
  values ('ny-credit-files','ny-credit-files', true)
  on conflict (id) do update set public = true;
drop policy if exists ny_credit_files_anon_all on storage.objects;
create policy ny_credit_files_anon_all on storage.objects for all to anon, authenticated
  using (bucket_id = 'ny-credit-files') with check (bucket_id = 'ny-credit-files');
