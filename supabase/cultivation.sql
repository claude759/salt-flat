-- Cultivation app (cultivation.html): the flower rooms of the four grows (23rd St, 25th St, 15th St, Olympic), each
-- room's zones (strain and lights per table), the task calendar check-offs, and what Metrc says is in each room.
--
-- Who:  any signed-in Wizard Trees account (is_staff()) may open the page and change anything on it (Gianni,
--       2026-11-24: "My app doesn't really need login stuff yet"). The one Google sign-in stays: the page and this repo
--       are public, and the sign-in is what keeps the room maps and Metrc's numbers private. cult_can_edit() and
--       cult_can_work() stay as the place roles come back; cult_editors and cult_crew are kept, unused.
-- Metrc: a job on Gianni's Mac (~/ar-automation/cult-metrc-sync.mjs, every 3 hours, read-only on Metrc) sends the
--       flowering plants of each license, one row per room (Metrc location), strain and flowering day, plus the
--       plants harvested or destroyed in the last 120 days, through cult_metrc_save() (token-gated; the token hash
--       is seeded out-of-band, never committed). Each send replaces that license's rows as a whole.
-- Applied from Gianni's Mac: node ~/claude-sql/run-sql-ca.mjs supabase/cultivation.sql (not the Pipeline deploy:
-- these are not pipeline_* tables). Safe to run again.

-- ---------------------------------------------------------------- access
create table if not exists public.cult_editors (
  email     text primary key check (email = lower(email) and email like '%@wizardtrees.com'),
  added_at  timestamptz not null default now()
);
alter table public.cult_editors enable row level security;   -- no policies: read only through cult_can_edit()
revoke all on table public.cult_editors from public, anon, authenticated;

create or replace function public.cult_jwt_email()
returns text language sql stable set search_path = '' as $$
  select lower(coalesce(coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                                 nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'email', ''));
$$;
revoke all on function public.cult_jwt_email() from public, anon;
grant execute on function public.cult_jwt_email() to authenticated;

create or replace function public.cult_can_view()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_staff();
$$;
revoke all on function public.cult_can_view() from public, anon;
grant execute on function public.cult_can_view() to authenticated;

-- no roles yet (Gianni 2026-11-24): everyone who can open the page can change it. Was: universal admins + cult_editors.
create or replace function public.cult_can_edit()
returns boolean language sql stable security definer set search_path = public as $$
  select public.cult_can_view();
$$;
revoke all on function public.cult_can_edit() from public, anon;
grant execute on function public.cult_can_edit() to authenticated;

-- the crew (growers) list from step 2, unused since roles were dropped the same day (kept so roles can come back).
create table if not exists public.cult_crew (
  email     text primary key check (email = lower(email) and email like '%@wizardtrees.com'),
  added_at  timestamptz not null default now(),
  added_by  text
);
alter table public.cult_crew enable row level security;   -- no policies: read through cult_can_work() and cult_crew_list()
revoke all on table public.cult_crew from public, anon, authenticated;

create or replace function public.cult_can_work()
returns boolean language sql stable security definer set search_path = public as $$
  select public.cult_can_view();
$$;
revoke all on function public.cult_can_work() from public, anon;
grant execute on function public.cult_can_work() to authenticated;

-- ---------------------------------------------------------------- rooms
-- One row per flower room. id: site letter + room (S1 = 23rd Room 1, F2 = 25th Room 2, IA = 15th Room A,
-- IC = 15th 6 lighter, O3 = Olympic Room 3). license + metrc_location tie the room to Metrc's plants.
create table if not exists public.cult_rooms (
  id              text primary key check (id ~ '^[A-Z][A-Z0-9]{1,3}$'),
  site            text not null check (site in ('S', 'F', 'I', 'O')),
  name            text not null,                 -- what the crew calls it: 23rd Room 1
  sort            int not null default 0,
  license         text not null,                 -- the cultivation license (CCL25-0000358 ...)
  metrc_location  text,                          -- Metrc's location name for this room (Room 1, Flower 1, A ...)
  harvest_day     int not null default 63 check (harvest_day between 30 and 120),   -- day of flower the room is cut
  flip_date       date,                          -- typed in the app; null = Metrc's first flowering day of the plants in the room
  env             jsonb not null default '[]',   -- weekly targets [{week, temp, hum, vpd, co2, light}]
  tasks           jsonb not null default '[]',   -- the task calendar [{day, kind, text}], days counted from the flip (day 1)
  layout          jsonb,                         -- the room map traced from the premises/lighting diagram (feet)
  layout_source   text,                          -- which diagram, which page, and how it was drawn
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by      text
);
alter table public.cult_rooms add column if not exists notes text check (length(notes) <= 2000);   -- room notes (editors)
alter table public.cult_rooms enable row level security;
drop policy if exists cult_rooms_select on public.cult_rooms;
create policy cult_rooms_select on public.cult_rooms for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_rooms from anon, authenticated;   -- writes go through cult_room_set()

