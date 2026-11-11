-- READ-ONLY check for lockdown-public-execute.sql (M1). Run it before and after M1 and compare:
--   node ~/claude-sql/run-sql-ca.mjs --read "$(cat "/Users/giannilane/Documents/Claude/Projects/AR Automation/supabase/postgres/lockdown-public-execute-check.sql")"
-- One row per postgres-owned security definer function in schema public outside the pipeline, saying who may run it.
-- After M1: public_x is false on every row, and the other columns are unchanged except schedule_restore_rows, whose
-- anon_x and authenticated_x turn false. pipeline_owner_x (empty until the role exists) should then be true only for
-- is_universal_admin() and schedule_board_ca_workbook().
select p.oid::regprocedure::text as function,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x,
       has_function_privilege('anon', p.oid, 'execute') as anon_x,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_x,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_x,
       case when exists (select 1 from pg_roles where rolname = 'pipeline_owner')
            then has_function_privilege((select oid from pg_roles where rolname = 'pipeline_owner'), p.oid, 'execute')
       end as pipeline_owner_x
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proowner = 'postgres'::regrole
   and p.proname not like 'pipeline\_%'
 order by 1;
