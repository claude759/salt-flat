-- Production Pipeline page (pipeline.html), Batch V2 view: where each lot's pounds went and how much is still ours.
-- A lot is one site, one room and one harvest day (lot_id 'SITE|ROOM|YYYY-MM-DD', rooms as the page's BT2 model names
-- them: Metrc's F2 is room 2, FA is room A). A job on Gianni's Mac (~/ar-automation/pipeline-flow-sync.mjs, hourly)
-- builds one row per lot from the Mac's Metrc copy (packages, transfer lines, Rio Verde's transfers), the harvest
-- job's cache, a few cached read-only Metrc package lookups, the Batch Label Sheet's Metrc tags and, as a cross-check
-- only, Distru's Inventory Assets export. Pounds only, never dollars.
--   left_lb       flower (bulk flower, sugar leaves and packaged goods as flower-equivalent pounds: a 3.5 g jar or
--                 5-pack 3.5 g, a 1 g pre-roll 1 g, a 1.5 g pouch or pre-roll 1.5 g, vapes 0) still at our licenses:
--                 the four grows and the distros; what is at Nabis is not ours and is not counted
--   left_trim_lb  Bulk Trim / Trim still at our licenses (trim never counts in left_lb)
--   went          where the flower went: {bulk: {buyer: lb}, nabis, distru, to_distro (internal, not an exit), labs,
--                 finished, in_transit, moved_unread, unexplained, trim: {...}}
--   series        [[monday, left_lb], ...] what was left at our licenses at the end of each week
-- The job sends the whole set through pipeline_flow_save(), gated by the same job token as the lab results
-- (pipeline_batch_labs_secret, from pipeline-batch-labs.sql; the token hash is seeded out-of-band, never committed).
-- Readers: the same accounts as the Batches view (pipeline_can_view(), from pipeline-batches.sql). Safe to re-run.
-- Applied by the Pipeline deploy workflow as pipeline_owner (supabase/pipeline-order.txt).
set role pipeline_owner;

create table if not exists public.pipeline_flow_lots (
  lot_id             text primary key,  -- 'SITE|ROOM|YYYY-MM-DD', e.g. '23RD|3|2026-10-07'; ROOM may be ''
  site               text not null,     -- 23RD, 25TH, 15TH, OLYMPIC
  room               text not null default '',
  harvest_date       date not null,
  strains            jsonb,             -- [{name, packaged_lb, left_lb}], one per Metrc harvest of the lot
  metrc_harvests     jsonb,             -- the Metrc harvest names
  wet_lb             numeric,           -- Metrc wet weight (null when the harvest is not read yet)
  first_packaged     date,              -- first and last day a package was made from the lot (the trim)
  last_packaged      date,
  packaged_flower_lb numeric,           -- packages made from the lot, flower and sugar leaves
  packaged_trim_lb   numeric,           -- packages made from the lot, Bulk Trim / Trim
  left_lb            numeric,           -- flower still at our licenses now
  left_grow_lb       numeric,           --   of which at the grow
  left_distro_lb     numeric,           --   of which at the distros
  left_trim_lb       numeric,           -- trim still at our licenses now
  left_by_lab        jsonb,             -- {untested, testing, passed, failed} lb of left_lb
  went               jsonb,             -- where the pounds went (see above)
  series             jsonb,             -- [[monday, lb], ...] weekly, from the first package day to now
  confidence         text not null check (confidence in ('good', 'partial')),
  note               text,              -- plain sentences: what is estimated or missing
  updated_at         timestamptz not null default now()   -- when this row last changed
);
comment on table public.pipeline_flow_lots is
  'One row per lot (site, room, harvest day): pounds packaged, still at our licenses, and where the rest went, for the '
  'Production Pipeline Batch V2 view. Written by ~/ar-automation/pipeline-flow-sync.mjs via pipeline_flow_save().';
alter table public.pipeline_flow_lots enable row level security;
drop policy if exists pipeline_flow_lots_select on public.pipeline_flow_lots;
create policy pipeline_flow_lots_select on public.pipeline_flow_lots
  for select to authenticated using (public.pipeline_can_view());

-- one row: when the job last ran and last changed something, how many lots, and the first harvest day it covers
create table if not exists public.pipeline_flow_meta (
  id            int primary key default 1 check (id = 1),
  synced_at     timestamptz,
  changed_at    timestamptz,
  rows          int,
  covered_from  date,
  summary       jsonb               -- the job's totals and cross-checks (lb only), for the page's headline and cards;
                                    -- summary.sales: the Sales band's weekly pounds and units (pipeline_flow_save keeps it
                                    -- only when no key in it names money)
);
alter table public.pipeline_flow_meta enable row level security;
drop policy if exists pipeline_flow_meta_select on public.pipeline_flow_meta;
create policy pipeline_flow_meta_select on public.pipeline_flow_meta
  for select to authenticated using (public.pipeline_can_view());

