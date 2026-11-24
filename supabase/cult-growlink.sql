-- Cultivation app (cultivation.html): live readings from Growlink, the grows' climate controllers.
-- Written every 5 minutes by ~/ar-automation/cult-growlink-sync.mjs (launchd com.wizardtrees.cult-growlink) through the
-- token-gated cult_growlink_save(); the page reads the three tables (any Wizard Trees login, cult_can_view()).
-- Needs supabase/cultivation.sql first (cult_rooms, cult_can_view(), cult_job_secret). Not pipeline_* tables, so it is
-- applied from Gianni's Mac:  node ~/claude-sql/run-sql-ca.mjs supabase/cult-growlink.sql   Safe to run again.
-- Growlink is only read (the job's allow-list): nothing here can switch equipment. No Growlink ids are stored.

-- a number the job sent, or null (never an error on a value the controller sent oddly)
create or replace function public.cult_gl_num(t text)
returns numeric language sql immutable as $$
  select case when t ~ '^-?[0-9]{1,7}(\.[0-9]{1,8})?$' then t::numeric end
$$;

-- the newest reading of each app room that Growlink has under the same name
create table if not exists public.cult_growlink_now (
  room_id     text primary key references public.cult_rooms(id) on delete cascade,
  growlink    text not null,                    -- the room's name in Growlink
  read_at     timestamptz not null,             -- when the job read it
  reading_at  timestamptz,                      -- the newest sensor reading in it
  lights      jsonb,                            -- Growlink's light schedule {"on":"13:00","off":"01:00","tz":"America/Los_Angeles"}
  setpoints   jsonb,                            -- Growlink's climate set points {"temp":{"day":70,"night":70},"hum":{..},"vpd":{..},"co2":{"day":1500}}
  sensors     jsonb not null default '[]',      -- [{"m":"temp","name","module","v","unit","at","parts":[{"name","module","v","at"}]}]
  alerts      jsonb not null default '[]'       -- Growlink's own active alerts [{"sensor","dir":"above"|"below","limit"}]
);
alter table public.cult_growlink_now enable row level security;
drop policy if exists cult_growlink_now_select on public.cult_growlink_now;
create policy cult_growlink_now_select on public.cult_growlink_now for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_growlink_now from anon, authenticated;

-- each room's averages at each run's newest reading (every 5 minutes), kept 35 days: how long a reading has been off
-- its target, and the last day's line under each reading on the page
create table if not exists public.cult_growlink_log (
  room_id   text not null references public.cult_rooms(id) on delete cascade,
  at        timestamptz not null,
  temp      numeric,      -- °F
  hum       numeric,      -- %
  vpd       numeric,      -- kPa
  co2       numeric,      -- ppm
  light     numeric,      -- the light level sensors' unit (lux at 25th)
  vwc       numeric,      -- substrate water content %
  ec        numeric,      -- substrate EC
  sub_temp  numeric,      -- substrate °F
  primary key (room_id, at)
);
alter table public.cult_growlink_log enable row level security;
drop policy if exists cult_growlink_log_select on public.cult_growlink_log;
create policy cult_growlink_log_select on public.cult_growlink_log for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_growlink_log from anon, authenticated;

-- one row: when the job last ran, and what it could not do
create table if not exists public.cult_growlink_meta (
  id          int primary key default 1 check (id = 1),
  synced_at   timestamptz,                -- the job's last run
  changed_at  timestamptz,                -- the last run that saved readings
  rooms       int,                        -- app rooms saved on that run
  unmatched   text[] not null default '{}',   -- Growlink rooms with no app room of the same name (veg and dry rooms)
  note        text                        -- what went wrong on the last run, if anything
);
alter table public.cult_growlink_meta enable row level security;
drop policy if exists cult_growlink_meta_select on public.cult_growlink_meta;
create policy cult_growlink_meta_select on public.cult_growlink_meta for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_growlink_meta from anon, authenticated;

-- p_rooms: [{growlink, reading_at, lights, setpoints, sensors, alerts, log:{temp, hum, ...}}], one per Growlink room
-- read this run. A Growlink room is saved under the app room of the same name (case and spaces aside); the others are
-- listed in the meta's unmatched. p_note: what went wrong this run. A run that could not read Growlink sends no rooms
-- and a note, so each room keeps its last reading (the page says how old it is) and the page can say why.
create or replace function public.cult_growlink_save(p_token text, p_rooms jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; lg jsonb; ids text[]; rid text; at_ timestamptz; n int := 0; um text[] := '{}'; seen text[] := '{}';
begin
  if not exists (select 1 from public.cult_job_secret
                 where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if jsonb_typeof(p_rooms) is distinct from 'array' then raise exception 'p_rooms must be a list'; end if;
  if jsonb_array_length(p_rooms) > 60 then raise exception 'p_rooms lists more than 60 rooms'; end if;
  if length(p_rooms::text) > 800000 then raise exception 'p_rooms is too big'; end if;
  for r in select x from jsonb_array_elements(p_rooms) x loop
    if jsonb_typeof(r) <> 'object' or coalesce(btrim(r->>'growlink'), '') = '' or length(r->>'growlink') > 80 then
      raise exception 'every room needs its Growlink name';
    end if;
    if jsonb_typeof(coalesce(r->'sensors', '[]')) <> 'array' or jsonb_typeof(coalesce(r->'alerts', '[]')) <> 'array'
       or jsonb_array_length(coalesce(r->'sensors', '[]')) > 300 or jsonb_array_length(coalesce(r->'alerts', '[]')) > 200 then
      raise exception 'sensors and alerts must be lists of at most 300 and 200';
    end if;
    if coalesce(jsonb_typeof(r->'lights'), 'null') not in ('object', 'null')
       or coalesce(jsonb_typeof(r->'setpoints'), 'null') not in ('object', 'null')
       or coalesce(jsonb_typeof(r->'log'), 'null') not in ('object', 'null') then
      raise exception 'lights, setpoints and log must be objects';
    end if;
    if coalesce(r->>'reading_at', '') <> '' and r->>'reading_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$' then
      raise exception 'reading_at must be a time with its zone';
    end if;
    at_ := nullif(r->>'reading_at', '')::timestamptz;
    if at_ > now() + interval '10 minutes' then raise exception 'reading_at is in the future'; end if;
    select array_agg(c.id) into ids from public.cult_rooms c
     where lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(r->>'growlink'), '\s+', ' ', 'g'));
    if coalesce(cardinality(ids), 0) <> 1 then um := um || btrim(r->>'growlink'); continue; end if;
    rid := ids[1];
    if rid = any(seen) then um := um || (btrim(r->>'growlink') || ' (a second room of that name)'); continue; end if;
    seen := seen || rid;
    insert into public.cult_growlink_now as g (room_id, growlink, read_at, reading_at, lights, setpoints, sensors, alerts)
    values (rid, btrim(r->>'growlink'), now(), at_, nullif(r->'lights', 'null'::jsonb), nullif(r->'setpoints', 'null'::jsonb),
            coalesce(r->'sensors', '[]'::jsonb), coalesce(r->'alerts', '[]'::jsonb))
    on conflict (room_id) do update set growlink = excluded.growlink, read_at = excluded.read_at, reading_at = excluded.reading_at,
      lights = excluded.lights, setpoints = excluded.setpoints, sensors = excluded.sensors,
      alerts = case when r ? 'alerts' then excluded.alerts else g.alerts end;   -- no list sent: it couldn't be read
    lg := r->'log';
    if at_ is not null and jsonb_typeof(lg) = 'object' then
      insert into public.cult_growlink_log (room_id, at, temp, hum, vpd, co2, light, vwc, ec, sub_temp)
      values (rid, at_, cult_gl_num(lg->>'temp'), cult_gl_num(lg->>'hum'), cult_gl_num(lg->>'vpd'), cult_gl_num(lg->>'co2'),
              cult_gl_num(lg->>'light'), cult_gl_num(lg->>'vwc'), cult_gl_num(lg->>'ec'), cult_gl_num(lg->>'sub_temp'))
      on conflict (room_id, at) do nothing;
    end if;
    delete from public.cult_growlink_log l where l.room_id = rid and l.at < now() - interval '35 days';
    n := n + 1;
  end loop;
  insert into public.cult_growlink_meta as m (id, synced_at, changed_at, rooms, unmatched, note)
  values (1, now(), case when n > 0 then now() end, n, um, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  on conflict (id) do update set synced_at = now(), changed_at = coalesce(excluded.changed_at, m.changed_at),
    rooms = excluded.rooms, unmatched = excluded.unmatched, note = excluded.note;
  return jsonb_build_object('ok', true, 'v', 1, 'rooms', n, 'unmatched', to_jsonb(um));
end $$;
revoke all on function public.cult_growlink_save(text, jsonb, text) from public;
grant execute on function public.cult_growlink_save(text, jsonb, text) to anon, authenticated;
