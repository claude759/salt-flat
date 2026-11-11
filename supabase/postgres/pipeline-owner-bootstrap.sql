-- Production Pipeline: the limited role pipeline_owner, which owns every Production Pipeline object so the deploy
-- workflow (.github/workflows/pipeline-deploy.yml) can apply supabase/pipeline-*.sql without anyone's help.
--
-- What it can reach, honestly. It owns the public.pipeline_* objects and nothing else, belongs to no role, and has no
-- rights on other apps' tables in public, schedule_board, schema auth, Vault or cron. Other apps' data is also open to
-- it through the postgres-owned security definer functions in public that PUBLIC may run (48 on 2026-11-11), until
-- lockdown-public-execute.sql (M1) takes that away. One thing it cannot be kept out of: pg_net. supabase_admin grants
-- PUBLIC (every role, this one included) USAGE on schema net, EXECUTE on all 12 of its functions (net.http_get,
-- net.http_post, net.http_delete, net.worker_restart and the rest) and every right, TRUNCATE and TRIGGER included, on
-- net.http_request_queue and net._http_response. postgres holds no grant option on any of them, so it cannot revoke
-- them, and Postgres has no way to deny one role what PUBLIC has. So whoever holds this role's login (the
-- PIPELINE_DB_URL secret, which anyone who can push to main can reach through the workflow) can:
--   * read the headers of other apps' queued web calls, which carry Vault secrets (the BA submission notice, the
--     ba-reminders cron job, and the pipeline sync cron jobs once they are on), while they wait in the queue;
--   * read the responses to them (pg_net keeps those for its ttl, 6 hours here);
--   * delete or empty other apps' queued calls and responses, add its own, or put a trigger on those two tables
--     (which then only supabase_admin can remove: postgres cannot drop it);
--   * send web requests from the database, and call pg_net's other functions (net.worker_restart() among them).
-- Every login role on the project can do the same today; this file adds the role, not the gap. Only Supabase
-- (supabase_admin) can close it, and the roles that use pg_net now would then need their own grants.
-- What this repo does about it: the workflow refuses any pipeline SQL file that names schema net, vault, cron or
-- supabase_functions or puts one on a search_path (scripts/pipeline-ci/lib.mjs), and its checks inside each file's
-- transaction roll back any pipeline function whose body or search_path names them and any pipeline view, trigger or
-- foreign key that reaches into them (scripts/pipeline-ci/apply-sql.mjs), so a pipeline object that would pass that
-- data to the page or get in other apps' way does not go live by mistake. Those checks stop mistakes and plain
-- attempts, not a determined pusher: SQL built up in pieces at run time gets past them, and whoever can push to main
-- can change them too.
-- scripts/pipeline-ci/verify-role.sql reports the gap in its own row, which stays false until Supabase closes it.
--
-- ONE-TIME, run as postgres from Gianni's Mac (this folder is never applied by the workflow):
--   node ~/claude-sql/run-sql-ca.mjs "/Users/giannilane/Documents/Claude/Projects/AR Automation/supabase/postgres/pipeline-owner-bootstrap.sql"
-- Run it outside crew hours: handing a table over takes a brief lock on it. lock_timeout makes it give up (changing
-- nothing) rather than queue behind the page; if that happens, run it again.
--
-- What it does, all in one transaction:
--  1. Creates pipeline_owner NOLOGIN and with no password: no superuser, no CREATEROLE, CREATEDB, REPLICATION or
--     BYPASSRLS, a member of no role, at most 3 connections. postgres becomes a member of it (INHERIT and SET), so
--     postgres keeps full access to everything handed over; never revoke that membership.
--     Logging in is switched on later by a separate step, from a file that never enters this repo:
--     scripts/pipeline-ci/owner-login.mjs writes ~/claude-sql/pending/pipeline-owner-login.sql holding a SCRAM
--     verifier made on the Mac, so no plain password ever reaches the Postgres log.
--  2. Gives it USAGE and CREATE on schema public and EXECUTE on is_universal_admin(). Nothing in schema auth, and no
--     access to schedule_board (it holds the other state's workbook and allowed emails): a new postgres-owned bridge,
--     schedule_board_ca_workbook(), returns only the CA workbook id, and only pipeline_owner may run it.
--  3. Hands over the 20 tables (the identity sequence pipeline_edits_id_seq, indexes and policies go with their
--     tables) and the 11 functions. Every existing grant carries over, with pipeline_owner as the grantor.
--  4. Sets default privileges for what pipeline_owner creates later, mirroring Supabase's for postgres in schema
--     public (tables, sequences and functions reach anon, authenticated and service_role; row level security still
--     decides rows), and never PUBLIC execute on functions.
--  5. Defines pipeline_jwt_email() and, while they still read auth.jwt() or schedule_board, swaps the bodies of
--     pipeline_source(), pipeline_can_view() and pipeline_can_edit() for the ones in supabase/pipeline-access.sql,
--     pipeline-batches.sql and pipeline-edits.sql (byte-identical), so the page keeps working the moment ownership
--     moves. A re-run leaves bodies the workflow has changed since alone.
--  6. Creates public.pipeline_sql_applied, the workflow's record of each file (and save-program folder) it applied.
--  7. Checks the hand-over and aborts, changing nothing, if anything is off.
-- Safe to re-run.
--
-- Then, in this order: lockdown-public-execute.sql (M1), the read-only checks in scripts/pipeline-ci/verify-role.sql,
-- the login step above, the two GitHub secrets, and a first workflow run.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local createrole_self_grant = 'set, inherit';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pipeline_owner') then
    create role pipeline_owner with nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      connection limit 3;
  end if;
  if not exists (select 1 from pg_auth_members m
                  where m.roleid = 'pipeline_owner'::regrole and m.member = 'postgres'::regrole
                    and m.set_option and m.inherit_option) then
    grant pipeline_owner to postgres with inherit true, set true;
  end if;
end $$;
comment on role pipeline_owner is
  'Owns every Production Pipeline object (public.pipeline_*). Used only by the Pipeline deploy workflow on GitHub. '
  'Set up by supabase/postgres/pipeline-owner-bootstrap.sql; checked by scripts/pipeline-ci/verify-role.sql.';
alter role pipeline_owner set statement_timeout = '120s';
alter role pipeline_owner set lock_timeout = '5s';
alter role pipeline_owner set idle_in_transaction_session_timeout = '60s';
alter role pipeline_owner set search_path = public;

grant usage, create on schema public to pipeline_owner;
grant execute on function public.is_universal_admin() to pipeline_owner;   -- PUBLIC loses it in lockdown-public-execute.sql

-- The bridge: the only BA fact the pipeline needs. Stays postgres-owned; only pipeline_owner may run it.
create or replace function public.schedule_board_ca_workbook()
returns text
language sql stable security definer
set search_path = ''
as $$
  select b.workbook_id from public.schedule_board b where b.state = 'CA';
$$;
revoke all on function public.schedule_board_ca_workbook() from public, anon, authenticated, service_role;
grant execute on function public.schedule_board_ca_workbook() to pipeline_owner;
comment on function public.schedule_board_ca_workbook() is
  'The CA workbook id from schedule_board, for pipeline_source() (owned by pipeline_owner, which cannot read '
  'schedule_board). Only pipeline_owner may run it.';

alter table public.pipeline_viewers owner to pipeline_owner;
alter table public.pipeline_batches owner to pipeline_owner;
alter table public.pipeline_batches_meta owner to pipeline_owner;
alter table public.pipeline_batches_secret owner to pipeline_owner;
alter table public.pipeline_marks owner to pipeline_owner;
alter table public.pipeline_marks_meta owner to pipeline_owner;
alter table public.pipeline_marks_secret owner to pipeline_owner;
alter table public.pipeline_batch_labs owner to pipeline_owner;
alter table public.pipeline_batch_labs_meta owner to pipeline_owner;
alter table public.pipeline_batch_labs_secret owner to pipeline_owner;
alter table public.pipeline_trims owner to pipeline_owner;
alter table public.pipeline_trims_meta owner to pipeline_owner;
alter table public.pipeline_trims_secret owner to pipeline_owner;
alter table public.pipeline_inventory owner to pipeline_owner;
alter table public.pipeline_inventory_meta owner to pipeline_owner;
alter table public.pipeline_inventory_secret owner to pipeline_owner;
alter table public.pipeline_editors owner to pipeline_owner;
alter table public.pipeline_write_settings owner to pipeline_owner;
alter table public.pipeline_edits owner to pipeline_owner;        -- takes pipeline_edits_id_seq with it
alter table public.pipeline_edit_locks owner to pipeline_owner;
alter function public.pipeline_source() owner to pipeline_owner;
alter function public.pipeline_can_view() owner to pipeline_owner;
alter function public.pipeline_can_edit(text) owner to pipeline_owner;
alter function public.pipeline_edit_status() owner to pipeline_owner;
alter function public.pipeline_marks_save(text, jsonb, jsonb) owner to pipeline_owner;
alter function public.pipeline_batches_save(text, jsonb, jsonb) owner to pipeline_owner;
alter function public.pipeline_batch_labs_save(text, jsonb) owner to pipeline_owner;
alter function public.pipeline_trims_save(text, jsonb, jsonb) owner to pipeline_owner;
alter function public.pipeline_inventory_save(text, text, jsonb, jsonb) owner to pipeline_owner;
alter function public.pipeline_lock_cells(text[], integer, text, text) owner to pipeline_owner;
alter function public.pipeline_unlock_cells(text[], text) owner to pipeline_owner;

-- From here on, as pipeline_owner: what follows is created and owned by it, and proves it can do so.
set local role pipeline_owner;

alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

do $do$
begin
  if to_regprocedure('public.pipeline_jwt_email()') is null then
    execute $fn$
create or replace function public.pipeline_jwt_email()
returns text
language sql stable
set search_path = ''
as $$
  select lower(coalesce(coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                                 nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'email', ''));
$$
    $fn$;
  end if;

  if (select p.prosrc from pg_proc p where p.oid = 'public.pipeline_source()'::regprocedure)
     ~ '\mauth\.jwt\M|\mschedule_board\M' then
    execute $fn$
create or replace function public.pipeline_source()
returns text
language sql stable security definer
set search_path = public
as $$
  select public.schedule_board_ca_workbook()
   where public.is_universal_admin()
      or exists (select 1 from public.pipeline_viewers v
                 where v.email = public.pipeline_jwt_email());
$$
    $fn$;
  end if;

  if (select p.prosrc from pg_proc p where p.oid = 'public.pipeline_can_view()'::regprocedure)
     ~ '\mauth\.jwt\M|\mschedule_board\M' then
    execute $fn$
create or replace function public.pipeline_can_view()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_universal_admin()
      or exists (select 1 from public.pipeline_viewers v
                 where v.email = public.pipeline_jwt_email());
$$
    $fn$;
  end if;

  if (select p.prosrc from pg_proc p where p.oid = 'public.pipeline_can_edit(text)'::regprocedure)
     ~ '\mauth\.jwt\M|\mschedule_board\M' then
    execute $fn$
create or replace function public.pipeline_can_edit(p_scope text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(p_scope in ('plan', 'supply'), false)
     and exists (select 1 from public.pipeline_editors e
                 where e.email = public.pipeline_jwt_email()
                   and e.email like '%@wizardtrees.com'
                   and e.scope in ('all', p_scope));
$$
    $fn$;
  end if;
end $do$;
revoke all on function public.pipeline_jwt_email() from public, anon;
grant execute on function public.pipeline_jwt_email() to authenticated, service_role;

-- The deploy workflow's record: one row per SQL file applied (kind 'sql', the file's sha256 exactly as run-sql-ca.mjs
-- computes it) and per save-program folder deployed (kind 'function', a sha256 over the folder's files). A file is
-- applied again whenever its sha256 differs from its latest row. Only the workflow (pipeline_owner) writes it.
create table if not exists public.pipeline_sql_applied (
  id         bigint generated always as identity primary key,
  kind       text not null default 'sql' check (kind in ('sql', 'function')),
  file       text not null check (file ~ '^supabase/(pipeline-[a-z0-9][a-z0-9-]*\.sql|functions/pipeline-[a-z0-9][a-z0-9-]*)$'),
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user,
  git_commit text check (git_commit ~ '^[0-9a-f]{40}$'),
  run_url    text
);
comment on table public.pipeline_sql_applied is
  'What the Pipeline deploy workflow (.github/workflows/pipeline-deploy.yml) applied: each supabase/pipeline-*.sql '
  'file by sha256, and each supabase/functions/pipeline-* folder it deployed. Written only by pipeline_owner.';
create index if not exists pipeline_sql_applied_file on public.pipeline_sql_applied (kind, file, id desc);
alter table public.pipeline_sql_applied enable row level security;   -- no policies: the page never reads it directly
revoke all on table public.pipeline_sql_applied from public, anon, authenticated, service_role;
grant select on table public.pipeline_sql_applied to service_role;
revoke all on sequence public.pipeline_sql_applied_id_seq from public, anon, authenticated, service_role;

reset role;

-- The checks. Any failure raises, which rolls back everything above.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname like 'pipeline\_%'
     and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f', 'i', 'I') and c.relowner <> 'pipeline_owner'::regrole;
  if bad is not null then raise exception 'pipeline_owner bootstrap: not handed over: %', bad; end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like 'pipeline\_%'
     and p.proowner <> 'pipeline_owner'::regrole;
  if bad is not null then raise exception 'pipeline_owner bootstrap: not handed over: %', bad; end if;

  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname like 'pipeline\_%' and c.relkind in ('r', 'p')
     and not c.relrowsecurity;
  if bad is not null then raise exception 'pipeline_owner bootstrap: row level security is off on: %', bad; end if;

  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname, c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relowner = 'pipeline_owner'::regrole and n.nspname not like 'pg\_%'
     and not (n.nspname = 'public' and c.relname like 'pipeline\_%');
  if bad is not null then raise exception 'pipeline_owner bootstrap: it owns other things: %', bad; end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into bad
    from pg_proc p
   where p.proowner = 'pipeline_owner'::regrole
     and not (p.pronamespace = 'public'::regnamespace and p.proname like 'pipeline\_%');
  if bad is not null then raise exception 'pipeline_owner bootstrap: it owns other functions: %', bad; end if;

  select string_agg(r.rolname, ', ') into bad
    from pg_auth_members m join pg_roles r on r.oid = m.roleid
   where m.member = 'pipeline_owner'::regrole;
  if bad is not null then raise exception 'pipeline_owner bootstrap: it must belong to no role, but belongs to: %', bad; end if;

  if exists (select 1 from pg_roles where rolname = 'pipeline_owner'
                and (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)) then
    raise exception 'pipeline_owner bootstrap: the role has more power than it should';
  end if;

  if not exists (select 1 from pg_auth_members m
                  where m.roleid = 'pipeline_owner'::regrole and m.member = 'postgres'::regrole
                    and m.set_option and m.inherit_option) then
    raise exception 'pipeline_owner bootstrap: postgres is not a member of pipeline_owner with INHERIT and SET';
  end if;

  if (select count(*) from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relname like 'pipeline\_%' and c.relkind = 'r') < 21 then
    raise exception 'pipeline_owner bootstrap: expected at least 21 pipeline tables (20 plus pipeline_sql_applied)';
  end if;
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname like 'pipeline\_%') < 12 then
    raise exception 'pipeline_owner bootstrap: expected at least 12 pipeline functions (11 plus pipeline_jwt_email)';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('pipeline_source', 'pipeline_can_view', 'pipeline_can_edit')
     and p.prosrc ~ '\mauth\.jwt\M|\mschedule_board\M';
  if bad is not null then raise exception 'pipeline_owner bootstrap: still reads auth.jwt() or schedule_board: %', bad; end if;

  if not has_function_privilege('pipeline_owner', 'public.schedule_board_ca_workbook()', 'execute')
     or not has_function_privilege('pipeline_owner', 'public.is_universal_admin()', 'execute')
     or has_function_privilege('anon', 'public.schedule_board_ca_workbook()', 'execute')
     or has_function_privilege('authenticated', 'public.schedule_board_ca_workbook()', 'execute')
     or has_function_privilege('service_role', 'public.schedule_board_ca_workbook()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = 'public.schedule_board_ca_workbook()'::regprocedure and a.grantee = 0) then
    raise exception 'pipeline_owner bootstrap: schedule_board_ca_workbook() or is_universal_admin() grants are wrong';
  end if;

  if has_table_privilege('pipeline_owner', 'public.schedule_board', 'select')
     or has_schema_privilege('pipeline_owner', 'auth', 'usage')
     or has_database_privilege('pipeline_owner', current_database(), 'create') then
    raise exception 'pipeline_owner bootstrap: the role can reach schedule_board, schema auth or create schemas';
  end if;
  -- Vault and cron stay shut to it (pg_net cannot be: see the header)
  if exists (select 1 from pg_namespace n where n.nspname in ('vault', 'cron', 'supabase_functions')
                and has_schema_privilege('pipeline_owner', n.oid, 'usage')) then
    raise exception 'pipeline_owner bootstrap: the role can reach schema vault, cron or supabase_functions';
  end if;
end $$;

commit;
