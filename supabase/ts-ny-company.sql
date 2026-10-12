-- Manager Gusto Timesheets: Wizard Trees NY (round 4, 2026-10-12). One company row in region NY. The '*'
-- company grant stays California-only (ts_my_grant_keys / ts_can_view expand '*' to region 'CA'), so
-- existing "All CA" sign-ins do not start seeing New York. Safe to re-run.
insert into public.ts_companies (key, name, region) values ('wtny', 'Wizard Trees NY', 'NY')
on conflict (key) do nothing;
select key, name, region, connected from public.ts_companies order by region, key;
