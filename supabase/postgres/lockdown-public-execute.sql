-- M1: take PUBLIC's right to run postgres-owned security definer functions in schema public, outside the pipeline.
--
-- Why: a security definer function runs as its owner (postgres). Postgres lets PUBLIC, meaning every role that can
-- log in, run a new function unless that is revoked, and 48 of these functions still allow it. Any login role (such
-- as pipeline_owner, whose password lives in GitHub) could call them and fake the request's claims to pass their
-- auth.uid() / is_admin() checks: BA pay rates, hours and expenses, the logins vault reminder, unsubmit_period,
-- schedule_restore_rows. The app roles (anon, authenticated, service_role) do not need PUBLIC: every one of these
-- functions grants them by name, so the pages and Edge Functions keep exactly what they have. Triggers, cron jobs
-- (they run as postgres) and wrappers owned by postgres are unaffected.
--
-- The one intended change: schedule_restore_rows(text,jsonb,text) stops being callable by anon and authenticated.
-- ba/supabase/migrate-schedule-backup.sql already revoked them; only PUBLIC kept the door open.
--
-- It also sets postgres's default privileges so functions postgres creates from now on are not PUBLIC-executable.
-- That default covers every schema (Postgres cannot narrow it to one): new functions in public and storage still
-- reach anon, authenticated and service_role through Supabase's per-schema defaults; a function postgres creates in
-- any other schema (for example by installing an extension) needs an explicit GRANT for the roles that call it.
--
-- ONE-TIME, run as postgres from Gianni's Mac, best right after pipeline-owner-bootstrap.sql and before pipeline_owner
-- can log in:
--   node ~/claude-sql/run-sql-ca.mjs "/Users/giannilane/Documents/Claude/Projects/AR Automation/supabase/postgres/lockdown-public-execute.sql"
-- Before and after, run the read-only check and compare (only the public_x column and schedule_restore_rows's anon
-- and authenticated columns should change):
--   node ~/claude-sql/run-sql-ca.mjs --read "$(cat "/Users/giannilane/Documents/Claude/Projects/AR Automation/supabase/postgres/lockdown-public-execute-check.sql")"
-- The file checks itself too: if any of anon, authenticated or service_role would lose a function other than that
-- one, it stops and changes nothing. Safe to re-run.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temp table _m1_before on commit drop as
  select p.oid, format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig,
         p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as allowed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
   where n.nspname = 'public' and p.prosecdef and p.proowner = 'postgres'::regrole and p.proname not like 'pipeline\_%';

do $$
declare f record; n int := 0;
begin
  for f in
    select format('%I.%I(%s)', ns.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.prosecdef and p.proowner = 'postgres'::regrole
       and p.proname not like 'pipeline\_%'
       and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE')
     order by 1
  loop
    execute format('revoke execute on function %s from public', f.sig);
    n := n + 1;
  end loop;
  raise notice 'M1: PUBLIC can no longer run % security definer functions', n;
end $$;

alter default privileges for role postgres revoke execute on functions from public;

do $$
declare lost text; still text;
begin
  select string_agg(b.sig || ' for ' || b.rolname, ', ' order by b.sig, b.rolname) into lost
    from _m1_before b
   where b.allowed and not has_function_privilege(b.rolname, b.oid, 'execute')
     and not (b.proname = 'schedule_restore_rows' and b.rolname in ('anon', 'authenticated'));
  if lost is not null then
    raise exception 'M1 stopped, nothing changed: it would take these away: %', lost;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into still
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proowner = 'postgres'::regrole
     and p.proname not like 'pipeline\_%'
     and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE');
  if still is not null then
    raise exception 'M1 stopped, nothing changed: PUBLIC can still run: %', still;
  end if;

  if not exists (select 1 from pg_default_acl d
                  where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
                    and not exists (select 1 from aclexplode(d.defaclacl) a where a.grantee = 0)) then
    raise exception 'M1 stopped, nothing changed: the default privileges did not change';
  end if;
end $$;

commit;
