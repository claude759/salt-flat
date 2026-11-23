-- BA app Schedule: the people of a board, from the profiles (2026-11-23).
--
-- Until now the people a store or a task could be given to were typed into the page (SCHED_ROSTER): a new hire
-- could not be picked until someone changed the code, and someone who had left stayed on the list. A BA cannot
-- read other people's profiles, so the page asks this function instead.
--
-- One row per schedule name that reaches exactly one active person of the board: the name a task's Driver / BA
-- and a store's team carry (the first name, with the two nicknames schedule_person knows), so a task given to
-- it reaches that person's My tasks and morning email. A first name two active people share reaches nobody
-- (schedule_person gives up), so it is left out, and so is a login with no name (an e-mail address).
-- field: the people a store or a task is normally given to, the board's field BAs (not marked non_ba, nor past
-- their non_ba_from day) and the admins who work that state (Amanda in CA, Maddy in NY). The others (office and
-- distro staff with a login on the board) can still be reached, so a task already given to one of them is
-- not marked as reaching nobody.
--
-- Only first names, only to signed-in people who can see that board. Safe to run again.

drop function if exists public.schedule_people(text);
create or replace function public.schedule_people(p_state text)
returns table(name text, field boolean)
language sql stable security definer set search_path = public
as $$
  with c as (
    select p.id,
           (p.role = 'admin'
            or (p.role = 'ba' and not coalesce(p.non_ba, false)
                and (p.non_ba_from is null or p.non_ba_from > current_date))) as field,
           case when lower(split_part(trim(p.full_name), ' ', 1)) in ('leti','leticia','ledy') then 'Ledy'
                when lower(split_part(trim(p.full_name), ' ', 1)) in ('makenna','mckenna') then 'Makenna'
                else initcap(lower(split_part(trim(p.full_name), ' ', 1))) end as nm
      from public.profiles p
     where p.active
       and (p.region = p_state or p.home_region = p_state)
       and coalesce(trim(p.full_name), '') <> ''
  )
  select c.nm, bool_or(c.field)
    from c
   where p_state = any(public.schedule_states())
     and position('@' in c.nm) = 0
     and public.schedule_person(p_state, c.nm) = c.id
   group by c.nm
   order by 1;
$$;

revoke all on function public.schedule_people(text) from public, anon;
grant execute on function public.schedule_people(text) to authenticated;
