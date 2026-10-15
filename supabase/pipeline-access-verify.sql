-- Checks pipeline_source() as every active account would call it: universal admins and
-- pipeline_viewers get the workbook id, everyone else gets nothing. Writes nothing lasting:
-- the claims are transaction-local and the result table is a temp table.
create temp table if not exists _pipeline_access_check(gets_workbook boolean, expected boolean);
delete from _pipeline_access_check;
do $$
declare r record; got text;
begin
  for r in
    select u.id, u.email,
           (p.role = 'admin' and p.region is null)
             or exists (select 1 from public.pipeline_viewers v where v.email = lower(u.email)) as expected
    from auth.users u join public.profiles p on p.id = u.id
    where p.active
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.id::text, 'email', r.email, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    got := public.pipeline_source();
    execute 'reset role';
    insert into _pipeline_access_check values (got is not null, r.expected);
  end loop;
end $$;
select count(*) filter (where gets_workbook and expected) as allowed,
       count(*) filter (where not gets_workbook and not expected) as refused,
       count(*) filter (where gets_workbook <> expected) as wrong
from _pipeline_access_check;
