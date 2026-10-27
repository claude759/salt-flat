-- Logins & Contacts (vault.html): company website logins and vendor/facility contacts for the
-- seven companies.
--
-- Two locks:
--   1. Database: only people on vault_members can read anything (Google sign-in, confirmed
--      @wizardtrees.com account). Editors and admins can add and change entries; viewers only read.
--   2. Browser: usernames, passwords and secure notes are encrypted in the browser (AES-256-GCM)
--      with a vault key that is itself encrypted by the team passphrase (PBKDF2-SHA256). The
--      database only ever holds ciphertext for those fields; the passphrase is never sent anywhere.
--
-- Members are added on the page (admin gear) or with
--   insert into public.vault_members(email, role) values ('name@wizardtrees.com', 'editor');
-- Every change or delete of an entry is copied to vault_entries_history (admins can read it), so a
-- password overwritten by mistake can be recovered.

create table if not exists public.vault_members (
  email text primary key check (email = lower(email) and email like '%@wizardtrees.com'),
  role text not null check (role in ('admin', 'editor', 'viewer')),
  added_at timestamptz not null default now(),
  added_by text
);

-- Never leave the vault without an admin (removing or downgrading the last one is refused).
create or replace function public.vault_members_keep_admin()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (select 1 from public.vault_members m where m.role = 'admin' and m.email <> old.email) then
    raise exception 'The vault needs at least one admin.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.vault_members_keep_admin() from public, anon, authenticated;
drop trigger if exists vault_members_keep_admin on public.vault_members;
create trigger vault_members_keep_admin before update or delete on public.vault_members
  for each row execute function public.vault_members_keep_admin();

-- The caller's confirmed email and role (null if not on the list). Read from auth.users, not from
-- anything the browser sends.
create or replace function public.vault_my_email()
returns text
language sql stable security definer
set search_path = public
as $$
  select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;
revoke all on function public.vault_my_email() from public, anon;
grant execute on function public.vault_my_email() to authenticated;

create or replace function public.vault_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select m.role from public.vault_members m where m.email = public.vault_my_email();
$$;
revoke all on function public.vault_role() from public, anon;
grant execute on function public.vault_role() to authenticated;

-- One row: the vault key wrapped by the team passphrase.
create table if not exists public.vault_meta (
  id smallint primary key default 1 check (id = 1),
  kdf_salt text not null,
  kdf_iter integer not null check (kdf_iter >= 300000),
  wrap_iv text not null,
  wrapped_key text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.vault_entries (
  id uuid primary key default gen_random_uuid(),
  companies text[] not null default '{}',
  category text not null default 'Other' check (length(category) between 1 and 60),
  name text not null check (length(name) between 1 and 200),
  url text check (url is null or url ~* '^https?://'),
  account_no text,
  contacts jsonb not null default '[]'::jsonb check (jsonb_typeof(contacts) = 'array'),
  notes text,
  secret_iv text,                    -- encrypted { username, password, secure notes }
  secret_ct text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  check ((secret_iv is null) = (secret_ct is null))
);
create index if not exists vault_entries_companies on public.vault_entries using gin (companies);

create table if not exists public.vault_entries_history (
  hist_id bigserial primary key,
  entry_id uuid not null,
  op text not null,
  old_row jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by text
);

-- Stamp who/when on the server, and keep the old version of every changed or deleted entry.
create or replace function public.vault_entries_stamp()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare who text := public.vault_my_email();
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.created_by := who;
    new.updated_at := now(); new.updated_by := who;
    return new;
  end if;
  insert into public.vault_entries_history(entry_id, op, old_row, changed_by)
    values (old.id, tg_op, to_jsonb(old), who);
  if tg_op = 'UPDATE' then
    new.id := old.id; new.created_at := old.created_at; new.created_by := old.created_by;
    new.updated_at := now(); new.updated_by := who;
    return new;
  end if;
  return old;
end;
$$;
revoke all on function public.vault_entries_stamp() from public, anon, authenticated;
drop trigger if exists vault_entries_stamp on public.vault_entries;
create trigger vault_entries_stamp before insert or update or delete on public.vault_entries
  for each row execute function public.vault_entries_stamp();

create or replace function public.vault_meta_stamp()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := public.vault_my_email();
  return new;
end;
$$;
revoke all on function public.vault_meta_stamp() from public, anon, authenticated;
drop trigger if exists vault_meta_stamp on public.vault_meta;
create trigger vault_meta_stamp before insert or update on public.vault_meta
  for each row execute function public.vault_meta_stamp();

alter table public.vault_members enable row level security;
alter table public.vault_meta enable row level security;
alter table public.vault_entries enable row level security;
alter table public.vault_entries_history enable row level security;

revoke all on public.vault_members, public.vault_meta, public.vault_entries, public.vault_entries_history from anon;
revoke all on public.vault_members, public.vault_meta, public.vault_entries, public.vault_entries_history from authenticated;
grant select, insert, update, delete on public.vault_members to authenticated;
grant select, insert, update on public.vault_meta to authenticated;
grant select, insert, update, delete on public.vault_entries to authenticated;
grant select on public.vault_entries_history to authenticated;
revoke all on sequence public.vault_entries_history_hist_id_seq from anon, authenticated;

-- members: everyone sees their own row; admins see and change all of them
drop policy if exists vault_members_self on public.vault_members;
create policy vault_members_self on public.vault_members
  for select to authenticated
  using (email = public.vault_my_email() or public.vault_role() = 'admin');
drop policy if exists vault_members_admin on public.vault_members;
create policy vault_members_admin on public.vault_members
  for all to authenticated
  using (public.vault_role() = 'admin') with check (public.vault_role() = 'admin');

-- meta: members read it (needed to unlock); only admins set or change the passphrase
drop policy if exists vault_meta_read on public.vault_meta;
create policy vault_meta_read on public.vault_meta
  for select to authenticated using (public.vault_role() is not null);
drop policy if exists vault_meta_admin_ins on public.vault_meta;
create policy vault_meta_admin_ins on public.vault_meta
  for insert to authenticated with check (public.vault_role() = 'admin');
drop policy if exists vault_meta_admin_upd on public.vault_meta;
create policy vault_meta_admin_upd on public.vault_meta
  for update to authenticated
  using (public.vault_role() = 'admin') with check (public.vault_role() = 'admin');

-- entries: members read; editors and admins write
drop policy if exists vault_entries_read on public.vault_entries;
create policy vault_entries_read on public.vault_entries
  for select to authenticated using (public.vault_role() is not null);
drop policy if exists vault_entries_ins on public.vault_entries;
create policy vault_entries_ins on public.vault_entries
  for insert to authenticated with check (public.vault_role() in ('admin', 'editor'));
drop policy if exists vault_entries_upd on public.vault_entries;
create policy vault_entries_upd on public.vault_entries
  for update to authenticated
  using (public.vault_role() in ('admin', 'editor')) with check (public.vault_role() in ('admin', 'editor'));
drop policy if exists vault_entries_del on public.vault_entries;
create policy vault_entries_del on public.vault_entries
  for delete to authenticated using (public.vault_role() in ('admin', 'editor'));

-- history: admins only
drop policy if exists vault_history_admin on public.vault_entries_history;
create policy vault_history_admin on public.vault_entries_history
  for select to authenticated using (public.vault_role() = 'admin');

-- only the seven company codes the page knows
alter table public.vault_entries drop constraint if exists vault_entries_companies_known;
alter table public.vault_entries add constraint vault_entries_companies_known
  check (companies <@ array['waf', 'filifera', 'slane', 'imperial', 'wtmerch', 'wizardt', 'wtny']::text[]);
