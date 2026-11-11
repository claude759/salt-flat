set role pipeline_owner;
-- Production Pipeline page (pipeline.html): the data jobs that used to run on Gianni's Mac, as Supabase Edge Functions.
--   pipeline-marks-sync    red cells of the DISTRO PIPELINE tab -> pipeline_marks, every 5 minutes
--   pipeline-trims-sync    the 2026 TRIM SHEETS workbooks -> pipeline_trims, hourly
--   pipeline-batches-sync  the Batch Label Sheet -> pipeline_batches, hourly
-- (supabase/functions/pipeline-*-sync; called by pg_cron, supabase/postgres/pipeline-sync-cron.sql.) They write the
-- same rows and meta stamps as the Mac jobs, through pipeline_sync_apply(), whose per-job bodies are the *_save
-- functions' bodies without the token check (tests/pipeline-sync-check.mjs holds them identical).
-- Each job has a mode in pipeline_sync_settings:
--   off     the function answers at once and does nothing
--   shadow  it reads and compares with what the table holds now, logs the differences, writes nothing, stamps nothing
--           (pipeline_sync_apply refuses it)
--   write   it keeps the table up to date, as the Mac job did
-- The Drive file and folder ids live in pipeline_sync_settings.source_id, never in this repo; the workbook for marks
-- comes from schedule_board (schedule_board_ca_workbook()). Pipeline admins (pipeline_sync_can_admin()) change modes and
-- ids with pipeline_sync_set() and read pipeline_sync_status(); the tables themselves have no policies.
-- Needs the pipeline_owner bootstrap, pipeline-access.sql (pipeline_jwt_email) and pipeline-admin.sql (pipeline_is_admin).
-- Applied by the Pipeline deploy workflow as pipeline_owner (supabase/pipeline-order.txt). Safe to re-run.

create table if not exists public.pipeline_sync_settings (
  job        text primary key check (job ~ '^[a-z][a-z0-9-]{1,30}$'),
  mode       text not null default 'off' check (mode in ('off', 'shadow', 'write')),
  source_id  text check (source_id ~ '^[A-Za-z0-9_-]{10,200}$'),   -- a Drive file or folder id; null for marks = the CA workbook
  updated_at timestamptz not null default now(),
  updated_by text
);
comment on table public.pipeline_sync_settings is
  'Production Pipeline sync jobs (supabase/functions/pipeline-*-sync): mode off/shadow/write and the Drive id each reads. '
  'Changed through pipeline_sync_set() by pipeline admins; read by the service role.';
alter table public.pipeline_sync_settings enable row level security;   -- no policies
revoke all on table public.pipeline_sync_settings from public, anon, authenticated, service_role;   -- writes only through the functions below
grant select on table public.pipeline_sync_settings to service_role;
insert into public.pipeline_sync_settings (job) values ('marks'), ('trims'), ('batches') on conflict (job) do nothing;

-- what the last runs left for the next one (the Mac jobs kept this in ~/ar-automation/data/pipeline-*-last.*)
create table if not exists public.pipeline_sync_state (
  job           text primary key references public.pipeline_sync_settings (job),
  running_since timestamptz,   -- a run holds the job (the overlap guard); null = free
  run_token     uuid,
  run_mode      text,
  run_by        text,
  source_sig    text,          -- the version of the source the last run read
  written_sig   text,          -- the source version last written in write mode (cleared when the mode or id changes)
  rows_sig      text,          -- sha256 of the rows last written, like the Mac's -last.txt files
  compared_sig  text,          -- the source version last compared in shadow mode against a table on the same version
  cache         jsonb,         -- trims: each workbook's md5 and lines (only changed ones are parsed); batches: last counts
  last_run_at   timestamptz,
  last_status   text,
  last_ok_at    timestamptz,
  last_error    text
);
alter table public.pipeline_sync_state enable row level security;   -- no policies
revoke all on table public.pipeline_sync_state from public, anon, authenticated, service_role;   -- writes only through the functions below
grant select on table public.pipeline_sync_state to service_role;
insert into public.pipeline_sync_state (job) select job from public.pipeline_sync_settings on conflict (job) do nothing;