-- p_rows: every lot as it stands now (the full set; lots not sent are removed). null = unchanged: only the sync time
-- is stamped. An empty or short list is refused, so a half-read run can never wipe the table.
-- p_meta: {covered_from, summary} (either may be missing).
-- A row whose content is the same as the stored one is left alone (its updated_at keeps its time).
create or replace function public.pipeline_flow_save(p_token text, p_rows jsonb, p_meta jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int := 0; n_del int := 0;
begin
  if not exists (select 1 from public.pipeline_batch_labs_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 5 then
      raise exception 'p_rows must be the full list of lots';
    end if;
    if jsonb_array_length(p_rows) > 3000 then raise exception 'p_rows has too many lots'; end if;
    if exists (select 1 from jsonb_array_elements(p_rows) x
               where coalesce(x->>'lot_id', '') !~ '^(23RD|25TH|15TH|OLYMPIC)\|[0-9A-Z]{0,4}\|[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  or coalesce(x->>'site', '') not in ('23RD', '25TH', '15TH', 'OLYMPIC')
                  or x->>'lot_id' <> concat_ws('|', x->>'site', coalesce(x->>'room', ''), x->>'harvest_date')
                  or coalesce(x->>'confidence', '') not in ('good', 'partial')
                  or coalesce(length(x->>'note'), 0) > 2000) then
      raise exception 'every lot needs lot_id = site|room|harvest_date, a known site and a confidence';
    end if;
    if (select count(distinct x->>'lot_id') from jsonb_array_elements(p_rows) x) <> jsonb_array_length(p_rows) then
      raise exception 'a lot is listed twice';
    end if;
    insert into public.pipeline_flow_lots as t (lot_id, site, room, harvest_date, strains, metrc_harvests, wet_lb,
           first_packaged, last_packaged, packaged_flower_lb, packaged_trim_lb, left_lb, left_grow_lb, left_distro_lb,
           left_trim_lb, left_by_lab, went, series, confidence, note, updated_at)
    select x->>'lot_id', x->>'site', coalesce(x->>'room', ''), (x->>'harvest_date')::date, x->'strains', x->'metrc_harvests',
           (x->>'wet_lb')::numeric, (x->>'first_packaged')::date, (x->>'last_packaged')::date,
           (x->>'packaged_flower_lb')::numeric, (x->>'packaged_trim_lb')::numeric, (x->>'left_lb')::numeric,
           (x->>'left_grow_lb')::numeric, (x->>'left_distro_lb')::numeric, (x->>'left_trim_lb')::numeric,
           x->'left_by_lab', x->'went', x->'series', x->>'confidence', x->>'note', now()
      from jsonb_array_elements(p_rows) x
    on conflict (lot_id) do update set site = excluded.site, room = excluded.room, harvest_date = excluded.harvest_date,
      strains = excluded.strains, metrc_harvests = excluded.metrc_harvests, wet_lb = excluded.wet_lb,
      first_packaged = excluded.first_packaged, last_packaged = excluded.last_packaged,
      packaged_flower_lb = excluded.packaged_flower_lb, packaged_trim_lb = excluded.packaged_trim_lb,
      left_lb = excluded.left_lb, left_grow_lb = excluded.left_grow_lb, left_distro_lb = excluded.left_distro_lb,
      left_trim_lb = excluded.left_trim_lb, left_by_lab = excluded.left_by_lab, went = excluded.went,
      series = excluded.series, confidence = excluded.confidence, note = excluded.note, updated_at = now()
      where (t.site, t.room, t.harvest_date, t.strains, t.metrc_harvests, t.wet_lb, t.first_packaged, t.last_packaged,
             t.packaged_flower_lb, t.packaged_trim_lb, t.left_lb, t.left_grow_lb, t.left_distro_lb, t.left_trim_lb,
             t.left_by_lab, t.went, t.series, t.confidence, t.note)
        is distinct from (excluded.site, excluded.room, excluded.harvest_date, excluded.strains, excluded.metrc_harvests,
             excluded.wet_lb, excluded.first_packaged, excluded.last_packaged, excluded.packaged_flower_lb,
             excluded.packaged_trim_lb, excluded.left_lb, excluded.left_grow_lb, excluded.left_distro_lb,
             excluded.left_trim_lb, excluded.left_by_lab, excluded.went, excluded.series, excluded.confidence,
             excluded.note);
    get diagnostics n_up = row_count;
    -- the list is the whole set: lots it no longer has go (only those)
    delete from public.pipeline_flow_lots t
     where not exists (select 1 from jsonb_array_elements(p_rows) x where x->>'lot_id' = t.lot_id);
    get diagnostics n_del = row_count;
  end if;
  -- the sales block (pounds and units only) is dropped, never stored, if a key in it names money or a $ appears
  insert into public.pipeline_flow_meta as m (id, synced_at, changed_at, rows, covered_from, summary)
  values (1, now(), case when n_up + n_del > 0 then now() end, (select count(*) from public.pipeline_flow_lots),
          (p_meta->>'covered_from')::date,
          case when p_meta->'summary'->'sales' is not null
                and (p_meta->'summary'->'sales')::text ~* '"[^"]*(price|dollar|revenue|subtotal|amount|cost|usd)[^"]*": |[$]'
               then (p_meta->'summary') - 'sales' else p_meta->'summary' end)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when n_up + n_del > 0 then now() else m.changed_at end,
    rows = excluded.rows,
    covered_from = coalesce(excluded.covered_from, m.covered_from),
    summary = coalesce(excluded.summary, m.summary);
  -- v: which fields this function stores; the job re-sends until it sees the version it needs
  return jsonb_build_object('ok', true, 'saved', n_up, 'removed', n_del, 'v', 1);
end $$;
revoke all on function public.pipeline_flow_save(text, jsonb, jsonb) from public;
grant execute on function public.pipeline_flow_save(text, jsonb, jsonb) to anon, authenticated;

reset role;
