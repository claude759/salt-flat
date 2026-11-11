-- Production Pipeline page (pipeline.html): who may open it.
-- The page reads the DISTRO PIPELINE tab of the Wizard Trees workbook straight from Google Sheets.
-- The workbook is shared by link, so its id is the secret: it lives only in schedule_board (CA row)
-- and pipeline_source() hands it to signed-in accounts on the pipeline list.
--   * universal admins always
--   * anyone added to pipeline_viewers, e.g.
--       insert into public.pipeline_viewers(email) values ('<name>@wizardtrees.com');
-- Applied by the Pipeline deploy workflow as pipeline_owner, first in supabase/pipeline-order.txt because
-- pipeline_jwt_email() is defined here. pipeline_owner cannot read schedule_board or schema auth: the workbook id comes
-- through schedule_board_ca_workbook(), a postgres-owned bridge only pipeline_owner may run, and the caller's email
-- through pipeline_jwt_email() (both set up by supabase/postgres/pipeline-owner-bootstrap.sql). Safe to re-run.
set role pipeline_owner;

-- The signed-in caller's email in lower case, or '' when there is none: the same answer as
-- lower(coalesce(auth.jwt()->>'email', '')), read straight from the request's claims. Every pipeline function uses
-- this instead of auth.jwt().
create or replace function public.pipeline_jwt_email()
returns text
language sql stable
set search_path = ''
as $$
  select lower(coalesce(coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                                 nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'email', ''));
$$;
revoke all on function public.pipeline_jwt_email() from public, anon;
grant execute on function public.pipeline_jwt_email() to authenticated, service_role;

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
  select public.schedule_board_ca_workbook()
   where public.is_universal_admin()
      or exists (select 1 from public.pipeline_viewers v
                 where v.email = public.pipeline_jwt_email());
$$;
revoke all on function public.pipeline_source() from public, anon;
grant execute on function public.pipeline_source() to authenticated;

reset role;
