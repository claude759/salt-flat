-- READ-ONLY: what the role pipeline_owner can and cannot do. Safe to run any time, before or after the bootstrap:
--   node ~/claude-sql/run-sql-ca.mjs --read "$(cat "/Users/giannilane/Documents/Claude/Projects/AR Automation/scripts/pipeline-ci/verify-role.sql")"
-- One row per check: ok is true when all is well, and detail names what is off (object names and counts, never data).
-- Before the bootstrap only "role exists" shows (false). Before lockdown-public-execute.sql (M1), the M1 and E6 rows are
-- false: PUBLIC, and so any login role, can still run 48 postgres-owned definer functions. The "known gap" row about
-- pg_net stays false until Supabase closes it (see the header of supabase/postgres/pipeline-owner-bootstrap.sql): it is
-- not a setup error, and nothing on this project can fix it from postgres.
with me as (select r.* from pg_roles r where r.rolname = 'pipeline_owner'),
pub as (select oid from pg_namespace where nspname = 'public'),
bridge as (select to_regprocedure('public.schedule_board_ca_workbook()') as oid),
checks(n, name, ok, detail) as (
  select 0, 'role exists', exists (select 1 from me),
         case when exists (select 1 from me) then '' else 'run supabase/postgres/pipeline-owner-bootstrap.sql' end

  union all
  select 1, 'E1 no superuser, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS; 3 connections at most',
         not (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls) and rolconnlimit = 3,
         format('super=%s createrole=%s createdb=%s replication=%s bypassrls=%s connlimit=%s',
                rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit)
    from me
  union all
  select 1, 'E1 login (on once owner-login.mjs''s file is applied)', true,
         case when rolcanlogin then 'login on' else 'login off' end from me

  union all
  select 2, 'E2 member of no role (not anon, authenticated, service_role or postgres)',
         count(a.roleid) = 0, coalesce(string_agg(r.rolname, ', '), '')
    from me left join pg_auth_members a on a.member = me.oid left join pg_roles r on r.oid = a.roleid
   group by me.oid
  union all
  select 2, 'E2 postgres is a member with INHERIT and SET (keeps its access); no app role is a member',
         bool_or(m.rolname = 'postgres' and a.inherit_option and a.set_option) is true
           and bool_and(m.rolname in ('postgres', 'supabase_admin')) is true,
         coalesce(string_agg(m.rolname || case when a.admin_option then ' admin' else '' end
                             || case when a.inherit_option then ' inherit' else '' end
                             || case when a.set_option then ' set' else '' end, '; '), 'no members')
    from me left join pg_auth_members a on a.roleid = me.oid left join pg_roles m on m.oid = a.member
   group by me.oid

  union all
  select 3, 'E3 owns nothing but public.pipeline_* objects', count(x) = 0, coalesce(string_agg(x, ', ' order by x), '')
    from me left join lateral (
      select n.nspname || '.' || c.relname as x from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relowner = me.oid and n.nspname not like 'pg\_%' and not (n.nspname = 'public' and c.relname like 'pipeline\_%')
      union all
      select n.nspname || '.' || p.proname || '()' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.proowner = me.oid and not (n.nspname = 'public' and p.proname like 'pipeline\_%')
      union all
      select 'schema ' || n.nspname from pg_namespace n where n.nspowner = me.oid
    ) o on true
   group by me.oid
  union all
  select 3, 'E3 every public.pipeline_* table, sequence, view and function belongs to it', count(x) = 0,
         coalesce(string_agg(x, ', ' order by x), '')
    from me left join lateral (
      select c.relname as x from pg_class c, pub
       where c.relnamespace = pub.oid and c.relname like 'pipeline\_%' and c.relkind in ('r','p','v','m','S','f')
         and c.relowner <> me.oid
      union all
      select p.proname || '()' from pg_proc p, pub
       where p.pronamespace = pub.oid and p.proname like 'pipeline\_%' and p.proowner <> me.oid
    ) o on true
   group by me.oid
  union all
  select 3, 'E3 shared dependencies (o owner, a privileges, i initial) for the record', true,
         coalesce(string_agg(d.deptype::text || '=' || d.cnt, ' ' order by d.deptype::text), 'none')
    from me left join lateral (select s.deptype, count(*) as cnt from pg_shdepend s where s.refobjid = me.oid group by s.deptype) d on true
   group by me.oid

  union all
  select 4, 'E4 can read or write no table outside the pipeline (net''s two tables excepted: see the known gap row)',
         count(x) = 0, coalesce(string_agg(x, ', ' order by x), '')
    from me left join lateral (
      select n.nspname || '.' || c.relname as x
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r','v','m','p','f')
         and n.nspname not in ('pg_catalog', 'information_schema')
         and not (n.nspname = 'public' and c.relname like 'pipeline\_%')
         and not (n.nspname = 'net' and c.relname in ('_http_response', 'http_request_queue'))
         and has_schema_privilege(me.oid, n.oid, 'usage')
         and (has_table_privilege(me.oid, c.oid, 'select') or has_table_privilege(me.oid, c.oid, 'insert,update,delete,truncate'))
    ) o on true
   group by me.oid
  union all
  select 4, 'E4 spot check: payroll, BA, finance, vault, schedule_board, packaging_tasks, auth.users', count(t) = 0,
         coalesce(string_agg(t, ', ' order by t), '')
    from me left join lateral (
      select t from unnest(array['public.profiles', 'public.hours', 'public.pay_periods', 'public.submissions',
                                 'public.trips', 'public.expenses', 'public.ba_rates', 'public.ts_days', 'public.ts_people',
                                 'public.gusto_pull_requests', 'public.fin_keys', 'public.fin_snapshot',
                                 'public.royalty_snapshot', 'public.vault_entries', 'public.vault_logins',
                                 'public.schedule_board', 'public.packaging_tasks', 'auth.users']) t
       where to_regclass(t) is not null
         and (coalesce(has_table_privilege(me.oid, to_regclass(t), 'select'), false)
              or coalesce(has_table_privilege(me.oid, to_regclass(t), 'insert,update,delete,truncate'), false))
    ) o on true
   group by me.oid

  union all
  select 4, 'E4 known gap, not a setup error: pg_net is open to every role, this one included (only Supabase can close it)',
         not coalesce(has_schema_privilege(me.oid, to_regnamespace('net'), 'usage')
                      and (coalesce(has_table_privilege(me.oid, to_regclass('net.http_request_queue'), 'select,insert,update,delete,truncate,trigger'), false)
                           or coalesce(has_table_privilege(me.oid, to_regclass('net._http_response'), 'select,insert,update,delete,truncate,trigger'), false)
                           or exists (select 1 from pg_proc p where p.pronamespace = to_regnamespace('net')
                                         and has_function_privilege(me.oid, p.oid, 'execute'))), false),
         format('request queue (other apps'' calls, Vault secrets in their headers): %s; responses: %s; net functions it may run: %s of %s',
                case when coalesce(has_table_privilege(me.oid, to_regclass('net.http_request_queue'), 'select'), false) then 'can read' else 'cannot read' end
                || case when coalesce(has_table_privilege(me.oid, to_regclass('net.http_request_queue'), 'delete,truncate'), false) then ' and empty' else '' end,
                case when coalesce(has_table_privilege(me.oid, to_regclass('net._http_response'), 'select'), false) then 'can read' else 'cannot read' end
                || case when coalesce(has_table_privilege(me.oid, to_regclass('net._http_response'), 'delete,truncate'), false) then ' and empty' else '' end,
                (select count(*) from pg_proc p where p.pronamespace = to_regnamespace('net') and has_function_privilege(me.oid, p.oid, 'execute')),
                (select count(*) from pg_proc p where p.pronamespace = to_regnamespace('net')))
    from me

  union all
  select 5, 'E5 schemas: USAGE only on public and net, CREATE only on public', count(x) = 0,
         coalesce(string_agg(x, ', ' order by x), '')
    from me left join lateral (
      select n.nspname || case when has_schema_privilege(me.oid, n.oid, 'create') then ' (create)' else ' (usage)' end as x
        from pg_namespace n
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
         and ((has_schema_privilege(me.oid, n.oid, 'usage') and n.nspname not in ('public', 'net'))
              or (has_schema_privilege(me.oid, n.oid, 'create') and n.nspname <> 'public'))
    ) o on true
   group by me.oid
  union all
  select 5, 'E5 cannot create schemas or extensions', not has_database_privilege(me.oid, current_database(), 'create'), ''
    from me

  union all
  select 6, 'E6 security definer functions it can run as their owner: only is_universal_admin() and schedule_board_ca_workbook()',
         count(f) filter (where not allowed) = 0,
         format('%s in all; unexpected: %s', count(f), coalesce(string_agg(f, ', ' order by f) filter (where not allowed), 'none'))
    from me left join lateral (
      select p.oid::regprocedure::text as f,
             coalesce(p.oid = any (array['public.is_universal_admin()'::regprocedure::oid, (select oid from bridge)]), false) as allowed
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and p.proowner <> me.oid
         and has_schema_privilege(me.oid, n.oid, 'usage') and has_function_privilege(me.oid, p.oid, 'execute')
    ) o on true
   group by me.oid
  union all
  select 6, 'M1 applied: PUBLIC runs no postgres-owned definer function in public', count(*) = 0,
         case when count(*) = 0 then '' else count(*) || ' still open to PUBLIC: apply supabase/postgres/lockdown-public-execute.sql' end
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proowner = 'postgres'::regrole
     and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)
  union all
  select 6, 'M1 applied: functions postgres creates are not PUBLIC by default',
         exists (select 1 from pg_default_acl d where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0
                    and d.defaclobjtype = 'f' and not exists (select 1 from aclexplode(d.defaclacl) a where a.grantee = 0)),
         ''
  union all
  select 6, 'bridge: only pipeline_owner may run schedule_board_ca_workbook()',
         coalesce(b.oid is not null
           and has_function_privilege(me.oid, b.oid, 'execute')
           and not has_function_privilege('anon', b.oid, 'execute')
           and not has_function_privilege('authenticated', b.oid, 'execute')
           and not has_function_privilege('service_role', b.oid, 'execute')
           and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            where p.oid = b.oid and a.grantee = 0), false),
         coalesce((select pg_get_userbyid(p.proowner) || ' owns it' from pg_proc p where p.oid = b.oid), 'missing')
    from me cross join bridge b

  union all
  select 7, 'E7 page and save-program function privileges as before', count(x) = 0, coalesce(string_agg(x, '; ' order by x), '')
    from me left join lateral (
      select v.f || ': ' || v.r || case when v.want then ' cannot run it' else ' can run it' end as x
        from (values
          ('pipeline_source()', 'anon', false), ('pipeline_source()', 'authenticated', true), ('pipeline_source()', 'service_role', true),
          ('pipeline_can_view()', 'anon', false), ('pipeline_can_view()', 'authenticated', true), ('pipeline_can_view()', 'service_role', true),
          ('pipeline_can_edit(text)', 'anon', false), ('pipeline_can_edit(text)', 'authenticated', true), ('pipeline_can_edit(text)', 'service_role', true),
          ('pipeline_edit_status()', 'anon', false), ('pipeline_edit_status()', 'authenticated', true), ('pipeline_edit_status()', 'service_role', true),
          ('pipeline_marks_save(text,jsonb,jsonb)', 'anon', true), ('pipeline_marks_save(text,jsonb,jsonb)', 'authenticated', true),
          ('pipeline_batches_save(text,jsonb,jsonb)', 'anon', true), ('pipeline_batches_save(text,jsonb,jsonb)', 'authenticated', true),
          ('pipeline_batch_labs_save(text,jsonb)', 'anon', true), ('pipeline_batch_labs_save(text,jsonb)', 'authenticated', true),
          ('pipeline_trims_save(text,jsonb,jsonb)', 'anon', true), ('pipeline_trims_save(text,jsonb,jsonb)', 'authenticated', true),
          ('pipeline_inventory_save(text,text,jsonb,jsonb)', 'anon', true), ('pipeline_inventory_save(text,text,jsonb,jsonb)', 'authenticated', true),
          ('pipeline_lock_cells(text[],integer,text,text)', 'anon', false), ('pipeline_lock_cells(text[],integer,text,text)', 'authenticated', false),
          ('pipeline_lock_cells(text[],integer,text,text)', 'service_role', true),
          ('pipeline_unlock_cells(text[],text)', 'anon', false), ('pipeline_unlock_cells(text[],text)', 'authenticated', false),
          ('pipeline_unlock_cells(text[],text)', 'service_role', true)
        ) v(f, r, want)
       where to_regprocedure('public.' || v.f) is null
          or has_function_privilege(v.r, to_regprocedure('public.' || v.f), 'execute') <> v.want
    ) o on true
   group by me.oid
  union all
  select 7, 'E7 private tables stay private (editors, switches, locks, deploy record; edit log not for anon)', count(x) = 0,
         coalesce(string_agg(x, '; ' order by x), '')
    from me left join lateral (
      select v.t || ': ' || v.r || ' can ' || v.p as x
        from (values ('pipeline_editors', 'anon', 'select'), ('pipeline_editors', 'authenticated', 'select'),
                     ('pipeline_write_settings', 'anon', 'select'), ('pipeline_write_settings', 'authenticated', 'select'),
                     ('pipeline_edit_locks', 'anon', 'select'), ('pipeline_edit_locks', 'authenticated', 'select'),
                     ('pipeline_sql_applied', 'anon', 'select'), ('pipeline_sql_applied', 'authenticated', 'select'),
                     ('pipeline_edits', 'anon', 'select'), ('pipeline_edits', 'authenticated', 'insert')) v(t, r, p)
       where to_regclass('public.' || v.t) is not null and has_table_privilege(v.r, to_regclass('public.' || v.t), v.p)
    ) o on true
   group by me.oid
  union all
  select 7, 'E7 row level security on every pipeline table; token tables have no policies', count(x) = 0,
         coalesce(string_agg(x, ', ' order by x), '')
    from (select c.relname || ' (rls off)' as x from pg_class c, pub
           where c.relnamespace = pub.oid and c.relname like 'pipeline\_%' and c.relkind in ('r','p') and not c.relrowsecurity
          union all
          select c.relname || ' (has a policy)' from pg_class c, pub
           where c.relnamespace = pub.oid and c.relname ~ '^pipeline_.*_secret$' and c.relkind = 'r'
             and exists (select 1 from pg_policy p where p.polrelid = c.oid)) o

  union all
  select 8, 'E8 default privileges for what pipeline_owner creates (4 entries: no PUBLIC functions; tables, sequences, functions to the app roles)',
         count(d.oid) = 4,
         coalesce(string_agg(coalesce(nullif(d.defaclnamespace, 0::oid)::regnamespace::text, 'all schemas') || ' ' || d.defaclobjtype::text
                             || ' ' || d.defaclacl::text, '; ' order by d.defaclnamespace, d.defaclobjtype), 'none')
    from me left join pg_default_acl d on d.defaclrole = me.oid
   group by me.oid
  union all
  select 8, 'E8 deploy record public.pipeline_sql_applied exists, belongs to it, row level security on',
         coalesce((select c.relowner = me.oid and c.relrowsecurity from pg_class c
                    where c.oid = to_regclass('public.pipeline_sql_applied')), false),
         coalesce((select pg_get_userbyid(c.relowner) || ' owns it' from pg_class c
                    where c.oid = to_regclass('public.pipeline_sql_applied')), 'missing')
    from me
)
select name, ok, detail from checks order by n, name;
