-- Production Pipeline page (pipeline.html), Batches view.
-- Victoria's "Batch Label Sheet.xlsx" (Drive, tab WIZARD) lists one row per Metrc package: one SKU of one
-- strain, with its batch code, harvest/package dates, lab, potency, Metrc UID and the test / COA / Nabis dates.
-- It is an .xlsx, not a Google Sheet, so the browser can't read it. An hourly job on Gianni's Mac
-- (~/ar-automation/pipeline-batches-sync.mjs) downloads it, keeps the active rows plus recently finished ones,
-- and sends the whole set through pipeline_batches_save() (token-gated; the token hash is seeded out-of-band,
-- never committed). Readers: the same accounts pipeline_source() lets in (universal admins + pipeline_viewers).
-- Safe to re-run.

create or replace function public.pipeline_can_view()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_universal_admin()
      or exists (select 1 from public.pipeline_viewers v
                 where v.email = lower(coalesce(auth.jwt()->>'email', '')));
$$;
revoke all on function public.pipeline_can_view() from public, anon;
grant execute on function public.pipeline_can_view() to authenticated;

create table if not exists public.pipeline_batches (
  sheet_row       int primary key,                 -- row in the WIZARD tab; the set is replaced as a whole each run
  finished        boolean not null default false,  -- below the sheet's FINISHED/COMPLETE ITEMS divider
  status          text,                            -- as typed: WAITING FOR COA, PACKAGING, DONE ...
  strain          text,
  item            text,                            -- FLOWER, 5PK, 1G, 1.5g prerolls ...
  class           text,
  cross_name      text,
  harvest_date    date,
  package_date    date,
  batch_code      text,                            -- e.g. F2-BM-9126-S: room, strain, harvest M D YY, site
  cult_lic        text,
  distro_lic      text,
  tested_by       text,
  thc             numeric,                         -- percent, as on the COA (30.57)
  cbd             numeric,
  total_canna     numeric,
  metrc_uid       text,
  coa_url         text,                            -- the COA cell's link (or its text when that is a URL)
  coa_text        text,                            -- the COA cell's words when they are not a URL
  total_units     numeric,
  budtender_units numeric,
  cases           numeric,
  distru_qty      numeric,
  received_date   date,
  test_date       date,
  coa_date        date,                            -- COA return date
  nabis_date      date,                            -- Nabis pickup date
  notes           text                             -- words typed into the number/date columns, kept as written
);
comment on table public.pipeline_batches is
  'Batch Label Sheet (WIZARD tab) for the Production Pipeline Batches view. Written hourly by '
  '~/ar-automation/pipeline-batches-sync.mjs via pipeline_batches_save(); read by pipeline_can_view() accounts.';
alter table public.pipeline_batches enable row level security;
drop policy if exists pipeline_batches_select on public.pipeline_batches;
create policy pipeline_batches_select on public.pipeline_batches
  for select to authenticated using (public.pipeline_can_view());

-- one row: when the job last ran and when the sheet was last edited, so the page can say how fresh it is
create table if not exists public.pipeline_batches_meta (
  id             int primary key default 1 check (id = 1),
  synced_at      timestamptz,
  file_modified  timestamptz,
  active_rows    int,
  finished_rows  int,
  finished_since date                              -- finished rows older than this are left out
);
alter table public.pipeline_batches_meta add column if not exists changed_at timestamptz;  -- last run that changed a row
alter table public.pipeline_batches_meta enable row level security;
drop policy if exists pipeline_batches_meta_select on public.pipeline_batches_meta;
create policy pipeline_batches_meta_select on public.pipeline_batches_meta
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_batches_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.pipeline_batches_secret enable row level security;   -- no policies: nobody reads it