-- one row per run (runs that found nothing new are kept 3 days, the rest 45)
create table if not exists public.pipeline_sync_runs (
  id         bigint generated always as identity primary key,
  job        text not null,
  at         timestamptz not null default now(),
  mode       text not null,
  run_by     text,
  status     text not null,   -- saved, unchanged, compared, waiting, partial, error, busy, settings
  ms         int,
  n_rows     int,
  comparable boolean,         -- shadow: the table was written from the same version of the source
  diff       jsonb,           -- shadow: counts and a sample of the differences
  report     jsonb,
  error      text
);
create index if not exists pipeline_sync_runs_job_at on public.pipeline_sync_runs (job, at desc);
revoke all on sequence public.pipeline_sync_runs_id_seq from public, anon, authenticated;
alter table public.pipeline_sync_runs enable row level security;   -- no policies
revoke all on table public.pipeline_sync_runs from public, anon, authenticated, service_role;   -- writes only through the functions below
grant select on table public.pipeline_sync_runs to service_role;

-- the sha256 of the header secret the cron jobs send; set by supabase/postgres/pipeline-sync-cron.sql, which keeps
-- the secret itself only in Vault
create table if not exists public.pipeline_sync_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.pipeline_sync_secret enable row level security;   -- no policies: nobody reads it
revoke all on table public.pipeline_sync_secret from public, anon, authenticated, service_role;

-- the cron job's header, checked by the functions
create or replace function public.pipeline_sync_check_secret(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(length(p_secret) >= 32, false)
     and exists (select 1 from public.pipeline_sync_secret s
                  where s.token_hash = encode(sha256(convert_to(p_secret, 'utf8')), 'hex'));
$$;
revoke all on function public.pipeline_sync_check_secret(text) from public, anon, authenticated;
grant execute on function public.pipeline_sync_check_secret(text) to service_role;

-- a pipeline admin: pipeline_is_admin() from pipeline-admin.sql (a universal admin, or a pipeline editor marked admin);
-- universal admins only, should that file not be applied yet
create or replace function public.pipeline_sync_can_admin()
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  begin
    return coalesce(public.pipeline_is_admin(), false);
  exception when undefined_function then
    return coalesce(public.is_universal_admin(), false);
  end;
end $$;
revoke all on function public.pipeline_sync_can_admin() from public, anon;
grant execute on function public.pipeline_sync_can_admin() to authenticated, service_role;

-- A run asks to hold the job. 'off' and 'busy' (another run holds it, and has not gone quiet for p_stale_seconds)
-- come back at once. p_force_shadow: a compare-only run, whatever the mode.
create or replace function public.pipeline_sync_claim(p_job text, p_stale_seconds int, p_by text, p_force_shadow boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.pipeline_sync_settings; st public.pipeline_sync_state; v_mode text; v_token uuid := gen_random_uuid(); v_src text;
begin
  select * into s from public.pipeline_sync_settings where job = p_job;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  v_mode := case when coalesce(p_force_shadow, false) then 'shadow' else s.mode end;
  if v_mode = 'off' then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  insert into public.pipeline_sync_state (job) values (p_job) on conflict (job) do nothing;
  update public.pipeline_sync_state t
     set running_since = now(), run_token = v_token, run_mode = v_mode, run_by = left(p_by, 200)
   where t.job = p_job
     and (t.running_since is null
          or t.running_since < now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 600), 60)))
  returning * into st;
  if not found then
    insert into public.pipeline_sync_runs (job, mode, run_by, status) values (p_job, v_mode, left(p_by, 200), 'busy');
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  v_src := s.source_id;
  if v_src is null and p_job = 'marks' then v_src := public.schedule_board_ca_workbook(); end if;
  return jsonb_build_object('ok', true, 'token', v_token, 'mode', v_mode, 'source_id', v_src,
    'state', jsonb_build_object('source_sig', st.source_sig, 'written_sig', st.written_sig, 'rows_sig', st.rows_sig,
                                'compared_sig', st.compared_sig, 'cache', st.cache));
