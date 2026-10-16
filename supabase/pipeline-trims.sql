-- Production Pipeline page (pipeline.html): trim yields for the Week board's trim estimates.
-- The site trim workbooks ("2026 TRIM SHEETS" folder in Drive: FILIFERA / SLANE / IMPERIAL PROJECTS / OLYMPIC
-- 2026.xlsx) have one tab per trim: the room, its lights, and the bigs / littles / trim grams per strain. They are
-- .xlsx files, not link-shared, so the browser can't read them. An hourly job on Gianni's Mac
-- (~/ar-automation/pipeline-trims-sync.mjs) downloads them with the bookkeeping service account (a Viewer on the
-- folder), reads every tab, and sends the whole set through pipeline_trims_save() (token-gated; the token hash is
-- seeded out-of-band, never committed). The page turns past trims into pounds per light and estimates the trims
-- still to come. Readers: the same accounts as the Batches view (pipeline_can_view(), from pipeline-batches.sql).
-- Safe to re-run.

create table if not exists public.pipeline_trims (
  file        text not null,                       -- workbook, e.g. 'FILIFERA 2026.xlsx'
  tab         text not null,                       -- the tab the trim is on, e.g. 'Oct 2-4'
  block       int  not null,                       -- which ROOM block on the tab (0 for the first)
  line        int  not null,                       -- strain position in the block (0 = first strain column)
  site        text not null,                       -- 23RD (Slane), 25TH (Filifera), 15TH (Imperial), OLYMPIC
  room        text,                                -- as written after ROOM: '1', 'B' ...
  start_date  date,                                -- read from the tab name; null when it has no date
  end_date    date,
  lights      numeric,                             -- the block's "Lights:" cell
  strain      text not null,                       -- as written on the tab
  code        text,                                -- the strain code row above the block
  bigs_g      numeric not null default 0,          -- grams, from the Total Gms row
  littles_g   numeric not null default 0,
  trim_g      numeric not null default 0,          -- grams, from the Trim section's Grams row
  primary key (file, tab, block, line)
);
comment on table public.pipeline_trims is
  'Site trim workbooks (2026 TRIM SHEETS) for the Production Pipeline trim estimates. Written hourly by '
  '~/ar-automation/pipeline-trims-sync.mjs via pipeline_trims_save(); read by pipeline_can_view() accounts.';
alter table public.pipeline_trims enable row level security;
drop policy if exists pipeline_trims_select on public.pipeline_trims;
create policy pipeline_trims_select on public.pipeline_trims
  for select to authenticated using (public.pipeline_can_view());

-- one row: when the job last ran, when a run last changed a row, and when the newest workbook was edited
create table if not exists public.pipeline_trims_meta (
  id            int primary key default 1 check (id = 1),
  synced_at     timestamptz,
  changed_at    timestamptz,
  file_modified timestamptz,
  files         int,
  trims         int
);
alter table public.pipeline_trims_meta enable row level security;
drop policy if exists pipeline_trims_meta_select on public.pipeline_trims_meta;
create policy pipeline_trims_meta_select on public.pipeline_trims_meta
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_trims_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.pipeline_trims_secret enable row level security;   -- no policies: nobody reads it

-- p_rows: every strain line the workbooks have now (null = unchanged since the last run: only the sync time is
-- stamped). Lines no longer sent were deleted or moved on the tabs, and are removed.
create or replace function public.pipeline_trims_save(p_token text, p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int := 0; n_del int := 0;
begin
  if not exists (select 1 from public.pipeline_trims_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 20 then
      raise exception 'p_rows must be the full list of trim lines';   -- a half-read folder must not wipe the history
    end if;
    if exists (select 1 from jsonb_array_elements(p_rows) r
               where coalesce(r->>'file', '') = '' or coalesce(r->>'tab', '') = '' or coalesce(r->>'site', '') = ''
                  or coalesce(r->>'strain', '') = '' or coalesce(r->>'block', '') !~ '^[0-9]+$' or coalesce(r->>'line', '') !~ '^[0-9]+$') then
      raise exception 'every line needs file, tab, block, line, site and strain';
    end if;
    insert into public.pipeline_trims as t (file, tab, block, line, site, room, start_date, end_date, lights, strain, code, bigs_g, littles_g, trim_g)
    select r->>'file', r->>'tab', (r->>'block')::int, (r->>'line')::int, r->>'site', r->>'room', (r->>'start_date')::date,
           (r->>'end_date')::date, (r->>'lights')::numeric, r->>'strain', r->>'code', coalesce((r->>'bigs_g')::numeric, 0),
           coalesce((r->>'littles_g')::numeric, 0), coalesce((r->>'trim_g')::numeric, 0)
      from jsonb_array_elements(p_rows) r
    on conflict (file, tab, block, line) do update set
      site = excluded.site, room = excluded.room, start_date = excluded.start_date, end_date = excluded.end_date,
      lights = excluded.lights, strain = excluded.strain, code = excluded.code, bigs_g = excluded.bigs_g,
      littles_g = excluded.littles_g, trim_g = excluded.trim_g;
    get diagnostics n_up = row_count;
    delete from public.pipeline_trims t
     where not exists (select 1 from jsonb_array_elements(p_rows) r
                        where r->>'file' = t.file and r->>'tab' = t.tab and (r->>'block')::int = t.block and (r->>'line')::int = t.line);
    get diagnostics n_del = row_count;
  end if;
  insert into public.pipeline_trims_meta as m (id, synced_at, changed_at, file_modified, files, trims)
  values (1, now(), case when p_rows is not null then now() end, (p_meta->>'file_modified')::timestamptz,
          (p_meta->>'files')::int, (p_meta->>'trims')::int)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_rows is not null then now() else m.changed_at end,
    file_modified = coalesce(excluded.file_modified, m.file_modified),
    files = coalesce(excluded.files, m.files), trims = coalesce(excluded.trims, m.trims);
  return jsonb_build_object('ok', true, 'upserted', n_up, 'removed', n_del);
end $$;
revoke all on function public.pipeline_trims_save(text, jsonb, jsonb) from public;
grant execute on function public.pipeline_trims_save(text, jsonb, jsonb) to anon, authenticated;
