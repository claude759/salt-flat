-- Schedule-sheet spellings that did not match a store in the registry, so a store's scheduled
-- PAD/EDU and its BA-logged visits landed on two rows of the PAD / EDU / Drop-in report.
-- Each adds ONE alias to ONE exact row, and only if it is not already there. Safe to re-run.
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Before-state: all five rows had
-- aliases [] except Palomar ['BUZZ Cannabis Wildomar'] and Sorrento Valley ['Buzz Cannabis',
-- 'Buzz Sorrento', 'Buzz Sorrento Puff N Dash'].
update public.dispensaries set aliases = array_append(coalesce(aliases,'{}'::text[]), 'Off Green')
 where id = 'ff2dd1f9-788c-4122-aea9-eaaf11b0537e' and not ('Off Green' = any(coalesce(aliases,'{}'::text[])));            -- Off Green LA
update public.dispensaries set aliases = array_append(coalesce(aliases,'{}'::text[]), 'Buzz Wildomar')
 where id = 'd00c4d28-8e95-46ab-9bac-1e324d3f536d' and not ('Buzz Wildomar' = any(coalesce(aliases,'{}'::text[])));        -- Buzz Cannabis Palomar (Wildomar)
update public.dispensaries set aliases = array_append(coalesce(aliases,'{}'::text[]), 'Buzz Sorrento Valley')
 where id = '48051228-8caa-4eb7-b009-e54c10c8adf1' and not ('Buzz Sorrento Valley' = any(coalesce(aliases,'{}'::text[]))); -- Buzz Cannabis Sorrento Valley
update public.dispensaries set aliases = array_append(coalesce(aliases,'{}'::text[]), 'ZZFLUX WeHo')
 where id = '1bf2d4b5-710d-4320-ba9c-fe0efcc25de5' and not ('ZZFLUX WeHo' = any(coalesce(aliases,'{}'::text[])));          -- ZZFLUX West Hollywood
update public.dispensaries set aliases = array_append(coalesce(aliases,'{}'::text[]), 'ZZFLUX Mid City')
 where id = '9ef670b3-1e82-4c6a-b56a-5dfaf1e065b2' and not ('ZZFLUX Mid City' = any(coalesce(aliases,'{}'::text[])));      -- ZzFlux MidCity
select name, aliases from public.dispensaries where id in ('ff2dd1f9-788c-4122-aea9-eaaf11b0537e','d00c4d28-8e95-46ab-9bac-1e324d3f536d',
  '48051228-8caa-4eb7-b009-e54c10c8adf1','1bf2d4b5-710d-4320-ba9c-fe0efcc25de5','9ef670b3-1e82-4c6a-b56a-5dfaf1e065b2');
