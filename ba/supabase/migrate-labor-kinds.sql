-- ── Labor kinds (admin-editable list) + hours.kind + Gusto pull queue ──

-- the selectable list; admins manage it in Settings
create table if not exists public.labor_kinds (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  active     boolean not null default true,
  sort       int not null default 100,
  created_at timestamptz not null default now()
);
insert into public.labor_kinds (name, sort) values
  ('Store visit', 10),
  ('Education talk', 20),
  ('Demo / PAD', 30),
  ('Brand event', 40),
  ('Travel', 50),
  ('Admin', 60)
on conflict (name) do nothing;

alter table public.labor_kinds enable row level security;
drop policy if exists labor_kinds_select on public.labor_kinds;
create policy labor_kinds_select on public.labor_kinds for select to authenticated using (true);
drop policy if exists labor_kinds_write on public.labor_kinds;
create policy labor_kinds_write on public.labor_kinds for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- what kind of labor each hours entry is (denormalized name; the table feeds the dropdown)
alter table public.hours add column if not exists kind text not null default 'General BA Activity/Admin';
-- default changed 2026-07-18 (was 'Store visit'): rows created without an explicit kind
-- (the salary split, any future path) are admin/general time — a day WITH trips shows its
-- real per-leg category mix from hours.alloc regardless, so the default is only the
-- no-miles fallback and 'Store visit' falsely claimed store activity on no-trip days.
alter table public.hours alter column kind set default 'General BA Activity/Admin';

-- how this BA's name appears in Gusto exports (fallback: full_name match)
alter table public.profiles add column if not exists gusto_name text;

-- ── on-demand Gusto pulls: the app inserts a request; the local ~/gusto-sync daemon
--    polls this queue, downloads the CSV from Gusto, imports, and marks it done ──
create table if not exists public.gusto_pull_requests (
  id           uuid primary key default gen_random_uuid(),
  requested_by uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending','running','done','error')),
  detail       text,
  completed_at timestamptz
);
alter table public.gusto_pull_requests enable row level security;
drop policy if exists gusto_pull_all on public.gusto_pull_requests;
create policy gusto_pull_all on public.gusto_pull_requests for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

select 'labor kinds + hours.kind + gusto_name + pull queue created' as result;
