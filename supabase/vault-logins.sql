-- Logins & Contacts (vault.html), 10/27: logins without the team passphrase, plus Olympic.
--
-- Gianni chose to drop the team passphrase. Usernames, passwords and secure notes now live in
-- vault_logins, readable only by people on vault_members (Google sign-in, confirmed
-- @wizardtrees.com account). They are no longer encrypted in the browser, so anyone with full
-- database access (the service key, the SQL editor) can read them.
-- vault_meta and the secret_iv / secret_ct columns on vault_entries stay, empty, in case the
-- passphrase comes back; nothing was ever saved in them.
--
-- Every change or delete of a login is copied to vault_entries_history (admins only), so a
-- password overwritten by mistake can be recovered.

create table if not exists public.vault_logins (
  entry_id uuid primary key references public.vault_entries(id) on delete cascade,
  username text check (length(username) <= 300),
  password text check (length(password) <= 500),
  secure_notes text check (length(secure_notes) <= 4000),
  updated_at timestamptz not null default now(),
  updated_by text
);

create or replace function public.vault_logins_stamp()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare who text := public.vault_my_email();
begin
  if tg_op <> 'INSERT' then
    insert into public.vault_entries_history(entry_id, op, old_row, changed_by)
      values (old.entry_id, 'LOGIN ' || tg_op, to_jsonb(old), who);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' then new.entry_id := old.entry_id; end if;
  new.updated_at := now(); new.updated_by := who;
  return new;
end;
$$;
revoke all on function public.vault_logins_stamp() from public, anon, authenticated;
drop trigger if exists vault_logins_stamp on public.vault_logins;
create trigger vault_logins_stamp before insert or update or delete on public.vault_logins
  for each row execute function public.vault_logins_stamp();

alter table public.vault_logins enable row level security;
revoke all on public.vault_logins from anon;
revoke all on public.vault_logins from authenticated;
grant select, insert, update, delete on public.vault_logins to authenticated;

-- members read; editors and admins write (same as entries)
drop policy if exists vault_logins_read on public.vault_logins;
create policy vault_logins_read on public.vault_logins
  for select to authenticated using (public.vault_role() is not null);
drop policy if exists vault_logins_ins on public.vault_logins;
create policy vault_logins_ins on public.vault_logins
  for insert to authenticated with check (public.vault_role() in ('admin', 'editor'));
drop policy if exists vault_logins_upd on public.vault_logins;
create policy vault_logins_upd on public.vault_logins
  for update to authenticated
  using (public.vault_role() in ('admin', 'editor')) with check (public.vault_role() in ('admin', 'editor'));
drop policy if exists vault_logins_del on public.vault_logins;
create policy vault_logins_del on public.vault_logins
  for delete to authenticated using (public.vault_role() in ('admin', 'editor'));

-- eighth company: Olympic
alter table public.vault_entries drop constraint if exists vault_entries_companies_known;
alter table public.vault_entries add constraint vault_entries_companies_known
  check (companies <@ array['waf', 'filifera', 'slane', 'imperial', 'wtmerch', 'wizardt', 'wtny', 'olympic']::text[]);
