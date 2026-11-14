-- Production Pipeline page (pipeline.html), Batches view: the Metrc harvest behind each batch, for our own printable
-- harvest report (Metrc's API has no harvest PDF, so the page prints its own card from these rows).
-- A job on Gianni's Mac (~/ar-automation/pipeline-harvests-sync.mjs, every 3 hours) reads, read-only:
--   - the harvests of each cultivation license (GET /harvests/v2/active and /inactive, walked in 24-hour LastModified
--     windows since its last run): one row per harvest, named <room>-<strain code>-<MMDDYYYY> (F2-2550-09282026);
--   - which harvest(s) each batch came from: a batch's Metrc package (its tag, the sheet's METRC UID) lists its source
--     harvests by name (SourceHarvestNames, kept through repackaging; a blended batch lists several).
-- It sends them through pipeline_harvests_save(), gated by the same job token as the lab results
-- (pipeline_batch_labs_secret, from pipeline-batch-labs.sql; the token hash is seeded out-of-band, never committed),
-- and reads the batch tags it should resolve through pipeline_harvests_batch_tags() with that token.
-- Harvests are only added or refreshed, never removed: Metrc only answers for a window of LastModified, so a harvest
-- the job no longer sees is simply unchanged.
-- Readers: the same accounts as the Batches view (pipeline_can_view(), from pipeline-batches.sql). Safe to re-run.
-- Applied by the Pipeline deploy workflow as pipeline_owner (supabase/pipeline-order.txt).
set role pipeline_owner;

create table if not exists public.pipeline_harvests (
  license          text not null,     -- the cultivation license the harvest is under (CCL25-..., CCL22-..., CCL19-...)
  name             text not null,     -- Metrc harvest name, e.g. F2-2550-09282026
  site             text,              -- our site letter from the license: S Slane, F Filifera, I Imperial, O Olympic (Rio Verde)
  room             text,              -- the name's first part (F2); room names repeat across licenses
  strain_code      text,              -- Metrc's SourceStrainNames: a strain code (2550), or a name for a few crosses
  strain           text,              -- the strain's name, from our own package items (2550 = Nebula); null when unknown
  start_date       date,              -- HarvestStartDate
  finished_date    date,              -- FinishedDate
  archived_date    date,              -- ArchivedDate
  plant_count      int,
  wet_weight       numeric,           -- TotalWetWeight
  packaged_weight  numeric,           -- TotalPackagedWeight
  waste_weight     numeric,           -- TotalWasteWeight
  current_weight   numeric,           -- CurrentWeight (what is still in the harvest, not packaged yet)
  unit             text,              -- UnitOfWeightName: Grams
  package_count    int,
  lab_state        text,              -- LabTestingState: NotSubmitted, TestPassed ...
  harvest_type     text,              -- WholePlant, Manicure ...
  drying_location  text,              -- DryingLocationName
  on_hold          boolean,           -- any of Metrc's hold / investigation flags
  metrc_id         bigint,            -- Metrc's harvest Id
  last_modified    timestamptz,       -- Metrc's LastModified
  seen_at          timestamptz,       -- when the job first saw this harvest
  primary key (license, name)
);
create index if not exists pipeline_harvests_name on public.pipeline_harvests (name);
comment on table public.pipeline_harvests is
  'Metrc harvests of our cultivation licenses, for the Production Pipeline Batches view''s harvest report. Written by '
  '~/ar-automation/pipeline-harvests-sync.mjs via pipeline_harvests_save(); never deleted by the job.';
alter table public.pipeline_harvests enable row level security;
drop policy if exists pipeline_harvests_select on public.pipeline_harvests;
create policy pipeline_harvests_select on public.pipeline_harvests
  for select to authenticated using (public.pipeline_can_view());

-- Batch -> harvest links: one row per batch tag and source harvest name. license is the harvest's license when the job
-- knows that harvest under exactly one license; null for a harvest it cannot read (a vape from another maker) or has
-- not seen yet. Join to pipeline_harvests on name (and license when it is set).
create table if not exists public.pipeline_batch_harvests (
  metrc_uid  text not null,           -- the batch's Metrc tag (the sheet's METRC UID column)
  name       text not null,           -- a source harvest name from the package's SourceHarvestNames
  license    text,
  via        text,                    -- 'store' (the Mac's Metrc copy) or 'api' (one package lookup)
  seen_at    timestamptz,
  primary key (metrc_uid, name)
);
create index if not exists pipeline_batch_harvests_name on public.pipeline_batch_harvests (name);
comment on table public.pipeline_batch_harvests is
  'Which Metrc harvest(s) each batch tag came from, for the Production Pipeline Batches view. Written by '
  '~/ar-automation/pipeline-harvests-sync.mjs via pipeline_harvests_save().';