-- p_rows: every row the sheet has now (null = unchanged since the last run: only the sync time is stamped).
-- Rows no longer sent were deleted, moved or aged out of the finished window, and are removed.
create or replace function public.pipeline_batches_save(p_token text, p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int := 0; n_del int := 0;
begin
  if not exists (select 1 from public.pipeline_batches_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 5 then
      raise exception 'p_rows must be the full list of batches';   -- a half-read sheet must not wipe the board
    end if;
    if exists (select 1 from jsonb_array_elements(p_rows) r where coalesce(r->>'sheet_row', '') !~ '^[0-9]+$') then
      raise exception 'every row needs its sheet_row';
    end if;
    insert into public.pipeline_batches as b (sheet_row, finished, status, strain, item, class, cross_name,
           harvest_date, package_date, batch_code, cult_lic, distro_lic, tested_by, thc, cbd, total_canna,
           metrc_uid, coa_url, coa_text, total_units, budtender_units, cases, distru_qty,
           received_date, test_date, coa_date, nabis_date, notes)
    select (r->>'sheet_row')::int, coalesce((r->>'finished')::boolean, false), r->>'status', r->>'strain', r->>'item',
           r->>'class', r->>'cross_name', (r->>'harvest_date')::date, (r->>'package_date')::date, r->>'batch_code',
           r->>'cult_lic', r->>'distro_lic', r->>'tested_by', (r->>'thc')::numeric, (r->>'cbd')::numeric,
           (r->>'total_canna')::numeric, r->>'metrc_uid', r->>'coa_url', r->>'coa_text', (r->>'total_units')::numeric,
           (r->>'budtender_units')::numeric, (r->>'cases')::numeric, (r->>'distru_qty')::numeric,
           (r->>'received_date')::date, (r->>'test_date')::date, (r->>'coa_date')::date, (r->>'nabis_date')::date,
           r->>'notes'
      from jsonb_array_elements(p_rows) r
    on conflict (sheet_row) do update set
      finished = excluded.finished, status = excluded.status, strain = excluded.strain, item = excluded.item,
      class = excluded.class, cross_name = excluded.cross_name, harvest_date = excluded.harvest_date,
      package_date = excluded.package_date, batch_code = excluded.batch_code, cult_lic = excluded.cult_lic,
      distro_lic = excluded.distro_lic, tested_by = excluded.tested_by, thc = excluded.thc, cbd = excluded.cbd,
      total_canna = excluded.total_canna, metrc_uid = excluded.metrc_uid, coa_url = excluded.coa_url,
      coa_text = excluded.coa_text, total_units = excluded.total_units, budtender_units = excluded.budtender_units,
      cases = excluded.cases, distru_qty = excluded.distru_qty, received_date = excluded.received_date,
      test_date = excluded.test_date, coa_date = excluded.coa_date, nabis_date = excluded.nabis_date,
      notes = excluded.notes;
    get diagnostics n_up = row_count;
    delete from public.pipeline_batches
     where sheet_row not in (select (r->>'sheet_row')::int from jsonb_array_elements(p_rows) r);
    get diagnostics n_del = row_count;
  end if;
  insert into public.pipeline_batches_meta as m (id, synced_at, changed_at, file_modified, active_rows, finished_rows, finished_since)
  values (1, now(), case when p_rows is not null then now() end, (p_meta->>'file_modified')::timestamptz,
          (p_meta->>'active_rows')::int, (p_meta->>'finished_rows')::int, (p_meta->>'finished_since')::date)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_rows is not null then now() else m.changed_at end,
    file_modified = coalesce(excluded.file_modified, m.file_modified),
    active_rows = coalesce(excluded.active_rows, m.active_rows),
    finished_rows = coalesce(excluded.finished_rows, m.finished_rows),
    finished_since = coalesce(excluded.finished_since, m.finished_since);
  return jsonb_build_object('ok', true, 'upserted', n_up, 'removed', n_del);
end $$;
revoke all on function public.pipeline_batches_save(text, jsonb, jsonb) from public;
grant execute on function public.pipeline_batches_save(text, jsonb, jsonb) to anon, authenticated;
