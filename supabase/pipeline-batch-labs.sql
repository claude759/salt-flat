-- Production Pipeline page (pipeline.html), Batches view: lab results filled in as they arrive.
-- Victoria's Batch Label Sheet gets its Test date, COA date and THC typed by hand once the COA is back. An hourly job
-- on Gianni's Mac (~/ar-automation/pipeline-labs-sync.mjs) reads the same facts as they happen:
--   - Metrc: the lab-sample manifests to Excelbis (sample tag -> its source package = the batch's Metrc UID, and the
--     day the sample was sent);
--   - the Excelbis results e-mails (Confident LIMS, to gianni@): each COA PDF names "METRC Sample" and "METRC Batch",
--     with Collected / Completed dates, the pass or fail result and Total THC.
-- It sends one row per batch tag through pipeline_batch_labs_save() (token-gated; the token hash is seeded
-- out-of-band, never committed). The page shows these only where the sheet's own cell is still blank, marked as
-- filled in automatically. Nothing here changes the sheet or pipeline_batches.
-- Readers: the same accounts as the Batches view (pipeline_can_view(), from pipeline-batches.sql). Safe to re-run.

create table if not exists public.pipeline_batch_labs (
  metrc_uid   text primary key,      -- the batch's Metrc tag (the sheet's METRC UID column)
  sample_uid  text,                  -- the lab sample's Metrc tag
  sample_id   text,                  -- Excelbis / Confident sample id, e.g. 2610EXL8431.33625
  strain      text,                  -- as the lab wrote it
  sent_date   date,                  -- the sample's Metrc manifest to the lab was created
  collected   date,                  -- COA: Collected (the sheet's Test date)
  completed   date,                  -- COA: Completed (the sheet's COA date)
  result      text,                  -- COA batch result: Pass / Fail
  total_thc   numeric,               -- COA Total THC, percent
  thc_label   numeric,               -- the sheet's THC convention: Total THC x 1.10, cut to 2 decimals
  lab_url     text,                  -- the sample's results page on Confident LIMS
  coa_file    text,                  -- the COA PDF's file name in the e-mail
  source      text not null,         -- 'coa' (results e-mail) or 'metrc' (sample sent, no results yet)
  seen_at     timestamptz            -- when the job first saw this result
);
comment on table public.pipeline_batch_labs is
  'Lab results per batch tag for the Production Pipeline Batches view, from Metrc lab manifests and the Excelbis '
  'COA e-mails. Written hourly by ~/ar-automation/pipeline-labs-sync.mjs via pipeline_batch_labs_save().';
alter table public.pipeline_batch_labs enable row level security;
drop policy if exists pipeline_batch_labs_select on public.pipeline_batch_labs;
create policy pipeline_batch_labs_select on public.pipeline_batch_labs
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_batch_labs_meta (
  id          int primary key default 1 check (id = 1),
  synced_at   timestamptz,
  changed_at  timestamptz,
  rows        int
);
alter table public.pipeline_batch_labs_meta enable row level security;
drop policy if exists pipeline_batch_labs_meta_select on public.pipeline_batch_labs_meta;
create policy pipeline_batch_labs_meta_select on public.pipeline_batch_labs_meta
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_batch_labs_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.pipeline_batch_labs_secret enable row level security;   -- no policies: nobody reads it

-- p_rows: every batch tag the job knows lab facts for (null = unchanged: only the sync time is stamped).
create or replace function public.pipeline_batch_labs_save(p_token text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int := 0; n_del int := 0;
begin
  if not exists (select 1 from public.pipeline_batch_labs_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
      raise exception 'p_rows must be the full list of lab rows';   -- an empty read must not wipe what the page shows
    end if;
    if exists (select 1 from jsonb_array_elements(p_rows) x
               where coalesce(x->>'metrc_uid', '') !~ '^1A[0-9A-Z]{20,}$' or coalesce(x->>'source', '') not in ('coa', 'metrc')) then
      raise exception 'every row needs a Metrc tag and a source';
    end if;
    insert into public.pipeline_batch_labs as l (metrc_uid, sample_uid, sample_id, strain, sent_date, collected, completed, result,
           total_thc, thc_label, lab_url, coa_file, source, seen_at)
    select x->>'metrc_uid', x->>'sample_uid', x->>'sample_id', x->>'strain', (x->>'sent_date')::date, (x->>'collected')::date,
           (x->>'completed')::date, x->>'result', (x->>'total_thc')::numeric, (x->>'thc_label')::numeric, x->>'lab_url',
           x->>'coa_file', x->>'source', coalesce((x->>'seen_at')::timestamptz, now())
      from jsonb_array_elements(p_rows) x
    on conflict (metrc_uid) do update set sample_uid = excluded.sample_uid, sample_id = excluded.sample_id, strain = excluded.strain,
      sent_date = excluded.sent_date, collected = excluded.collected, completed = excluded.completed, result = excluded.result,
      total_thc = excluded.total_thc, thc_label = excluded.thc_label, lab_url = excluded.lab_url, coa_file = excluded.coa_file,
      source = excluded.source, seen_at = coalesce(l.seen_at, excluded.seen_at)
      where l.source = 'metrc' or excluded.source = 'coa';   -- a sample still out never overwrites a stored COA
    get diagnostics n = row_count;
    -- COAs are kept even when the job no longer sees them (its mail search reaches back 150 days; a lost cache must not
    -- wipe them); only rows that never had a COA go when they drop out
    delete from public.pipeline_batch_labs l
     where l.source = 'metrc'
       and not exists (select 1 from jsonb_array_elements(p_rows) x where x->>'metrc_uid' = l.metrc_uid);
    get diagnostics n_del = row_count;
  end if;
  insert into public.pipeline_batch_labs_meta as m (id, synced_at, changed_at, rows)
  values (1, now(), case when p_rows is not null then now() end, case when p_rows is not null then n end)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_rows is not null then now() else m.changed_at end,
    rows = coalesce(excluded.rows, m.rows);
  return jsonb_build_object('ok', true, 'upserted', n, 'removed', n_del);
end $$;
revoke all on function public.pipeline_batch_labs_save(text, jsonb) from public;
grant execute on function public.pipeline_batch_labs_save(text, jsonb) to anon, authenticated;