alter table public.pipeline_batch_harvests enable row level security;
drop policy if exists pipeline_batch_harvests_select on public.pipeline_batch_harvests;
create policy pipeline_batch_harvests_select on public.pipeline_batch_harvests
  for select to authenticated using (public.pipeline_can_view());

-- one row: when the job last ran, last changed something, and the LastModified span every license is read for
create table if not exists public.pipeline_harvests_meta (
  id            int primary key default 1 check (id = 1),
  synced_at     timestamptz,
  changed_at    timestamptz,
  harvests      int,                  -- rows in pipeline_harvests
  links         int,                  -- rows in pipeline_batch_harvests
  covered_from  timestamptz,          -- every license and list is read from here ...
  covered_to    timestamptz           -- ... to here
);
alter table public.pipeline_harvests_meta enable row level security;
drop policy if exists pipeline_harvests_meta_select on public.pipeline_harvests_meta;
create policy pipeline_harvests_meta_select on public.pipeline_harvests_meta
  for select to authenticated using (public.pipeline_can_view());

-- The batch tags the job should find harvests for: every Metrc tag on the Batch Label Sheet copy and every batch tag
-- with lab results (the all-in-one vapes have no sheet rows). Same token as the save function. Reads only.
create or replace function public.pipeline_harvests_batch_tags(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.pipeline_batch_labs_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  return jsonb_build_object('v', 1, 'tags', coalesce((
    select jsonb_agg(t order by t) from (
      select distinct upper(btrim(b.metrc_uid)) as t from public.pipeline_batches b
       where upper(btrim(b.metrc_uid)) ~ '^1A[0-9A-Z]{20,}$'
      union
      select l.metrc_uid from public.pipeline_batch_labs l where l.metrc_uid ~ '^1A[0-9A-Z]{20,}$'
    ) s), '[]'::jsonb));
end $$;
revoke all on function public.pipeline_harvests_batch_tags(text) from public;
grant execute on function public.pipeline_harvests_batch_tags(text) to anon, authenticated;

-- p_harvests: harvests that are new or changed since the job last sent them (null = none). Added or refreshed, never
--   removed; a row whose LastModified is older than the stored one is ignored.
-- p_links: batch tags whose harvest list is new or changed (null = none), each {metrc_uid, via, harvests: [{name,
--   license}]} with at least one harvest. That tag's links become exactly that list; other tags are untouched.
-- p_meta: {covered_from, covered_to} (either may be missing).
create or replace function public.pipeline_harvests_save(p_token text, p_harvests jsonb, p_links jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_h int := 0; n_l int := 0; n_del int := 0;
begin
  if not exists (select 1 from public.pipeline_batch_labs_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_harvests is not null then
    if jsonb_typeof(p_harvests) <> 'array' then raise exception 'p_harvests must be a list of harvests'; end if;
    if exists (select 1 from jsonb_array_elements(p_harvests) x
               where coalesce(x->>'license', '') !~ '^[A-Z0-9]{2,6}-[0-9A-Z-]{5,24}$'
                  or coalesce(btrim(x->>'name'), '') = '' or length(x->>'name') > 200
                  or coalesce(x->>'site', 'S') !~ '^[A-Z]$') then
      raise exception 'every harvest needs a license and a name';
    end if;
    insert into public.pipeline_harvests as h (license, name, site, room, strain_code, strain, start_date, finished_date,
           archived_date, plant_count, wet_weight, packaged_weight, waste_weight, current_weight, unit, package_count,
           lab_state, harvest_type, drying_location, on_hold, metrc_id, last_modified, seen_at)
    select x->>'license', x->>'name', x->>'site', x->>'room', x->>'strain_code', x->>'strain', (x->>'start_date')::date,
           (x->>'finished_date')::date, (x->>'archived_date')::date, (x->>'plant_count')::int, (x->>'wet_weight')::numeric,
           (x->>'packaged_weight')::numeric, (x->>'waste_weight')::numeric, (x->>'current_weight')::numeric, x->>'unit',
           (x->>'package_count')::int, x->>'lab_state', x->>'harvest_type', x->>'drying_location',
           (x->>'on_hold')::boolean, (x->>'metrc_id')::bigint, (x->>'last_modified')::timestamptz,
           coalesce((x->>'seen_at')::timestamptz, now())
      from jsonb_array_elements(p_harvests) x
    on conflict (license, name) do update set site = excluded.site, room = excluded.room,
      strain_code = excluded.strain_code, strain = coalesce(excluded.strain, h.strain), start_date = excluded.start_date,
      finished_date = excluded.finished_date, archived_date = excluded.archived_date, plant_count = excluded.plant_count,
      wet_weight = excluded.wet_weight, packaged_weight = excluded.packaged_weight, waste_weight = excluded.waste_weight,
      current_weight = excluded.current_weight, unit = excluded.unit, package_count = excluded.package_count,
      lab_state = excluded.lab_state, harvest_type = excluded.harvest_type, drying_location = excluded.drying_location,
      on_hold = excluded.on_hold, metrc_id = excluded.metrc_id, last_modified = excluded.last_modified,
      seen_at = coalesce(h.seen_at, excluded.seen_at)
      where h.last_modified is null or excluded.last_modified is null or excluded.last_modified >= h.last_modified;
    get diagnostics n_h = row_count;
  end if;
  if p_links is not null then
    if jsonb_typeof(p_links) <> 'array' then raise exception 'p_links must be a list of batch tags'; end if;
    if exists (select 1 from jsonb_array_elements(p_links) x
               where coalesce(x->>'metrc_uid', '') !~ '^1A[0-9A-Z]{20,}$'
                  or coalesce(x->>'via', '') not in ('store', 'api')
                  or jsonb_typeof(x->'harvests') is distinct from 'array' or jsonb_array_length(x->'harvests') < 1) then
      raise exception 'every link needs a Metrc tag, store or api, and at least one harvest';
    end if;
    if exists (select 1 from jsonb_array_elements(p_links) x, jsonb_array_elements(x->'harvests') y
               where coalesce(btrim(y->>'name'), '') = '' or length(y->>'name') > 200) then
      raise exception 'every linked harvest needs a name';
    end if;
    insert into public.pipeline_batch_harvests as b (metrc_uid, name, license, via, seen_at)
    select x->>'metrc_uid', y->>'name', y->>'license', x->>'via', now()
      from jsonb_array_elements(p_links) x, jsonb_array_elements(x->'harvests') y
    on conflict (metrc_uid, name) do update set license = excluded.license, via = excluded.via,
      seen_at = coalesce(b.seen_at, excluded.seen_at);
    get diagnostics n_l = row_count;
    -- a sent tag's list is the whole list for that tag: names it no longer lists go (only for the tags sent)
    delete from public.pipeline_batch_harvests b
     where b.metrc_uid in (select x->>'metrc_uid' from jsonb_array_elements(p_links) x)
       and not exists (select 1 from jsonb_array_elements(p_links) x, jsonb_array_elements(x->'harvests') y
                        where x->>'metrc_uid' = b.metrc_uid and y->>'name' = b.name);
    get diagnostics n_del = row_count;
  end if;
  insert into public.pipeline_harvests_meta as m (id, synced_at, changed_at, harvests, links, covered_from, covered_to)
  values (1, now(), case when p_harvests is not null or p_links is not null then now() end,
          (select count(*) from public.pipeline_harvests), (select count(*) from public.pipeline_batch_harvests),
          (p_meta->>'covered_from')::timestamptz, (p_meta->>'covered_to')::timestamptz)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_harvests is not null or p_links is not null then now() else m.changed_at end,
    harvests = excluded.harvests, links = excluded.links,
    covered_from = coalesce(excluded.covered_from, m.covered_from),
    covered_to = coalesce(excluded.covered_to, m.covered_to);
  -- v: which fields this function stores; the job re-sends until it sees the version it needs
  return jsonb_build_object('ok', true, 'harvests', n_h, 'links', n_l, 'removed_links', n_del, 'v', 1);
end $$;
revoke all on function public.pipeline_harvests_save(text, jsonb, jsonb, jsonb) from public;
grant execute on function public.pipeline_harvests_save(text, jsonb, jsonb, jsonb) to anon, authenticated;

reset role;