end $$;
revoke all on function public.pipeline_sync_claim(text, int, text, boolean) from public, anon, authenticated;
grant execute on function public.pipeline_sync_claim(text, int, text, boolean) to service_role;

-- The run lets go of the job, keeps what the next run needs (p_state: source_sig, written_sig, rows_sig, compared_sig,
-- cache; a key left out keeps its value) and logs itself. A run whose hold was taken over is logged but changes nothing.
create or replace function public.pipeline_sync_finish(p_job text, p_token uuid, p_report jsonb, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text := left(coalesce(p_report->>'status', 'error'), 40); v_mode text; v_by text; v_mine boolean;
        p jsonb := coalesce(p_state, '{}'::jsonb);
begin
  select run_mode, run_by into v_mode, v_by from public.pipeline_sync_state where job = p_job and run_token = p_token;
  v_mine := found;
  if v_mine then
    update public.pipeline_sync_state t set
      running_since = null, run_token = null, run_mode = null, run_by = null,
      source_sig   = case when p ? 'source_sig'   then p->>'source_sig'   else t.source_sig end,
      written_sig  = case when p ? 'written_sig'  then p->>'written_sig'  else t.written_sig end,
      rows_sig     = case when p ? 'rows_sig'     then p->>'rows_sig'     else t.rows_sig end,
      compared_sig = case when p ? 'compared_sig' then p->>'compared_sig' else t.compared_sig end,
      cache        = case when p ? 'cache'        then p->'cache'         else t.cache end,
      last_run_at = now(), last_status = v_status,
      last_ok_at = case when v_status <> 'error' then now() else t.last_ok_at end,
      last_error = case when v_status = 'error' then left(p_report->>'error', 1000) end
    where t.job = p_job and t.run_token = p_token;
  end if;
  insert into public.pipeline_sync_runs (job, mode, run_by, status, ms, n_rows, comparable, diff, report, error)
  values (p_job, coalesce(v_mode, left(p_report->>'mode', 20), '?'), v_by, v_status,
          case when p_report->>'ms' ~ '^[0-9]{1,9}$' then (p_report->>'ms')::int end,
          case when p_report->>'rows' ~ '^[0-9]{1,9}$' then (p_report->>'rows')::int end,
          case when jsonb_typeof(p_report->'comparable') = 'boolean' then (p_report->>'comparable')::boolean end,
          p_report->'diff', (coalesce(p_report, '{}'::jsonb) - 'diff') || jsonb_build_object('late', not v_mine),
          left(p_report->>'error', 1000));
  delete from public.pipeline_sync_runs r
   where r.job = p_job
     and ((r.status in ('unchanged', 'busy') and r.at < now() - interval '3 days') or r.at < now() - interval '45 days');
  return jsonb_build_object('ok', true, 'mine', v_mine);
end $$;
revoke all on function public.pipeline_sync_finish(text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pipeline_sync_finish(text, uuid, jsonb, jsonb) to service_role;

-- What the table holds now, for a shadow comparison (and the meta row, to tell which version of the source it is from)
create or replace function public.pipeline_sync_live(p_job text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case p_job
    when 'marks' then jsonb_build_object(
      'meta', (select to_jsonb(m) from public.pipeline_marks_meta m where m.id = 1),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.r, x.c) from public.pipeline_marks x), '[]'::jsonb))
    when 'trims' then jsonb_build_object(
      'meta', (select to_jsonb(m) from public.pipeline_trims_meta m where m.id = 1),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.file, x.tab, x.block, x.line) from public.pipeline_trims x), '[]'::jsonb))
    when 'batches' then jsonb_build_object(
      'meta', (select to_jsonb(m) from public.pipeline_batches_meta m where m.id = 1),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.sheet_row) from public.pipeline_batches x), '[]'::jsonb))
  end;
