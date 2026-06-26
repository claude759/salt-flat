-- CA dispensaries imported from distru (name+legal+address) + transfer report (license).
-- Self-contained + idempotent: adds the columns it needs and a unique (lower(name),state)
-- index, so re-running won't duplicate and it works regardless of earlier migrations.
alter table public.dispensaries add column if not exists state      text check (state in ('CA','FL','NY'));
alter table public.dispensaries add column if not exists legal_name text;
create unique index if not exists dispensaries_name_state_uniq on public.dispensaries (lower(name), state);

insert into public.dispensaries (name, legal_name, address, license, state) values
('Higher Ground Moreno Valley', 'Rd Moval LLC', '21820 Alessandro Blvd, Moreno Valley, CA 92553, US', 'C10-0000895-LIC', 'CA'),
('Goat Global Westwood', 'WESTWOOD WORLD LLC', '2299 Westwood Blvd, Los Angeles, CA 90064, US', 'C10-0000928-LIC', 'CA'),
('Big Chief Silver Lake', 'Valley Health Center Collective, Inc.', '1700 Silver Lake Blvd, Los Angeles, CA 90026, US', 'C10-0001599-LIC', 'CA'),
('Evergreen OC', 'Stpc Enterprises, Inc.', '1320 E Edinger Ave, Santa Ana, CA 92705, US', 'C10-0000363-LIC', 'CA'),
('Lemonnade Van Nuys', 'Daddy''s Pipes Inc', '7040 Hayvenhurst Pl, Los Angeles, CA 91406, US', 'C12-0000092-LIC', 'CA'),
('Cake House El Monte', 'Nibble This - El Monte, LLC', '4728 Peck Rd, El Monte, CA 91732, US', 'C10-0001384-LIC', 'CA'),
('Cookies Woodland Hills', 'After Care Patient''s Group', '5334 Alhama Dr, Los Angeles, CA 91364, US', 'C10-0000604-LIC', 'CA'),
('Royal Healing Emporium', 'Royal Healing Emporium, Inc.', '721 W Central Ave, Lompoc, CA 93436, US', 'C10-0000208-LIC', 'CA'),
('The Ounce North Hollywood', 'Newcorp Acquisition LLC. [Equity Retailer]', '11032 Magnolia Blvd, Los Angeles, CA 91601, US', null, 'CA'),
('Herbal Pain Relief Center North Hills', 'HERBAL PAIN RELIEF CENTER INC', '10736 Sepulveda Blvd, Los Angeles, CA 91345, US', 'C10-0000712-LIC', 'CA'),
('These Days Northridge', 'Ceremony Dispensary #01', '19707 Nordhoff St, Los Angeles, CA 91324, US', 'C10-0001304-LIC', 'CA'),
('Kush Alley North Hills', 'Kush Alley, Inc., A California Corporation', '16733 Schoenborn St, Los Angeles, CA 91343, US', 'C10-0000093-LIC', 'CA'),
('High Seas Costa Mesa', 'Seascape Holdings, Inc.', '1921 Harbor Blvd, Costa Mesa, CA 92627, US', 'C10-0001510-LIC', 'CA'),
('Plant Galaxy Riverside', 'Excel Riverside Inc.', '1270 Center St, Riverside, CA 92507, US', 'C10-0000876-LIC', 'CA'),
('We Roll Up San Pedro', 'The Green Co. Dispensary Inc.', '1705 S Gaffey St, Los Angeles, CA 90731, US', 'C10-0000854-LIC', 'CA'),
('Roots 2 Harvest Lake Elsinore', 'R2h Holdings LLC', '29370 Hunco Way, Lake Elsinore, CA 92530, US', 'C12-0000389-LIC', 'CA'),
('We Roll Up Culver City', 'GDinLA, Inc. [Equity Retailer]', '11834 Jefferson Blvd, Culver City, CA 90230, US', null, 'CA'),
('STIIIZY', 'Sgi Jackson LLC', '2311 S Santa Fe Ave, Vernon, CA 90058, US', 'C11-0001947-LIC', 'CA'),
('Higher Ground San Bernardino', 'Rd San Bernardino LLC', '240 E Redlands Blvd, San Bernardino, CA 92408, US', 'C10-0001021-LIC', 'CA'),
('High Tide Delivery', 'Rd Lynwood Retail LLC', '11510 Alameda St, Lynwood, CA 90262, US', 'C10-0001420-LIC', 'CA'),
('Higher Ground Lynwood', 'Rd Lynwood Retail LLC', '11510 Alameda St, Lynwood, CA 90262, US', 'C10-0001420-LIC', 'CA'),
('C.A.R.E. COLLECTIVE INC', 'C.A.R.E. Collective, Inc', '2725 South St, Long Beach, CA 90805, US', 'C10-0000521-LIC', 'CA'),
('Benzeen La Brea', 'La Brea Connection LLC', '360 N La Brea Ave, Los Angeles, CA 90036, US', 'C10-0001253-LIC', 'CA'),
('Greenway Highway Delivery Los Angeles', 'Greenway Highway Inc.', '13019 Terra Bella St, Los Angeles, CA 91331, US', 'C9-0000849-LIC', 'CA'),
('Greenhouse Herbal Center Hollywood', 'Greenhouse Herbal Center, LLC', '5224 Hollywood Blvd, Los Angeles, CA 90027, US', 'C10-0000414-LIC', 'CA'),
('Bard Boys Oxnard', 'Advocate Society LLC', '2550 E Vineyard Ave, Oxnard, CA 93036, US', 'C10-0001634-LIC', 'CA'),
('Higher Ground Baldwin Park', 'Rd X Catalyst Baldwin Park LLC', '13467 Dalewood St, Baldwin Park, CA 91706, US', 'C10-0001441-LIC', 'CA'),
('The Marathon Collective Canoga Park', 'Huntington Patients'' Association, Inc.', '7011 Canoga Ave, Los Angeles, CA 91303, US', 'C10-0000406-LIC', 'CA'),
('Higher Ground Canyon Lake', 'RD CANYON LAKE LLC', '31528 Railroad Canyon Rd, Canyon Lake, CA 92587, US', 'C10-0001702-LIC', 'CA'),
('The Maven Store Tarzana', 'The 18629 LLC', '18629 Ventura Blvd, Los Angeles, CA 91356, US', 'C10-0001128-LIC', 'CA'),
('Valley Verde Van Nuys', '14901 Sherman Way LLC', '14903 Sherman Way, Los Angeles, CA 91405, US', 'C10-0000839-LIC', 'CA'),
('Catalyst Hawthorne', 'Catalyst - Hawthorne LLC', '14115 Crenshaw Blvd, Hawthorne, CA 90250, US', 'C10-0001427-LIC', 'CA'),
('Natural Aid Sunland', 'Natural Aid Pharmacy, A Cooperative Corporation', '8124 Foothill Blvd, Los Angeles, CA 91040, US', null, 'CA'),
('WeedWay Tujunga', 'St. Andrew''s Green, A Cooperative Corporation', '7031 Foothill Blvd, Los Angeles, CA 91042, US', null, 'CA'),
('Jungle Boys Pomona', 'United Pomona', '196 University Pkwy, Pomona, CA 91768, US', null, 'CA'),
('Jungle Boys OC', '55 Oc Collective, Inc.', '2911 Tech Center Dr, Santa Ana, CA 92705, US', null, 'CA'),
('Catalyst DTLB (Pine)', 'Casey Crow Collective', '433 Pine Ave, Long Beach, CA 90802, US', 'C10-0000801-LIC', 'CA'),
('The Vault Woodland Hills Inc', 'he Vault Woodland Hills Inc', '22815 Ventura Blvd, Los Angeles, CA 91364, US', 'C10-0000458-LIC', 'CA'),
('Exotix Hollywood- Aces LLC', 'Aces La Inc. [Equity Retailer]', '738 Highland Ave, Los Angeles, CA 90038, US', null, 'CA'),
('Jaderoom Santa Ana', 'the 10 Spot, Inc.', '2700 S Shannon St, Santa Ana, CA 92704, US', 'C10-0000400-LIC', 'CA'),
('Sweet Flower Westwood', 'Safe Harbor Patient''s Collective, Inc', '1413 Westwood Blvd, Los Angeles, CA 90024, US', null, 'CA'),
('Treehouse Moreno Valley', 'Hyperfoxxx', '24081 Postal Ave, Moreno Valley, CA 92553, US', null, 'CA'),
('Jungle Boys DTLA', 'Hezekiah Incorporated', '1530 S Alameda St, Los Angeles, CA 90021, US', 'C10-0001146-LIC', 'CA')
on conflict (lower(name), state) do nothing;
