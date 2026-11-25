-- BA app: a manager adds a missing store from the Stores page, and sees why the registry sync didn't add it itself
-- (Gianni 2026-11-25, after Amanda asked for "the new shops" in the store view: "This isn't something I should have to
-- do manually. These stores should already be in the shared dispensary database with the sales app. But she should be
-- able to add them manually without asking me."). Safe to run again.
--   1. store_registry_review          what the hourly CA registry sync (~/ar-automation/lib/ca-registry.mjs) leaves for a
--                                     person: one row per state and billing name, with the sync's reason; managers of
--                                     that state read it, nobody writes it from the app
--   2. store_registry_review_replace  how the sync saves that list: one state at a time (the sync runs as postgres)
--   3. store_license_key, store_address_key, store_address_city: licenses and addresses reduced for comparing. Names
--      are compared by public.sales_norm (ba-sales-metrics.sql: the exact twin of the sales app's tierNorm, also what
--      fills dispensaries.sales_key) and public.schedule_store_key (ba-schedule-task-status.sql), used as they are
--   4. store_registry_match           the registry rows that may already be the store being added (Stores and Locations)
--   5. store_registry_add             a manager adds a store, with the billing name it came from and its territory
--   6. store_registry_link            a manager links a billing name to a store already in the registry

-- ── 1. the sync's "for a person" list ───────────────────────────────────────────────────────────
create table if not exists public.store_registry_review (
  state        text not null check (state in ('CA','NY','FL')),
  customer     text not null,                 -- the billing name, as the sales app has it
  sales_key    text,                          -- its tierNorm = store_sales.sales_key (what the page joins on)
  kind         text,                          -- the sync's category: lookalike, not-a-store, same-door-other-licence, ...
  why          text,                          -- the sync's whole reason
  conflict     boolean not null default false,
  license      text,                          -- what the sync found for the customer: license, legal name, premises
  legal_name   text,
  address      text,
  lat          double precision,
  lng          double precision,
  candidate_id uuid,                          -- the registry row it may be, or that stood in the way
  updated_at   timestamptz not null default now(),
  primary key (state, customer)
);
alter table public.store_registry_review enable row level security;
drop policy if exists store_registry_review_select on public.store_registry_review;
create policy store_registry_review_select on public.store_registry_review for select to authenticated
  using (public.is_universal_admin() or (public.is_admin() and state = public.admin_region()));
revoke all on public.store_registry_review from anon, authenticated;
grant select on public.store_registry_review to authenticated;

-- ── 2. the sync replaces one state's list at a time ─────────────────────────────────────────────
-- p_rows: [{customer, sales_key, kind, why, conflict, license, legal_name, address, lat, lng, candidate_id}]. An empty
-- list is allowed: nothing left for a person. A billing name sent twice is kept once (its first row). A row with no
-- sales_key gets the tierNorm of its billing name; a lat, lng or candidate_id that isn't one is left empty, so one bad
-- field never loses the whole list.
create or replace function public.store_registry_review_replace(p_state text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if p_state is null or p_state not in ('CA','NY','FL') then raise exception 'unknown state %', p_state; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'the review rows must be a JSON array'; end if;
  delete from public.store_registry_review where state = p_state;
  insert into public.store_registry_review (state, customer, sales_key, kind, why, conflict, license, legal_name, address,
                                            lat, lng, candidate_id, updated_at)
  select distinct on (x.customer) p_state, x.customer,
         coalesce(nullif(btrim(e.r->>'sales_key'), ''), nullif(public.sales_norm(x.customer), '')),
         nullif(btrim(e.r->>'kind'), ''), nullif(btrim(e.r->>'why'), ''),
         coalesce(lower(e.r->>'conflict') in ('true', 't', '1', 'yes'), false),
         nullif(btrim(e.r->>'license'), ''), nullif(btrim(e.r->>'legal_name'), ''), nullif(btrim(e.r->>'address'), ''),
         case when btrim(e.r->>'lat') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' then btrim(e.r->>'lat')::double precision end,
         case when btrim(e.r->>'lng') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' then btrim(e.r->>'lng')::double precision end,
         case when btrim(e.r->>'candidate_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then btrim(e.r->>'candidate_id')::uuid end,
         now()
    from jsonb_array_elements(p_rows) with ordinality as e(r, i)
   cross join lateral (select btrim(coalesce(case when jsonb_typeof(e.r) = 'object' then e.r->>'customer' end, '')) as customer) x
   where x.customer <> ''
   order by x.customer, e.i;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.store_registry_review_replace(text, jsonb) from public, anon, authenticated;

-- ── 3. licenses and addresses, reduced for comparing ─────────────────────────────────────────────
-- "C10-0000728-LIC", "c10 0000728" and "C100000728" are one license: upper-case letters and digits, a trailing LIC
-- dropped; null when nothing is left
create or replace function public.store_license_key(p text)
returns text language sql immutable set search_path = public as $$
  select nullif(regexp_replace(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]+', '', 'g'), 'LIC$', ''), '');
$$;

-- "280 Higuera St, San Luis Obispo, CA 93401" -> "280 higuera 93401": the house number (at the start of the address or
-- of one of its comma parts), the street's first word (after an N, S, E or W) and the 5-digit zip when there is one.
-- Null without a house number: a Places name like "PostNet, Topanga Canyon Boulevard, Chatsworth, CA, USA" names no
-- premises.
create or replace function public.store_address_key(p text)
returns text language sql immutable set search_path = public as $$
  select case when m.hs is not null then m.hs[1] || ' ' || m.hs[2] || coalesce(' ' || m.zip[1], '') end
    from (select regexp_match(lower(coalesce(p, '')),
                   '(?:^|,)\s*(\d+)[a-z]?(?:-\d+[a-z]?)?\s+(?:(?:n|s|e|w|north|south|east|west|ne|nw|se|sw)\.?\s+)?([a-z0-9]+)') as hs,
                 regexp_match(lower(coalesce(p, '')), '^.+\D(\d{5})(?:-\d{4})?\D*$') as zip) m;
$$;

-- the city of an address written "street, city, ST zip" (the comma part before the state), lower case; null when the
-- address isn't written that way
create or replace function public.store_address_city(p text)
returns text language sql immutable set search_path = public as $$
  select nullif(btrim((regexp_match(lower(coalesce(p, '')),
           '([^,]+),\s*(?:ca|ny|fl|california|new york|florida)\M(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:usa|us|united states))?\s*$'))[1]), '');
$$;

-- ── 4. the stores that may already be the one being added ───────────────────────────────────────
-- Registry rows (on or turned off) of p_state that may be the store named p_name at p_address with license p_license
-- (p_names: other names it goes by, such as the billing name it was added from), only among the rows the caller may
-- see (the dispensaries select policy). Private places and the app's "* ..." placeholders are never stores. Strongest
-- first, at most 8:
--   4 'license'  the same license (one license is one store)
--   3 'address'  the same house number and street, and the same zip (or the same city when a zip is missing)
--   2 'name'     its name, sales key, Pistil name or an alias is one of the given names, by the sales app's tierNorm or
--                the schedule's store key
--   1 'similar'  the same first word of the name and the same city, when no license or premises of its own rules it out
--                (two branches of one chain in one city have their own license and address; a row with neither, like
--                an old one typed by hand, matches only by name, license or address, so it never stands in the way of
--                every new branch of its chain)
create or replace function public.store_registry_match(p_state text, p_name text, p_address text, p_license text,
                                                       p_names text[] default '{}')
returns table(id uuid, name text, address text, license text, legal_name text, state text, active boolean, retail boolean,
              match text, strength integer, reason text)
language sql stable security definer set search_path = public as $$
  with q as (
    select public.is_universal_admin() as ua, public.my_region() as reg, auth.uid() as me,
           public.store_license_key(p_license) as lic, public.store_address_key(p_address) as ak,
           public.store_address_city(p_address) as city,
           nullif(split_part(regexp_replace(public.sales_norm(p_name), '^the ', ''), ' ', 1), '') as brand,
           -- every given name by both rules ('k:' marks the schedule's key)
           coalesce((select array_agg(distinct k) from unnest(array_prepend(p_name, coalesce(p_names, '{}'::text[]))) n
                       cross join lateral unnest(array[public.sales_norm(n), 'k:' || public.schedule_store_key(n)]) k
                      where k not in ('', 'k:')), '{}'::text[]) as keys
  ), r as (
    select d.id, d.name, d.address, d.license, d.legal_name, d.state, d.active, d.retail,
           public.store_license_key(d.license) as lic, public.store_address_key(d.address) as ak,
           public.store_address_city(d.address) as city,
           split_part(regexp_replace(public.sales_norm(d.name), '^the ', ''), ' ', 1) as brand,
           (public.sales_norm(d.name) = any(q.keys) or 'k:' || public.schedule_store_key(d.name) = any(q.keys)) as own_name,
           exists (select 1 from unnest(array_cat(array[d.sales_key, d.pistil_name], coalesce(d.aliases, '{}'::text[]))) x
                    where coalesce(btrim(x), '') <> ''
                      and (public.sales_norm(x) = any(q.keys) or 'k:' || public.schedule_store_key(x) = any(q.keys))) as alias_name
      from public.dispensaries d, q
     where (d.state = p_state or d.state is null) and not d.private and d.name !~ '^\*\s'
       and (q.ua or d.state = q.reg or d.created_by = q.me)
       -- a turned-off row is offered back only when no active store stands in for it: every turned-off CA row on
       -- 2026-11-25 was a retired copy of an active store (same license or a name it answers to), and turning one
       -- back on would put two stores on one door
       and (d.active or not exists (
             select 1 from public.dispensaries a
              where a.id <> d.id and a.active and not a.private and a.state is not distinct from d.state
                and ((public.store_license_key(d.license) is not null
                      and public.store_license_key(a.license) = public.store_license_key(d.license))
                  or exists (select 1 from unnest(array_cat(array[a.name, a.sales_key, a.pistil_name], coalesce(a.aliases, '{}'::text[]))) x
                              where coalesce(btrim(x), '') <> '' and public.sales_norm(x) = public.sales_norm(d.name)))))
  ), m as (
    select r.*,
           coalesce(q.lic is not null and r.lic = q.lic, false) as by_lic,
           coalesce(q.ak is not null and r.ak is not null
             and split_part(r.ak, ' ', 1) = split_part(q.ak, ' ', 1) and split_part(r.ak, ' ', 2) = split_part(q.ak, ' ', 2)
             and case when split_part(r.ak, ' ', 3) <> '' and split_part(q.ak, ' ', 3) <> ''
                      then split_part(r.ak, ' ', 3) = split_part(q.ak, ' ', 3) else r.city = q.city end, false) as by_addr,
           coalesce(length(q.brand) >= 3 and r.brand = q.brand and r.city = q.city
             and not (q.lic is not null and r.lic is not null and r.lic <> q.lic)
             and not (q.ak is not null and r.ak is not null
                      and split_part(r.ak, ' ', 1) || ' ' || split_part(r.ak, ' ', 2) <> split_part(q.ak, ' ', 1) || ' ' || split_part(q.ak, ' ', 2)),
             false) as by_similar
      from r, q
  ), w as (
    select m.*,
           case when m.by_lic then 4 when m.by_addr then 3 when m.own_name or m.alias_name then 2 else 1 end as strength,
           concat_ws('; ', case when m.by_lic then 'same license ' || m.license end,
                           case when m.by_addr then 'same address' end,
                           case when m.own_name then 'same name' when m.alias_name then 'already answers to that name' end,
                           case when m.by_similar and not (m.own_name or m.alias_name) then 'a similar name in the same city' end) as why
      from m
     where m.by_lic or m.by_addr or m.own_name or m.alias_name or m.by_similar
  )
  select w.id, w.name, w.address, w.license, w.legal_name, w.state, w.active, w.retail,
         (array['similar', 'name', 'address', 'license'])[w.strength], w.strength,
         upper(left(w.why, 1)) || substr(w.why, 2)
    from w
   order by w.strength desc, w.active desc, w.name
   limit 8;
$$;
revoke all on function public.store_registry_match(text, text, text, text, text[]) from public, anon;
grant execute on function public.store_registry_match(text, text, text, text, text[]) to authenticated;

-- ── 5. a manager adds a store ───────────────────────────────────────────────────────────────────
-- p: {name, state?, address?, license?, legal_name?, billing?, territory?, force?}. Universal admins, or admins of that
-- state (state defaults to the admin's own). Refused when an active store of that state already has the license (one
-- license is one store; force doesn't change that), when one already answers to the name or the billing name (unless
-- force: the page sends it only after the person has seen those stores and tapped again), and when the state already
-- has a place of exactly that name (the registry allows one). The new store is active, shared and a retail store; its
-- sales key is the billing name's tierNorm and the billing name an alias (when it differs from the name), so the sales
-- app and the Stores page find its sales at once; lat/lng stay empty for the app to geocode it, as for every new store.
-- With a territory it gets its store_plan row. Returns the new store's id.
create or replace function public.store_registry_add(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_state text; v_name text; v_bill text; v_bare text; v_lic text; v_terr text;
        v_force boolean; v_hit public.dispensaries; v_id uuid; v_keys text[];
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'nothing to add'; end if;
  v_state := coalesce(nullif(btrim(p->>'state'), ''), public.admin_region());
  if v_state is null then raise exception 'pick the state the store is in'; end if;
  if v_state not in ('CA','NY','FL') then raise exception 'unknown state %', v_state; end if;
  if not (public.is_universal_admin() or (public.is_admin() and public.admin_region() = v_state)) then
    raise exception 'only a manager of the % stores can add a store here', v_state;
  end if;
  v_name := regexp_replace(btrim(coalesce(p->>'name', '')), '\s+', ' ', 'g');
  if v_name = '' then raise exception 'the store needs a name'; end if;
  if v_name ~ '^\*' then raise exception 'names starting with * are kept for the app''s own placeholders'; end if;
  v_bill := nullif(regexp_replace(btrim(coalesce(p->>'billing', '')), '\s+', ' ', 'g'), '');
  -- the billing name without its leading payment tag ("[At-Risk] Harvest of Chatsworth"): the sales app's BA columns
  -- key an account that way (baRowKey: the tag comes and goes with payment status), so it is the store's sales key
  v_bare := nullif(btrim(regexp_replace(coalesce(v_bill, ''), '^\s*\[[^\]]*\]\s*', '')), '');
  v_lic := nullif(btrim(coalesce(p->>'license', '')), '');
  v_terr := nullif(btrim(coalesce(p->>'territory', '')), '');
  v_force := coalesce(lower(p->>'force') in ('true', 't', '1'), false);
  -- one add or link at a time, so two people can't both find the name free
  perform pg_advisory_xact_lock(hashtext('store_registry'));

  if public.store_license_key(v_lic) is not null then
    select d.* into v_hit from public.dispensaries d
     where d.state = v_state and d.active and public.store_license_key(d.license) = public.store_license_key(v_lic)
     order by d.name limit 1;
    if v_hit.id is not null then
      raise exception '% already has license %. One license is one store, so link the billing name to it instead, or correct its license first.',
        v_hit.name, v_hit.license;
    end if;
  end if;
  -- the sales app's own key (tierNorm) is checked whatever force says: two active stores answering to one name leave
  -- the sales app guessing between them (the state store_registry_link refuses). force only gets past the schedule's
  -- looser key, after the person has seen those stores and tapped again.
  v_keys := array(select k from unnest(array_remove(array[v_name, v_bill, v_bare], null)) n
                   cross join lateral unnest(array[public.sales_norm(n), 'k:' || public.schedule_store_key(n)]) k
                  where k not in ('', 'k:'));
  select d.* into v_hit from public.dispensaries d
   where d.state = v_state and d.active and not d.private and d.name !~ '^\*\s'
     and exists (select 1 from unnest(array_cat(array[d.name, d.sales_key, d.pistil_name], coalesce(d.aliases, '{}'::text[]))) x
                  where coalesce(btrim(x), '') <> '' and public.sales_norm(x) = any(v_keys))
   order by d.name limit 1;
  if v_hit.id is not null then
    raise exception '% already answers to that name, and the sales app can''t tell two stores of one name apart. Use that store, or give this one a name of its own, for example with its city.', v_hit.name;
  end if;
  if not v_force then
    select d.* into v_hit from public.dispensaries d
     where d.state = v_state and d.active and not d.private and d.name !~ '^\*\s'
       and exists (select 1 from unnest(array_cat(array[d.name, d.sales_key, d.pistil_name], coalesce(d.aliases, '{}'::text[]))) x
                    where coalesce(btrim(x), '') <> '' and 'k:' || public.schedule_store_key(x) = any(v_keys))
     order by d.name limit 1;
    if v_hit.id is not null then
      raise exception '% already answers to that name. Use that store, or add this one as a new store on purpose.', v_hit.name;
    end if;
  end if;
  select d.* into v_hit from public.dispensaries d where d.state = v_state and lower(d.name) = lower(v_name) limit 1;
  if v_hit.id is not null then
    if not v_hit.active and not v_hit.private then
      raise exception '% is already in the store list, turned off. Turn it back on instead of adding it again.', v_hit.name;
    end if;
    raise exception 'there is already a place called % in %. Give this store a different name, for example with its city.', v_hit.name, v_state;
  end if;

  insert into public.dispensaries (name, state, address, license, legal_name, active, private, retail, created_by,
                                   sales_key, aliases, lat, lng)
  values (v_name, v_state, nullif(btrim(coalesce(p->>'address', '')), ''), v_lic, nullif(btrim(coalesce(p->>'legal_name', '')), ''),
          true, false, true, v_uid,
          nullif(public.sales_norm(v_bare), ''),            -- null: the sales-key trigger uses the name's
          case when v_bill is not null and lower(v_bill) <> lower(v_name) then array[v_bill] else '{}'::text[] end,
          null, null)
  returning id into v_id;
  if v_terr is not null then
    insert into public.store_plan (dispensary_id, territory, updated_at, updated_by) values (v_id, v_terr, now(), v_uid)
    on conflict (dispensary_id) do update set territory = excluded.territory, updated_at = now(), updated_by = v_uid;
  end if;
  return v_id;
end $$;
revoke all on function public.store_registry_add(jsonb) from public, anon;
grant execute on function public.store_registry_add(jsonb) to authenticated;

-- ── 6. a manager links a billing name to a store already in the registry ────────────────────────
-- Adds p_alias to the store's aliases (the sales app joins a billing name to a store by its name, sales key, Pistil name
-- and aliases, tierNorm'd), for universal admins or admins of the store's state. Nothing changes when one of its names
-- already is that name. Refused when another active store of that state already answers to it: the sales app would be
-- left guessing between the two. Returns {ok, id, name, added, aliases}.
create or replace function public.store_registry_link(p_id uuid, p_alias text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.dispensaries; v_hit public.dispensaries;
        v_alias text := nullif(regexp_replace(btrim(coalesce(p_alias, '')), '\s+', ' ', 'g'), ''); v_key text;
        v_bare text; v_bkey text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if v_alias is null then raise exception 'which name should the store answer to?'; end if;
  v_key := public.sales_norm(v_alias);
  if v_key = '' then raise exception 'that name has no letters or numbers in it'; end if;
  perform pg_advisory_xact_lock(hashtext('store_registry'));
  select d.* into v_row from public.dispensaries d where d.id = p_id;
  if v_row.id is null then raise exception 'that store is no longer in the list'; end if;
  if not (public.is_universal_admin() or (public.is_admin() and public.admin_region() = v_row.state)) then
    raise exception 'only a manager of the % stores can link a billing name to a store', coalesce(v_row.state, 'these');
  end if;
  if v_row.private then raise exception '% is a private place, not a store', v_row.name; end if;
  if exists (select 1 from unnest(array_cat(array[v_row.name, v_row.sales_key, v_row.pistil_name], coalesce(v_row.aliases, '{}'::text[]))) x
              where public.sales_norm(x) = v_key) then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'name', v_row.name, 'added', false, 'aliases', to_jsonb(v_row.aliases));
  end if;
  select d.* into v_hit from public.dispensaries d
   where d.id <> v_row.id and d.active and (d.state is not distinct from v_row.state or d.state is null)
     and exists (select 1 from unnest(array_cat(array[d.name, d.sales_key, d.pistil_name], coalesce(d.aliases, '{}'::text[]))) x
                  where public.sales_norm(x) = v_key)
   order by d.name limit 1;
  if v_hit.id is not null then
    raise exception '% already answers to "%", so linking it to % too would leave the sales app guessing between them. Change % first.',
      v_hit.name, v_alias, v_row.name, v_hit.name;
  end if;
  update public.dispensaries d set aliases = array_append(coalesce(d.aliases, '{}'::text[]), v_alias)
   where d.id = v_row.id returning d.* into v_row;
  -- a billing name with a leading payment tag ("[At-Risk] Cookies on Melrose") also links its untagged spelling, so
  -- the store still answers once the tag is dropped; skipped when the store or another active store already does
  v_bare := nullif(btrim(regexp_replace(v_alias, '^\s*\[[^\]]*\]\s*', '')), '');
  v_bkey := public.sales_norm(v_bare);
  if v_bare is not null and v_bare <> v_alias and coalesce(v_bkey, '') <> ''
     and not exists (select 1 from public.dispensaries d
                      where (d.id = v_row.id or (d.active and (d.state is not distinct from v_row.state or d.state is null)))
                        and exists (select 1 from unnest(array_cat(array[d.name, d.sales_key, d.pistil_name], coalesce(d.aliases, '{}'::text[]))) x
                                     where public.sales_norm(x) = v_bkey)) then
    update public.dispensaries d set aliases = array_append(coalesce(d.aliases, '{}'::text[]), v_bare)
     where d.id = v_row.id returning d.* into v_row;
  end if;
  return jsonb_build_object('ok', true, 'id', v_row.id, 'name', v_row.name, 'added', true, 'aliases', to_jsonb(v_row.aliases));
end $$;
revoke all on function public.store_registry_link(uuid, text) from public, anon;
grant execute on function public.store_registry_link(uuid, text) to authenticated;

notify pgrst, 'reload schema';
