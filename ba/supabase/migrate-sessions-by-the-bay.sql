-- Sessions by the Bay (National City, CA): not in the registry, so Amanda's Sep 12 leg
-- could not link and sat red in fix mode (applied 2026-09-14). Once the row exists,
-- matchDispByText links her typed destination on her next save; no row edits needed.
insert into public.dispensaries (name, state, address, aliases, active, private, retail, created_by)
select 'Sessions by the Bay', 'CA', '700 Bay Marina Dr, National City, CA 91950',
       array['Sessions by the Bay Cannabis Dispensary and Lounge'], true, false, true,
       (select id from public.profiles where email = 'gianni@wizardtrees.com')
 where not exists (select 1 from public.dispensaries where name = 'Sessions by the Bay');
select name, sales_key, address from public.dispensaries where name = 'Sessions by the Bay';
