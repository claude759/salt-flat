-- Locations model (UI rename of "dispensaries"): state-scoped + private (Home)
-- locations. BAs see their state's shared locations + their own; can ADD; and
-- collaboratively EDIT/DELETE shared ones in their state. Private (Home) ones are
-- visible only to their owner (+ admins). Idempotent.

alter table public.dispensaries add column if not exists private boolean not null default false;

-- the caller's region (CA/FL/NY); security definer so RLS can read it
create or replace function public.my_region()
returns text language sql stable security definer set search_path = public as $$
  select region from public.profiles where id = auth.uid();
$$;

drop policy if exists dispensaries_select on public.dispensaries;
create policy dispensaries_select on public.dispensaries for select to authenticated
  using ( public.is_admin()
       or (private = false and state = public.my_region())   -- shared, my state
       or (created_by = auth.uid()) );                       -- mine (incl. private Home)

-- replace the old admin-only ALL policy with per-action policies
drop policy if exists dispensaries_write  on public.dispensaries;
drop policy if exists dispensaries_insert on public.dispensaries;
drop policy if exists dispensaries_update on public.dispensaries;
drop policy if exists dispensaries_delete on public.dispensaries;

create policy dispensaries_insert on public.dispensaries for insert to authenticated
  with check ( public.is_admin()
            or (created_by = auth.uid() and state = public.my_region()) );

create policy dispensaries_update on public.dispensaries for update to authenticated
  using      ( public.is_admin() or (private = false and state = public.my_region()) or created_by = auth.uid() )
  with check ( public.is_admin() or state = public.my_region() or created_by = auth.uid() );

create policy dispensaries_delete on public.dispensaries for delete to authenticated
  using      ( public.is_admin() or (private = false and state = public.my_region()) or created_by = auth.uid() );
