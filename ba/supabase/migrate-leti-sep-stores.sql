-- Five stores Leti visited Aug 29 to Sep 11 that were not in the registry, plus the
-- link-up of her seven mileage legs to them (applied to the live project 2026-09-14).
--
-- She typed the store names in the mileage grid; with no registry match the destination
-- resolved to a Google address instead of a store chip, and the "Attribute this leg to"
-- picker only offers registered stores. The miles were already right (Google-routed);
-- only the store attribution was missing, so the BA visit/spend reports skipped them.
--
-- 1820 S Street is All About Wellness, which is part of the KOLAS family (kolas.com lists
-- it as "All About Wellness Midtown"), hence Leti's "the rest are Kolas".
-- Addresses from each chain's own site. lat/lng are left NULL on purpose: calc-distance
-- fills them the first time a trip targets the store. sales_key is set by disp_sales_key.
-- Safe to re-run: inserts skip names that already exist; trip updates are id-scoped.

insert into public.dispensaries (name, state, address, license, aliases, active, private, retail, created_by)
select v.name, 'CA', v.address, v.license, v.aliases, true, false, true,
       (select id from public.profiles where email = 'gianni@wizardtrees.com')
  from (values
    ('KOLAS Arden',                         '1760 Challenge Way, Sacramento, CA 95815', null,               array['KOLAS Weed Dispensary & Delivery - Arden']),
    ('KOLAS Main Ave',                      '1704 Main Ave, Sacramento, CA 95838',      null,               array['KOLAS Weed Dispensary & Delivery - Main Ave']),
    ('All About Wellness (KOLAS Midtown)',  '1820 S St, Sacramento, CA 95811',          null,               array['KOLAS S Street','All About Wellness Midtown']),
    ('Vibe by California Redding',          '3270 S Market St, Redding, CA 96001',      null,               array['Vibe Cannabis Redding']),
    ('Perfect Union - San Jose',            '2220 Business Circle, San Jose, CA 95128', 'C10-0001686-LIC',  array['Perfect Union San Jose'])
  ) as v(name, address, license, aliases)
 where not exists (select 1 from public.dispensaries d where d.name = v.name);

-- Leti's legs (trip ids from the Sep 14 review). Draft rows: trg_trip_before re-prices at
-- the same rate, trips_autolink_hours re-links that day's Gusto hours to the new store.
update public.trips set dispensary_id = (select id from public.dispensaries where name = 'KOLAS Arden')
 where id in ('18403eef-eef6-4311-9d7d-5742e6b7e61d', 'c7532dfe-1278-49b1-907c-079d981ee0d1');
update public.trips set dispensary_id = (select id from public.dispensaries where name = 'All About Wellness (KOLAS Midtown)')
 where id in ('268c9f6f-f667-4224-a94c-f0c762245b39', '19b55b65-3c44-46d1-9322-5e43e3bb9de2');
update public.trips set dispensary_id = (select id from public.dispensaries where name = 'KOLAS Main Ave')
 where id = '8407d1ec-811c-4534-a775-5355993ae0b1';
update public.trips set dispensary_id = (select id from public.dispensaries where name = 'Vibe by California Redding')
 where id = '9c724e6c-c03d-4643-a322-b322fcabc013';
update public.trips set dispensary_id = (select id from public.dispensaries where name = 'Perfect Union - San Jose')
 where id = '9f17fde2-7423-418a-9412-6540bd69ca3f';

-- Verify: every non-Travel leg linked, and the hours for those days now carry the stores.
select json_build_object(
  'stores', (select json_agg(json_build_object('name',name,'key',sales_key,'addr',address) order by name)
               from public.dispensaries where name in ('KOLAS Arden','KOLAS Main Ave','All About Wellness (KOLAS Midtown)','Vibe by California Redding','Perfect Union - San Jose')),
  'unlinked_legs', (select count(*) from public.trips t
                     where t.ba_id = (select id from public.profiles where email='leticia@wizardtrees.com')
                       and t.trip_date between '2026-08-29' and '2026-09-11' and t.dispensary_id is null and t.kind <> 'Travel'),
  'legs', (select json_agg(json_build_object('d',t.trip_date,'kind',t.kind,'amt',t.amount,'store',(select name from public.dispensaries d where d.id=t.dispensary_id)) order by t.trip_date)
             from public.trips t where t.id in ('18403eef-eef6-4311-9d7d-5742e6b7e61d','c7532dfe-1278-49b1-907c-079d981ee0d1','268c9f6f-f667-4224-a94c-f0c762245b39','19b55b65-3c44-46d1-9322-5e43e3bb9de2','8407d1ec-811c-4534-a775-5355993ae0b1','9c724e6c-c03d-4643-a322-b322fcabc013','9f17fde2-7423-418a-9412-6540bd69ca3f')),
  'hours', (select json_agg(json_build_object('d',h.work_date,'hrs',h.hours,'status',h.status,
              'stores',(select string_agg(d.name,' | ') from public.dispensaries d where d.id = any(h.dispensary_ids))) order by h.work_date)
              from public.hours h where h.ba_id=(select id from public.profiles where email='leticia@wizardtrees.com')
               and h.work_date in ('2026-09-02','2026-09-03','2026-09-08','2026-09-09','2026-09-10'))
) as r;
