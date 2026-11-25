-- Veg in Metrc, for the Cultivation app's Overview (Gianni, 2026-11-25: "are the veg rooms tracked in METRC? We might as
-- well include them on the overview too", then "Yes, add veg"). Applied from Gianni's Mac with
-- node ~/claude-sql/run-sql-ca.mjs supabase/cult-veg.sql (not pipeline_* tables: never by the Pipeline deploy). Safe to
-- run again.
--   cult_metrc_veg: what each license has in veg now, by Metrc location, kind, strain and planted day: 'clones' are the
--   plant batches still active (Metrc counts them, untagged: UntrackedCount), 'plants' the tagged plants still in veg.
--   Mothers are flowering plants in a mom location, so they come with cult_metrc_plants. Written only by
--   cult_metrc_veg_save() from ~/ar-automation/cult-veg-sync.mjs (every 3 hours, after the plant job), each license's
--   set replaced whole. cult_metrc_veg_meta: when each license was last read and what went wrong.
create table if not exists public.cult_metrc_veg (
  license   text not null,
  location  text not null check (length(location) between 1 and 80),
  kind      text not null check (kind in ('clones', 'plants')),
  strain    text not null check (length(strain) between 1 and 80),
  planted   date not null default '1900-01-01',
  count     int not null check (count > 0 and count < 1000000),
  primary key (license, location, kind, strain, planted)
);
alter table public.cult_metrc_veg enable row level security;
drop policy if exists cult_metrc_veg_select on public.cult_metrc_veg;
create policy cult_metrc_veg_select on public.cult_metrc_veg for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_metrc_veg from anon, authenticated;   -- written by cult_metrc_veg_save()

create table if not exists public.cult_metrc_veg_meta (
  license      text primary key,
  synced_at    timestamptz not null default now(),
  covered_to   timestamptz,
  note         text check (length(note) <= 500)
);
alter table public.cult_metrc_veg_meta enable row level security;
drop policy if exists cult_metrc_veg_meta_select on public.cult_metrc_veg_meta;
create policy cult_metrc_veg_meta_select on public.cult_metrc_veg_meta for select to authenticated using (public.cult_can_view());
revoke insert, update, delete on table public.cult_metrc_veg_meta from anon, authenticated;

-- p_meta: [{license, covered_to, note}] for the licenses read this run; each one's rows in p_rows replace its set whole
-- ([] for a license empties it). Token first, like every cult_metrc_* save.
create or replace function public.cult_metrc_veg_save(p_token text, p_meta jsonb, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m jsonb; rw jsonb; lic text;
begin
  if not exists (select 1 from public.cult_job_secret where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if jsonb_typeof(p_meta) is distinct from 'array' or jsonb_array_length(p_meta) = 0 or jsonb_array_length(p_meta) > 20 then raise exception 'p_meta must list 1 to 20 licenses'; end if;
  for m in select e from jsonb_array_elements(p_meta) e loop
    if jsonb_typeof(m) <> 'object' or coalesce(m->>'license', '') !~ '^[A-Z0-9]{2,6}-[0-9A-Z-]{5,24}$' then raise exception 'a license is not a license number'; end if;
    if coalesce(jsonb_typeof(m->'covered_to'), 'null') <> 'null' and (m->>'covered_to') !~ '^\d{4}-\d{2}-\d{2}T' then raise exception 'covered_to must be a time'; end if;
    if coalesce(jsonb_typeof(m->'note'), 'null') not in ('string', 'null') or length(coalesce(m->>'note', '')) > 500 then raise exception 'a note is up to 500 characters'; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_meta)) <> (select count(distinct e->>'license') from jsonb_array_elements(p_meta) e) then raise exception 'a license is listed twice'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 20000 then raise exception 'p_rows must be a list of up to 20000'; end if;
  for rw in select e from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(rw) <> 'object' or not exists (select 1 from jsonb_array_elements(p_meta) x where x->>'license' = rw->>'license') then raise exception 'a row''s license is not in p_meta'; end if;
    if jsonb_typeof(rw->'location') is distinct from 'string' or length(btrim(rw->>'location')) not between 1 and 80 then raise exception 'a row needs a location of 1 to 80 characters'; end if;
    if coalesce(rw->>'kind', '') not in ('clones', 'plants') then raise exception 'kind is clones or plants'; end if;
    if jsonb_typeof(rw->'strain') is distinct from 'string' or length(btrim(rw->>'strain')) not between 1 and 80 then raise exception 'a row needs a strain of 1 to 80 characters'; end if;
    if coalesce(jsonb_typeof(rw->'planted'), 'null') <> 'null' and coalesce(rw->>'planted', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'planted must be a date'; end if;
    if coalesce(rw->>'count', '') !~ '^[1-9]\d{0,5}$' then raise exception 'count must be a whole number above 0'; end if;
  end loop;
  for lic in select e->>'license' from jsonb_array_elements(p_meta) e loop
    delete from public.cult_metrc_veg v where v.license = lic;
    insert into public.cult_metrc_veg (license, location, kind, strain, planted, count)
    select lic, btrim(j->>'location'), j->>'kind', btrim(j->>'strain'), coalesce((j->>'planted')::date, '1900-01-01'), sum((j->>'count')::int)
      from jsonb_array_elements(p_rows) j where j->>'license' = lic
     group by btrim(j->>'location'), j->>'kind', btrim(j->>'strain'), coalesce((j->>'planted')::date, '1900-01-01');
  end loop;
  insert into public.cult_metrc_veg_meta as t (license, synced_at, covered_to, note)
  select e->>'license', now(), (e->>'covered_to')::timestamptz, nullif(e->>'note', '') from jsonb_array_elements(p_meta) e
  on conflict (license) do update set synced_at = now(), covered_to = excluded.covered_to, note = excluded.note;
  return jsonb_build_object('ok', true, 'v', 1, 'rows', (select count(*) from public.cult_metrc_veg));
end $$;
revoke all on function public.cult_metrc_veg_save(text, jsonb, jsonb) from public;
grant execute on function public.cult_metrc_veg_save(text, jsonb, jsonb) to anon, authenticated;
