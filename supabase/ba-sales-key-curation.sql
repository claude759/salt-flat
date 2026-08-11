-- Hand-curated sales_key fixes where the BA store name and the sales-side account name genuinely
-- diverge (audited 2026-08-11 against the live published payload + store addresses).
-- Companion to ba-sales-metrics.sql. Safe to re-run.
--
-- Left UNMAPPED on purpose (they surface in the Tiers reconciliation line, which is the design):
--   CA: Germany, Plntbase, Yoga Box / Kenna, Treehouse Dispensary, Cookies Mission Valley
--       (ambiguous vs "Cookies San Diego"), Cannacruz Watsonville (only "CannaCruz Distro" bills),
--       Perfect Union Eastside / Morro Bay (branch keys will match if those branches ever order)
--   NY: Revelry Event, The Hibrary, The Highline Dispensary, DISPO Cannabis Club, Leafology

-- CA — STIIIZY: Distru bills the corporate "STIIIZY" account for every branch EXCEPT the two
-- stores that have their own accounts. Airfield rolls to corporate too (visitCanon precedent).
update public.dispensaries set sales_key = 'stiiizy'
 where state = 'CA' and name like 'STIIIZY %'
   and name not in ('STIIIZY Pacheco', 'STIIIZY Torrance');
update public.dispensaries set sales_key = 'stiiizy pacheco store 22'  where state = 'CA' and name = 'STIIIZY Pacheco';
update public.dispensaries set sales_key = 'stiiizy torrance store 36' where state = 'CA' and name = 'STIIIZY Torrance';
update public.dispensaries set sales_key = 'stiiizy'                    where state = 'CA' and name = 'Airfield Supply Co.';

-- CA — name variants (verified against payload customer keys)
update public.dispensaries set sales_key = 'the cake house san jose'      where state = 'CA' and name = 'Cake House San Jose';
update public.dispensaries set sales_key = 'farmhouse artisan market'     where state = 'CA' and name = 'Farmhouse Artisan';
update public.dispensaries set sales_key = 'buzz cannabis mission valley' where state = 'CA' and name = 'Buzz Mission Valley';
update public.dispensaries set sales_key = 'buzz cannabis santee'         where state = 'CA' and name = 'Buzz Santee';
update public.dispensaries set sales_key = 'bishop boyz'                  where state = 'CA' and name = 'Bishop Boys';
update public.dispensaries set sales_key = 'pacafi phenos'                where state = 'CA' and name = 'phenos';          -- Modesto (Fresno is a separate account)

-- NY — verified by store address against the LeafLink account list
update public.dispensaries set sales_key = 'farmers choice fishkill'         where state = 'NY' and name = 'Farmers Choice Dispensary';   -- 18 Westage Dr, Fishkill
update public.dispensaries set sales_key = 'canna blooms dispensary'         where state = 'NY' and name = 'Canna Blooms Dispensary - Flushing';
update public.dispensaries set sales_key = 'sofaclub ave b'                  where state = 'NY' and name = 'Sofaclub - East Village';     -- 229 Avenue B
update public.dispensaries set sales_key = 'liberty buds mahattan'           where state = 'NY' and name = 'Liberty Buds';               -- 1115 1st Ave, Manhattan; key carries LeafLink's own "Mahattan" typo — if LeafLink fixes it the reconciliation line will flag this store
update public.dispensaries set sales_key = 'star life dispensary'            where state = 'NY' and name = 'Starlife';
update public.dispensaries set sales_key = 'seshnyc'                         where state = 'NY' and name = 'Sesh';
update public.dispensaries set sales_key = 'the emerald dispensary bushwick' where state = 'NY' and name = 'Emerald Bushwick';

-- Verify: select name, sales_key from public.dispensaries where sales_key <> public.sales_norm(name) order by state, name;

-- addendum (same audit): Authentic 209 is part of the STIIIZY corporate account (visitCanon rule)
update public.dispensaries set sales_key = 'stiiizy' where state = 'CA' and name = 'Authentic 209';