$$;
revoke all on function public.pipeline_sync_live(text) from public, anon, authenticated;
grant execute on function public.pipeline_sync_live(text) to service_role;

/* ---- the writes: each job's *_save body without its token check. Nobody may call these directly; only
   pipeline_sync_apply, for the run that holds the job in write mode. ---- */

create or replace function public.pipeline_marks_apply(p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be the list of red cells'; end if;
    if exists (select 1 from jsonb_array_elements(p_rows) x
               where coalesce(x->>'r', '') !~ '^[0-9]+$' or coalesce(x->>'c', '') !~ '^[0-9]+$' or x->>'txt' is null) then
      raise exception 'every mark needs r, c and txt';
    end if;
    insert into public.pipeline_marks as m (r, c, fill, text, part, strike, txt)
    select (x->>'r')::int, (x->>'c')::int, coalesce((x->>'fill')::boolean, false), coalesce((x->>'text')::boolean, false),
           coalesce((x->>'part')::boolean, false), coalesce((x->>'strike')::boolean, false), x->>'txt'
      from jsonb_array_elements(p_rows) x
    on conflict (r, c) do update set fill = excluded.fill, text = excluded.text, part = excluded.part,
      strike = excluded.strike, txt = excluded.txt;
    get diagnostics n = row_count;
    -- cells no longer red (or emptied) are the ones not sent this time
    delete from public.pipeline_marks m
     where not exists (select 1 from jsonb_array_elements(p_rows) x where (x->>'r')::int = m.r and (x->>'c')::int = m.c);
  end if;
  insert into public.pipeline_marks_meta as m (id, synced_at, changed_at, sheet_modified, marks)
  values (1, now(), case when p_rows is not null then now() end, (p_meta->>'sheet_modified')::timestamptz,
          case when p_rows is not null then n end)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_rows is not null then now() else m.changed_at end,
    sheet_modified = coalesce(excluded.sheet_modified, m.sheet_modified),
    marks = coalesce(excluded.marks, m.marks);
  return jsonb_build_object('ok', true, 'marks', n);
end $$;
revoke all on function public.pipeline_marks_apply(jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function public.pipeline_trims_apply(p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int := 0; n_del int := 0;
begin
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
revoke all on function public.pipeline_trims_apply(jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function public.pipeline_batches_apply(p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int := 0; n_del int := 0;
begin
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
revoke all on function public.pipeline_batches_apply(jsonb, jsonb) from public, anon, authenticated, service_role;

-- The only way the functions write: refused unless p_token is the run holding the job in write mode right now (a
-- shadow run, a run whose hold was taken over, or a job switched off mid-run writes nothing).
create or replace function public.pipeline_sync_apply(p_job text, p_token uuid, p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.pipeline_sync_state t join public.pipeline_sync_settings s on s.job = t.job
   where t.job = p_job and t.run_token = p_token and t.run_mode = 'write' and s.mode = 'write'
   for share of t, s;
  if not found then raise exception 'pipeline sync %: this run may not write (not the running write-mode run)', p_job; end if;
  if p_job = 'marks' then return public.pipeline_marks_apply(p_rows, p_meta);
  elsif p_job = 'trims' then return public.pipeline_trims_apply(p_rows, p_meta);
  elsif p_job = 'batches' then return public.pipeline_batches_apply(p_rows, p_meta);
  end if;
  raise exception 'pipeline sync: no such job %', p_job;
end $$;
revoke all on function public.pipeline_sync_apply(text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pipeline_sync_apply(text, uuid, jsonb, jsonb) to service_role;

/* ---- for pipeline admins (the admin page) ---- */

-- p_mode: 'off', 'shadow' or 'write' (null keeps it). p_source_id: the Drive id, or the file's or folder's address
-- (null keeps it, '' clears it).
-- A new mode or id starts clean: the first write run writes the whole set, a shadow run compares again.
create or replace function public.pipeline_sync_set(p_job text, p_mode text, p_source_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare old public.pipeline_sync_settings; v_email text := nullif(public.pipeline_jwt_email(), '');
        v_mode text; v_src text; v_src_changed boolean; v_in text := btrim(p_source_id);
begin
  if not (public.pipeline_sync_can_admin() or session_user in ('postgres', 'pipeline_owner')) then
    raise exception 'only a pipeline admin can change the sync jobs';
  end if;
  select * into old from public.pipeline_sync_settings where job = p_job for update;
  if not found then raise exception 'no sync job called %', p_job; end if;
  if p_mode is not null and p_mode not in ('off', 'shadow', 'write') then raise exception 'mode must be off, shadow or write'; end if;
  if v_in ~* '^https?://' then   -- an address pasted whole: .../d/<id>/..., .../folders/<id>, ...?id=<id>
    v_in := coalesce(substring(v_in from '/(?:d|folders)/([A-Za-z0-9_-]{10,200})'), substring(v_in from '[?&]id=([A-Za-z0-9_-]{10,200})'), v_in);
  end if;
  if v_in is not null and v_in <> '' and v_in !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception 'that is not a Google Drive id (the part of the address after /d/ or /folders/)';
  end if;
  v_mode := coalesce(p_mode, old.mode);
  v_src := case when v_in is null then old.source_id when v_in = '' then null else v_in end;
  v_src_changed := v_src is distinct from old.source_id;
  update public.pipeline_sync_settings set mode = v_mode, source_id = v_src, updated_at = now(),
         updated_by = coalesce(v_email, session_user::text)
   where job = p_job;
  if v_mode is distinct from old.mode or v_src_changed then
    update public.pipeline_sync_state
       set written_sig = null, rows_sig = null, compared_sig = null, cache = case when v_src_changed then null else cache end
     where job = p_job;
  end if;
  insert into public.pipeline_sync_runs (job, mode, run_by, status, report)
  values (p_job, v_mode, coalesce(v_email, session_user::text), 'settings',
          jsonb_build_object('mode_from', old.mode, 'mode_to', v_mode, 'source_changed', v_src_changed, 'source_set', v_src is not null));
  return jsonb_build_object('ok', true, 'job', p_job, 'mode', v_mode, 'source_set', v_src is not null);
end $$;
revoke all on function public.pipeline_sync_set(text, text, text) from public, anon;
grant execute on function public.pipeline_sync_set(text, text, text) to authenticated, service_role;

-- each job's mode, whether its Drive id is set (only its last 6 characters are shown), whether a run holds it, how the
-- last runs went, and how fresh its table is
create or replace function public.pipeline_sync_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.pipeline_sync_can_admin() or session_user in ('postgres', 'pipeline_owner')) then
    raise exception 'only a pipeline admin can see the sync jobs';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'job', s.job, 'mode', s.mode, 'source_set', s.source_id is not null, 'source_end', right(s.source_id, 6),
      'updated_at', s.updated_at, 'updated_by', s.updated_by,
      'running_since', t.running_since, 'last_run_at', t.last_run_at, 'last_status', t.last_status,
      'last_ok_at', t.last_ok_at, 'last_error', t.last_error,
      'synced_at', case s.job when 'marks' then (select m.synced_at from public.pipeline_marks_meta m where m.id = 1)
                              when 'trims' then (select m.synced_at from public.pipeline_trims_meta m where m.id = 1)
                              when 'batches' then (select m.synced_at from public.pipeline_batches_meta m where m.id = 1) end,
      'runs', (select coalesce(jsonb_agg(to_jsonb(r) - 'report' order by r.at desc), '[]'::jsonb)
                 from (select * from public.pipeline_sync_runs x where x.job = s.job and x.status <> 'unchanged'
                        order by x.at desc limit 20) r)
    ) order by s.job), '[]'::jsonb)
    from public.pipeline_sync_settings s left join public.pipeline_sync_state t on t.job = s.job);
end $$;
revoke all on function public.pipeline_sync_status() from public, anon;
grant execute on function public.pipeline_sync_status() to authenticated, service_role;

reset role;
