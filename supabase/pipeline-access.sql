-- Production Pipeline page (pipeline.html): who may open it.
-- The page reads the DISTRO PIPELINE tab of the Wizard Trees workbook straight from Google Sheets.
-- The workbook is shared by link, so its id is the secret: it lives only in schedule_board (CA row)
-- and pipeline_source() hands it to signed-in accounts on the pipeline list.
--   * universal admins (Gianni, Victoria) always
--   * anyone added to pipeline_viewers, e.g.
--       insert into public.pipeline_viewers(email) values ('name@wizardtrees.com');

create table if not exists public.pipeline_viewers (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
alter table public.pipeline_viewers enable row level security;
drop policy if exists pipeline_viewers_admin on public.pipeline_viewers;
create policy pipeline_viewers_admin on public.pipeline_viewers
  for all to authenticated
  using (public.is_universal_admin()) with check (public.is_universal_admin());

create or replace function public.pipeline_source()
returns text
language sql stable security definer
set search_path = public
as $$
  select b.workbook_id
  from public.schedule_board b
  where b.state = 'CA'
    and (public.is_universal_admin()
         or exists (select 1 from public.pipeline_viewers v
                    where v.email = lower(coalesce(auth.jwt()->>'email', ''))));
$$;
revoke all on function public.pipeline_source() from public, anon;
grant execute on function public.pipeline_source() to authenticated;