-- Zones: one row per strain on a table (a zone can hold two or three strains). zone = the table number on the room
-- map (1 = the first table on the map). lights: the lights over that strain (halves allowed: 4.5).
create table if not exists public.cult_zones (
  room_id     text not null references public.cult_rooms(id) on delete cascade,
  zone        int not null check (zone between 1 and 20),
  slot        int not null default 1 check (slot between 1 and 9),
  strain      text check (length(strain) <= 80),
  lights      numeric check (lights >= 0 and lights <= 100),
  pack        text check (length(pack) <= 40),   -- what the strain is grown for, as the crew writes it: mylars, jar
  metrc_strain text check (length(metrc_strain) <= 80),   -- the strain Metrc records these plants under, when it isn't this one
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (room_id, zone, slot)
);
-- a table made before metrc_strain (Gianni 2026-11-24: Metrc's "Cream" in 25th Room 1 is zone 1's Pool Party and King Tide 23)
alter table public.cult_zones add column if not exists metrc_strain text check (length(metrc_strain) <= 80);
alter table public.cult_zones enable row level security;
drop policy if exists cult_zones_select on public.cult_zones;
create policy cult_zones_select on public.cult_zones for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_zones from anon, authenticated;   -- writes go through cult_zones_set()

-- Task check-offs: one row per task done, for one cycle of a room (cycle = that cycle's flip date).
create table if not exists public.cult_task_done (
  room_id   text not null references public.cult_rooms(id) on delete cascade,
  cycle     date not null,
  task_key  text not null check (length(task_key) between 1 and 200),
  done_at   timestamptz not null default now(),
  done_by   text,
  primary key (room_id, cycle, task_key)
);
-- step 2 (crew work): a task can be done, skipped, or left open with a note or a new date (moved_to)
alter table public.cult_task_done add column if not exists status text not null default 'done';
alter table public.cult_task_done drop constraint if exists cult_task_done_status_check;
alter table public.cult_task_done add constraint cult_task_done_status_check check (status in ('open', 'done', 'skipped'));
alter table public.cult_task_done add column if not exists note text check (length(note) <= 500);
alter table public.cult_task_done add column if not exists moved_to date;
alter table public.cult_task_done enable row level security;
drop policy if exists cult_task_done_select on public.cult_task_done;
create policy cult_task_done_select on public.cult_task_done for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_task_done from anon, authenticated;

-- Strain codes: 23rd, 15th and Olympic name strains in Metrc by number (2504). One name per license and code.
-- source: 'sheet' (the GENETICS 3.0 tab of the cultivation sheet, the crew's own code list), 'inferred' (matched
-- from a room's strains against Metrc), 'confirmed' (named or renamed by an editor in the app).
create table if not exists public.cult_strain_codes (
  license     text not null,
  code        text not null check (code ~ '^[0-9]{3,6}$'),
  name        text not null check (length(name) between 1 and 80),
  source      text not null default 'sheet' check (source in ('sheet', 'inferred', 'confirmed')),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (license, code)
);
alter table public.cult_strain_codes enable row level security;
drop policy if exists cult_strain_codes_select on public.cult_strain_codes;
create policy cult_strain_codes_select on public.cult_strain_codes for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_strain_codes from anon, authenticated;

-- ---------------------------------------------------------------- Metrc (written by the Mac job only)
-- state 'flowering': plants in flower now, day = their FloweringDate; 'harvested' / 'destroyed': plants that left
-- in the last 120 days, day = HarvestedDate / DestroyedDate; 'left': those same plants again, day = the FloweringDate
-- they had (so the page can tell which crop a harvested plant belonged to). Mother rooms show up as flowering too
-- (Metrc tracks mothers as flowering plants); the page shows only the rooms in cult_rooms.
create table if not exists public.cult_metrc_plants (
  license   text not null,
  location  text not null,
  strain    text not null,
  state     text not null check (state in ('flowering', 'harvested', 'destroyed', 'left')),
  day       date not null,
  plants    int not null check (plants > 0),
  primary key (license, location, strain, state, day)
);
alter table public.cult_metrc_plants drop constraint if exists cult_metrc_plants_state_check;   -- a table made before 'left'
alter table public.cult_metrc_plants add constraint cult_metrc_plants_state_check check (state in ('flowering', 'harvested', 'destroyed', 'left'));
alter table public.cult_metrc_plants enable row level security;
drop policy if exists cult_metrc_plants_select on public.cult_metrc_plants;
create policy cult_metrc_plants_select on public.cult_metrc_plants for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_metrc_plants from anon, authenticated;

create table if not exists public.cult_metrc_meta (
  license       text primary key,
  synced_at     timestamptz,     -- the job's last run that read this license
  changed_at    timestamptz,     -- the last run that changed its rows
  covered_from  timestamptz,     -- Metrc's plants are read for every LastModified from here ...
  covered_to    timestamptz,     -- ... to here
  plants        int,             -- flowering plants now
  note          text             -- what went wrong on the last run, if anything
);
alter table public.cult_metrc_meta enable row level security;
drop policy if exists cult_metrc_meta_select on public.cult_metrc_meta;
create policy cult_metrc_meta_select on public.cult_metrc_meta for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_metrc_meta from anon, authenticated;

create table if not exists public.cult_job_secret (
  id          int primary key default 1 check (id = 1),
  token_hash  text not null
);
alter table public.cult_job_secret enable row level security;   -- no policies: nobody reads it
revoke all on table public.cult_job_secret from public, anon, authenticated;

-- p_rows: [{license, location, strain, state, day, plants}] for the licenses in p_meta (the whole set for each).
-- p_meta: [{license, covered_from, covered_to, note}] one per license read this run (a license not listed is left
-- alone, so a run that could not read one license never wipes it).
create or replace function public.cult_metrc_save(p_token text, p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_del int := 0; n_ins int := 0; lic text;
begin
  if not exists (select 1 from public.cult_job_secret
                 where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if jsonb_typeof(p_meta) is distinct from 'array' or jsonb_array_length(p_meta) < 1 then
    raise exception 'p_meta must list the licenses read';
  end if;
  if exists (select 1 from jsonb_array_elements(p_meta) m where coalesce(m->>'license', '') !~ '^[A-Z0-9]{2,6}-[0-9A-Z-]{5,24}$') then
    raise exception 'every p_meta entry needs a license';
  end if;
  if (select count(*) from jsonb_array_elements(p_meta)) <> (select count(distinct m->>'license') from jsonb_array_elements(p_meta) m) then
    raise exception 'p_meta lists a license twice';
  end if;
  if exists (select 1 from jsonb_array_elements(p_meta) m
             where (m->>'covered_from')::timestamptz > (m->>'covered_to')::timestamptz) then
    raise exception 'covered_from is after covered_to';
  end if;
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be a list'; end if;
    if exists (select 1 from jsonb_array_elements(p_rows) x
               where not exists (select 1 from jsonb_array_elements(p_meta) m where m->>'license' = x->>'license')
                  or coalesce(btrim(x->>'location'), '') = '' or length(x->>'location') > 80
                  or coalesce(btrim(x->>'strain'), '') = '' or length(x->>'strain') > 80
                  or coalesce(x->>'state', '') not in ('flowering', 'harvested', 'destroyed', 'left')
                  or coalesce(x->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$'
                  or coalesce(x->>'plants', '') !~ '^[1-9][0-9]{0,5}$') then
      raise exception 'every row needs a license read this run, a location, a strain, a state, a day and plants';
    end if;
  end if;
  for lic in select m->>'license' from jsonb_array_elements(p_meta) m loop
    delete from public.cult_metrc_plants p where p.license = lic;
    get diagnostics n_del = row_count;
    insert into public.cult_metrc_plants (license, location, strain, state, day, plants)
    select x->>'license', btrim(x->>'location'), btrim(x->>'strain'), x->>'state', (x->>'day')::date, sum((x->>'plants')::int)
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
     where x->>'license' = lic
     group by 1, 2, 3, 4, 5;
    get diagnostics n_ins = row_count;
    insert into public.cult_metrc_meta as c (license, synced_at, changed_at, covered_from, covered_to, plants, note)
    select lic, now(), now(), (m->>'covered_from')::timestamptz, (m->>'covered_to')::timestamptz,
           (select coalesce(sum(p.plants), 0) from public.cult_metrc_plants p where p.license = lic and p.state = 'flowering'),
           nullif(left(coalesce(m->>'note', ''), 500), '')
      from jsonb_array_elements(p_meta) m where m->>'license' = lic
    on conflict (license) do update set synced_at = now(), changed_at = now(),
      covered_from = coalesce(excluded.covered_from, c.covered_from), covered_to = coalesce(excluded.covered_to, c.covered_to),
      plants = excluded.plants, note = excluded.note;
  end loop;
  return jsonb_build_object('ok', true, 'v', 1, 'rows', (select count(*) from public.cult_metrc_plants));
end $$;
revoke all on function public.cult_metrc_save(text, jsonb, jsonb) from public;
grant execute on function public.cult_metrc_save(text, jsonb, jsonb) to anon, authenticated;

-- a run with nothing new: just say when the job last looked
create or replace function public.cult_metrc_touch(p_token text, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.cult_job_secret
                 where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if jsonb_typeof(p_meta) is distinct from 'array' then raise exception 'p_meta must be a list'; end if;
  update public.cult_metrc_meta c set synced_at = now(),
         covered_from = coalesce((m->>'covered_from')::timestamptz, c.covered_from),
         covered_to = coalesce((m->>'covered_to')::timestamptz, c.covered_to),
         note = nullif(left(coalesce(m->>'note', ''), 500), '')
    from jsonb_array_elements(p_meta) m where c.license = m->>'license';
  return jsonb_build_object('ok', true, 'v', 1);
end $$;
revoke all on function public.cult_metrc_touch(text, jsonb) from public;
grant execute on function public.cult_metrc_touch(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------- edits from the page (editors only)
-- What the page can say about the caller: {view, work (crew), edit, email}
create or replace function public.cult_whoami()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('view', public.cult_can_view(), 'work', public.cult_can_work(), 'edit', public.cult_can_edit(), 'email', public.cult_jwt_email());
$$;
revoke all on function public.cult_whoami() from public, anon;
grant execute on function public.cult_whoami() to authenticated;

-- one room's flip date (null = back to Metrc's), harvest day, or map. Only the keys present in p_set change.
create or replace function public.cult_room_set(p_room text, p_set jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.cult_rooms;
begin
  if not public.cult_can_edit() then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_set) is distinct from 'object' then raise exception 'p_set must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_set) k where k not in ('flip_date', 'harvest_day', 'layout', 'notes')) then
    raise exception 'only flip_date, harvest_day, layout and notes can be changed here';
  end if;
  if p_set ? 'notes' and (jsonb_typeof(p_set->'notes') not in ('string', 'null') or length(coalesce(p_set->>'notes', '')) > 2000) then
    raise exception 'notes must be text of up to 2000 characters';
  end if;
  if p_set ? 'flip_date' and jsonb_typeof(p_set->'flip_date') <> 'null'
     and coalesce(p_set->>'flip_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'flip_date must be a date'; end if;
  if p_set ? 'harvest_day' and coalesce(p_set->>'harvest_day', '') !~ '^\d{2,3}$' then raise exception 'harvest_day must be a number'; end if;
  if p_set ? 'layout' and jsonb_typeof(p_set->'layout') not in ('object', 'null') then raise exception 'layout must be an object'; end if;
  if p_set ? 'layout' and octet_length((p_set->'layout')::text) > 200000 then raise exception 'layout is too big'; end if;
  if jsonb_typeof(p_set->'layout') = 'object' and jsonb_typeof(p_set->'layout'->'tables') is distinct from 'array' then
    raise exception 'layout needs a list of tables';
  end if;
  -- Arrange zones: each table's zone is a number (0 = none), and a zone sits on one table
  if jsonb_typeof(p_set->'layout') = 'object' then
    if exists (select 1 from jsonb_array_elements(p_set->'layout'->'tables') t
               where jsonb_typeof(t) = 'object' and t ? 'zone' and coalesce(t->>'zone', '') !~ '^[0-9]{1,2}$') then
      raise exception 'a table''s zone must be a number (0 for none)';
    end if;
    if exists (select 1 from jsonb_array_elements(p_set->'layout'->'tables') t
               where jsonb_typeof(t) = 'object' and t ? 'zone' and (t->>'zone')::int > 0
               group by (t->>'zone')::int having count(*) > 1) then
      raise exception 'a zone is on two tables';
    end if;
  end if;
  update public.cult_rooms set
    flip_date = case when p_set ? 'flip_date' then (p_set->>'flip_date')::date else flip_date end,
    harvest_day = case when p_set ? 'harvest_day' then (p_set->>'harvest_day')::int else harvest_day end,
    layout = case when p_set ? 'layout' then p_set->'layout' else layout end,
    notes = case when p_set ? 'notes' then nullif(btrim(coalesce(p_set->>'notes', '')), '') else notes end,
    updated_at = now(), updated_by = public.cult_jwt_email()
   where id = p_room returning * into r;
  if r.id is null then raise exception 'no such room'; end if;
  return to_jsonb(r) - 'layout';
end $$;
revoke all on function public.cult_room_set(text, jsonb) from public, anon;
grant execute on function public.cult_room_set(text, jsonb) to authenticated;

-- a room's zones become exactly p_zones: [{zone, slot, strain, lights, pack, metrc}] (metrc: the strain Metrc records
-- the plants under, when it isn't the zone's strain)
create or replace function public.cult_zones_set(p_room text, p_zones jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.cult_can_edit() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.cult_rooms where id = p_room) then raise exception 'no such room'; end if;
  if jsonb_typeof(p_zones) is distinct from 'array' then raise exception 'p_zones must be a list'; end if;
  if exists (select 1 from jsonb_array_elements(p_zones) z
             where coalesce(z->>'zone', '') !~ '^[1-9][0-9]?$' or coalesce(z->>'slot', '1') !~ '^[1-9]$'
                or length(coalesce(z->>'strain', '')) > 80 or length(coalesce(z->>'pack', '')) > 40 or length(coalesce(z->>'metrc', '')) > 80
                or (z ? 'lights' and jsonb_typeof(z->'lights') not in ('number', 'null'))) then
    raise exception 'each zone needs a zone number, a slot, and a short strain name';
  end if;
  delete from public.cult_zones where room_id = p_room;
  insert into public.cult_zones (room_id, zone, slot, strain, lights, pack, metrc_strain, updated_at, updated_by)
  select p_room, (z->>'zone')::int, coalesce((z->>'slot')::int, 1), nullif(btrim(coalesce(z->>'strain', '')), ''),
         (z->>'lights')::numeric, nullif(btrim(coalesce(z->>'pack', '')), ''), nullif(btrim(coalesce(z->>'metrc', '')), ''),
         now(), public.cult_jwt_email()
    from jsonb_array_elements(p_zones) z;
  return jsonb_build_object('ok', true, 'zones', (select count(*) from public.cult_zones where room_id = p_room));
end $$;
revoke all on function public.cult_zones_set(text, jsonb) from public, anon;
grant execute on function public.cult_zones_set(text, jsonb) to authenticated;

-- tick (p_done true) or untick a task of one cycle
create or replace function public.cult_task_mark(p_room text, p_cycle date, p_task text, p_done boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.cult_can_work() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.cult_rooms where id = p_room) then raise exception 'no such room'; end if;
  if p_cycle is null or coalesce(length(p_task), 0) not between 1 and 200 then raise exception 'cycle and task needed'; end if;
  if p_done then
    insert into public.cult_task_done as d (room_id, cycle, task_key, status, done_at, done_by)
    values (p_room, p_cycle, p_task, 'done', now(), public.cult_jwt_email())
    on conflict (room_id, cycle, task_key) do update set status = 'done', done_at = now(), done_by = excluded.done_by
      where d.status <> 'done';
  else
    -- unticked: a note or a new date stays (the task is open again); nothing else to keep: the row goes
    update public.cult_task_done set status = 'open', done_at = now(), done_by = public.cult_jwt_email()
     where room_id = p_room and cycle = p_cycle and task_key = p_task and (note is not null or moved_to is not null);
    delete from public.cult_task_done
     where room_id = p_room and cycle = p_cycle and task_key = p_task and note is null and moved_to is null;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.cult_task_mark(text, date, text, boolean) from public, anon;
grant execute on function public.cult_task_mark(text, date, text, boolean) to authenticated;

-- name a strain code (confirmed by the person who saves it)
create or replace function public.cult_strain_code_set(p_license text, p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.cult_can_edit() then raise exception 'not allowed'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{3,6}$' or coalesce(btrim(p_name), '') = '' or length(p_name) > 80
     or coalesce(p_license, '') !~ '^[A-Z0-9]{2,6}-[0-9A-Z-]{5,24}$' then raise exception 'license, code and name needed'; end if;
  insert into public.cult_strain_codes as s (license, code, name, source, updated_at, updated_by)
  values (p_license, p_code, btrim(p_name), 'confirmed', now(), public.cult_jwt_email())
  on conflict (license, code) do update set name = excluded.name, source = 'confirmed', updated_at = now(),
    updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.cult_strain_code_set(text, text, text) from public, anon;
grant execute on function public.cult_strain_code_set(text, text, text) to authenticated;

-- ---------------------------------------------------------------- step 2: crew work (Gianni 2026-11-24)
-- a calendar task of one cycle: status (open / done / skipped), a note, a new date. Only the keys present in p_set
-- change; a row left open with no note and no new date goes.
create or replace function public.cult_task_set(p_room text, p_cycle date, p_task text, p_set jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text := public.cult_jwt_email();
begin
  if not public.cult_can_work() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.cult_rooms where id = p_room) then raise exception 'no such room'; end if;
  if p_cycle is null or coalesce(length(p_task), 0) not between 1 and 200 then raise exception 'cycle and task needed'; end if;
  if jsonb_typeof(p_set) is distinct from 'object' then raise exception 'p_set must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_set) k where k not in ('status', 'note', 'moved_to')) then raise exception 'only status, note and moved_to'; end if;
  if p_set ? 'status' and coalesce(p_set->>'status', '') not in ('open', 'done', 'skipped') then raise exception 'status must be open, done or skipped'; end if;
  if p_set ? 'note' and (jsonb_typeof(p_set->'note') not in ('string', 'null') or length(coalesce(p_set->>'note', '')) > 500) then raise exception 'a note is up to 500 characters'; end if;
  if p_set ? 'moved_to' and jsonb_typeof(p_set->'moved_to') <> 'null' and coalesce(p_set->>'moved_to', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'moved_to must be a date'; end if;
  insert into public.cult_task_done as d (room_id, cycle, task_key, status, note, moved_to, done_at, done_by)
  values (p_room, p_cycle, p_task, coalesce(p_set->>'status', 'open'), nullif(btrim(coalesce(p_set->>'note', '')), ''),
          (p_set->>'moved_to')::date, now(), who)
  on conflict (room_id, cycle, task_key) do update set
    status = case when p_set ? 'status' then excluded.status else d.status end,
    note = case when p_set ? 'note' then excluded.note else d.note end,
    moved_to = case when p_set ? 'moved_to' then excluded.moved_to else d.moved_to end,
    done_at = now(), done_by = who;
  delete from public.cult_task_done
   where room_id = p_room and cycle = p_cycle and task_key = p_task and status = 'open' and note is null and moved_to is null;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.cult_task_set(text, date, text, jsonb) from public, anon;
grant execute on function public.cult_task_set(text, date, text, jsonb) to authenticated;

-- one-off tasks of a room (not on its calendar): added and ticked by the crew; deleted by whoever added them, or editors
create table if not exists public.cult_room_tasks (
  id          bigint generated always as identity primary key,
  room_id     text not null references public.cult_rooms(id) on delete cascade,
  due         date not null,
  kind        text not null default 'ACTION' check (kind ~ '^[A-Z]{2,12}$'),
  text        text not null check (length(text) between 1 and 300),
  status      text not null default 'open' check (status in ('open', 'done', 'skipped')),
  note        text check (length(note) <= 500),
  created_at  timestamptz not null default now(),
  created_by  text,
  done_at     timestamptz,
  done_by     text,
  deleted_at  timestamptz,
  deleted_by  text
);
create index if not exists cult_room_tasks_room on public.cult_room_tasks (room_id, due);
alter table public.cult_room_tasks enable row level security;
drop policy if exists cult_room_tasks_select on public.cult_room_tasks;
create policy cult_room_tasks_select on public.cult_room_tasks for select to authenticated using (public.cult_can_view() and deleted_at is null);
revoke insert, update, delete on table public.cult_room_tasks from anon, authenticated;

create or replace function public.cult_room_task_add(p_room text, p_due date, p_kind text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.cult_can_work() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.cult_rooms where id = p_room) then raise exception 'no such room'; end if;
  if p_due is null or p_due < current_date - 400 or p_due > current_date + 400 then raise exception 'a due date within a year'; end if;
  if coalesce(p_kind, '') !~ '^[A-Z]{2,12}$' then raise exception 'kind must be a word in capitals'; end if;
  if coalesce(btrim(p_text), '') = '' or length(p_text) > 300 then raise exception 'say what the task is (up to 300 characters)'; end if;
  insert into public.cult_room_tasks (room_id, due, kind, text, created_by) values (p_room, p_due, p_kind, btrim(p_text), public.cult_jwt_email())
  returning id into nid;
  return jsonb_build_object('ok', true, 'id', nid);
end $$;
revoke all on function public.cult_room_task_add(text, date, text, text) from public, anon;
grant execute on function public.cult_room_task_add(text, date, text, text) to authenticated;

-- status (open / done / skipped), a note, a new due date; delete: true removes it (whoever added it, or an editor)
create or replace function public.cult_room_task_set(p_id bigint, p_set jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.cult_room_tasks; who text := public.cult_jwt_email();
begin
  if not public.cult_can_work() then raise exception 'not allowed'; end if;
  select * into t from public.cult_room_tasks where id = p_id and deleted_at is null;
  if t.id is null then raise exception 'no such task'; end if;
  if jsonb_typeof(p_set) is distinct from 'object' then raise exception 'p_set must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_set) k where k not in ('status', 'note', 'due', 'delete')) then raise exception 'only status, note, due and delete'; end if;
  if p_set ? 'delete' then
    if not (public.cult_can_edit() or t.created_by = who) then raise exception 'only whoever added it, or an editor, can delete it'; end if;
    update public.cult_room_tasks set deleted_at = now(), deleted_by = who where id = p_id;
    return jsonb_build_object('ok', true);
  end if;
  if p_set ? 'status' and coalesce(p_set->>'status', '') not in ('open', 'done', 'skipped') then raise exception 'status must be open, done or skipped'; end if;
  if p_set ? 'note' and (jsonb_typeof(p_set->'note') not in ('string', 'null') or length(coalesce(p_set->>'note', '')) > 500) then raise exception 'a note is up to 500 characters'; end if;
  if p_set ? 'due' and coalesce(p_set->>'due', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'due must be a date'; end if;
  update public.cult_room_tasks set
    status = case when p_set ? 'status' then p_set->>'status' else status end,
    done_at = case when p_set ? 'status' then case when p_set->>'status' = 'open' then null else now() end else done_at end,
    done_by = case when p_set ? 'status' then case when p_set->>'status' = 'open' then null else who end else done_by end,
    note = case when p_set ? 'note' then nullif(btrim(coalesce(p_set->>'note', '')), '') else note end,
    due = case when p_set ? 'due' then (p_set->>'due')::date else due end
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.cult_room_task_set(bigint, jsonb) from public, anon;
grant execute on function public.cult_room_task_set(bigint, jsonb) to authenticated;

-- the runoff log: what went in (cup ml, feed pH, EC) and what came out (tray ml, runoff pH, EC) for a zone on a day;
-- runoff % = tray / cup. The crew log it; editors (or whoever logged it, within a day) remove a row.
create table if not exists public.cult_runoff (
  id          bigint generated always as identity primary key,
  room_id     text not null references public.cult_rooms(id) on delete cascade,
  day         date not null,
  zone        int check (zone between 1 and 20),
  cup_ml      numeric check (cup_ml > 0 and cup_ml <= 100000),
  feed_ph     numeric check (feed_ph between 0 and 14),
  feed_ec     numeric check (feed_ec between 0 and 30),
  tray_ml     numeric check (tray_ml >= 0 and tray_ml <= 100000),
  runoff_ph   numeric check (runoff_ph between 0 and 14),
  runoff_ec   numeric check (runoff_ec between 0 and 30),
  runoff_pct  numeric generated always as (case when cup_ml > 0 and tray_ml is not null then round(tray_ml / cup_ml * 100, 1) end) stored,
  note        text check (length(note) <= 500),
  created_at  timestamptz not null default now(),
  created_by  text,
  deleted_at  timestamptz,
  deleted_by  text
);
create index if not exists cult_runoff_room on public.cult_runoff (room_id, day);
alter table public.cult_runoff enable row level security;
drop policy if exists cult_runoff_select on public.cult_runoff;
create policy cult_runoff_select on public.cult_runoff for select to authenticated using (public.cult_can_view() and deleted_at is null);
revoke insert, update, delete on table public.cult_runoff from anon, authenticated;

create or replace function public.cult_runoff_add(p_room text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare nid bigint; la date := (now() at time zone 'America/Los_Angeles')::date; k text;
begin
  if not public.cult_can_work() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.cult_rooms where id = p_room) then raise exception 'no such room'; end if;
  if jsonb_typeof(p_row) is distinct from 'object' then raise exception 'p_row must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_row) x where x not in ('day', 'zone', 'cup_ml', 'feed_ph', 'feed_ec', 'tray_ml', 'runoff_ph', 'runoff_ec', 'note')) then
    raise exception 'unknown field';
  end if;
  if coalesce(p_row->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'day must be a date'; end if;
  if (p_row->>'day')::date > la then raise exception 'no future days'; end if;
  if (p_row->>'day')::date < la - 400 then raise exception 'too far back'; end if;
  foreach k in array array['zone', 'cup_ml', 'feed_ph', 'feed_ec', 'tray_ml', 'runoff_ph', 'runoff_ec'] loop
    if p_row ? k and jsonb_typeof(p_row->k) not in ('number', 'null') then raise exception '% must be a number', k; end if;
  end loop;
  if (p_row->>'zone') is not null and (p_row->>'zone') !~ '^[0-9]{1,2}$' then raise exception 'zone must be a whole number'; end if;
  if coalesce(p_row->>'cup_ml', p_row->>'feed_ph', p_row->>'feed_ec', p_row->>'tray_ml', p_row->>'runoff_ph', p_row->>'runoff_ec') is null then
    raise exception 'log at least one reading';
  end if;
  if p_row ? 'note' and (jsonb_typeof(p_row->'note') not in ('string', 'null') or length(coalesce(p_row->>'note', '')) > 500) then raise exception 'a note is up to 500 characters'; end if;
  insert into public.cult_runoff (room_id, day, zone, cup_ml, feed_ph, feed_ec, tray_ml, runoff_ph, runoff_ec, note, created_by)
  values (p_room, (p_row->>'day')::date, (p_row->>'zone')::int, (p_row->>'cup_ml')::numeric, (p_row->>'feed_ph')::numeric,
          (p_row->>'feed_ec')::numeric, (p_row->>'tray_ml')::numeric, (p_row->>'runoff_ph')::numeric, (p_row->>'runoff_ec')::numeric,
          nullif(btrim(coalesce(p_row->>'note', '')), ''), public.cult_jwt_email())
  returning id into nid;
  return jsonb_build_object('ok', true, 'id', nid);
end $$;
revoke all on function public.cult_runoff_add(text, jsonb) from public, anon;
grant execute on function public.cult_runoff_add(text, jsonb) to authenticated;

create or replace function public.cult_runoff_delete(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.cult_runoff; who text := public.cult_jwt_email();
begin
  if not public.cult_can_work() then raise exception 'not allowed'; end if;
  select * into r from public.cult_runoff where id = p_id and deleted_at is null;
  if r.id is null then raise exception 'no such row'; end if;
  if not (public.cult_can_edit() or (r.created_by = who and r.created_at > now() - interval '1 day')) then
    raise exception 'only an editor, or whoever logged it within a day, can remove it';
  end if;
  update public.cult_runoff set deleted_at = now(), deleted_by = who where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.cult_runoff_delete(bigint) from public, anon;
grant execute on function public.cult_runoff_delete(bigint) to authenticated;

-- The Access list (the crew and the editors, picked from the Wizard Trees accounts) was dropped 2026-11-24 with the
-- roles: anyone who can open the page can do everything on it (see cult_can_edit above).
drop function if exists public.cult_crew_list();
drop function if exists public.cult_crew_set(text, boolean);
