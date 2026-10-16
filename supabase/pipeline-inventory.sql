-- Production Pipeline page (pipeline.html): the Inventory view's on-hand stock.
-- The hourly reports job on Gianni's Mac (~/ar-automation/run-nightly.mjs) already downloads Distru's Inventory Assets
-- report (every package at our distro licence: location, active / allocated quantity, lab state) and Nabis's
-- inventory CSV (every SKU batch at Nabis: available, incoming, outgoing, per warehouse). A follow-on job
-- (~/ar-automation/pipeline-inventory-sync.mjs) reads those two files and sends the rows through
-- pipeline_inventory_save() (token-gated; the token hash is seeded out-of-band, never committed). No prices or costs
-- are stored. Readers: the same accounts as the Batches view (pipeline_can_view(), from pipeline-batches.sql).
-- Safe to re-run.

create table if not exists public.pipeline_inventory (
  src         text not null check (src in ('distru', 'nabis')),
  ref         text not null,                 -- Distru package number; Nabis sku code + batch code
  product     text not null,                 -- as the system names it
  strain      text,                          -- read from the product name
  kind        text not null,                 -- jar, 5pk, 1g, 1.5g, bud (budtender pouch), bulk, vape, other
  unit        text not null,                 -- 'g' (bulk) or 'unit'
  qty         numeric not null default 0,    -- Distru: active quantity; Nabis: available
  held        numeric not null default 0,    -- Distru: selling (allocated to orders); Nabis: outgoing
  incoming    numeric not null default 0,    -- Nabis only
  testing     boolean not null default false,-- Distru: in Testing / Quarantined; Nabis: quarantined
  lab_state   text,                          -- Distru: PASSED / PENDING / NOT_TESTED
  location    text,                          -- Distru location; Nabis warehouse(s) holding it
  batch       text,
  harvest     date,
  weeks_on_hand numeric,                     -- Nabis
  primary key (src, ref)
);
comment on table public.pipeline_inventory is
  'Distru Inventory Assets + Nabis inventory for the Production Pipeline Inventory view. Written by '
  '~/ar-automation/pipeline-inventory-sync.mjs via pipeline_inventory_save(); read by pipeline_can_view() accounts.';
alter table public.pipeline_inventory enable row level security;
drop policy if exists pipeline_inventory_select on public.pipeline_inventory;
create policy pipeline_inventory_select on public.pipeline_inventory
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_inventory_meta (
  id           int primary key default 1 check (id = 1),
  synced_at    timestamptz,     -- the job last ran
  changed_at   timestamptz,     -- a run last changed the rows
  distru_as_of timestamptz,     -- the Distru report's own timestamp
  nabis_as_of  timestamptz      -- when the Nabis file was downloaded
);
alter table public.pipeline_inventory_meta enable row level security;
drop policy if exists pipeline_inventory_meta_select on public.pipeline_inventory_meta;
create policy pipeline_inventory_meta_select on public.pipeline_inventory_meta
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_inventory_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.pipeline_inventory_secret enable row level security;   -- no policies: nobody reads it

-- p_rows: every row of one source (p_src) as it stands now; that source's rows not sent are removed. null = unchanged
-- (only the sync time is stamped). Each source is replaced on its own, so a run that lacks one file keeps the other.
create or replace function public.pipeline_inventory_save(p_token text, p_src text, p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_up int := 0; n_del int := 0;
begin
  if not exists (select 1 from public.pipeline_inventory_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_src is not null and p_src not in ('distru', 'nabis') then raise exception 'p_src must be distru or nabis'; end if;
  if p_rows is not null then
    if p_src is null then raise exception 'p_src is required with p_rows'; end if;
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 5 then
      raise exception 'p_rows must be the full list for %', p_src;   -- a half-read file must not wipe the stock
    end if;
    if exists (select 1 from jsonb_array_elements(p_rows) x
               where coalesce(x->>'ref', '') = '' or coalesce(x->>'product', '') = '' or coalesce(x->>'kind', '') = '' or coalesce(x->>'unit', '') = '') then
      raise exception 'every row needs ref, product, kind and unit';
    end if;
    insert into public.pipeline_inventory as t (src, ref, product, strain, kind, unit, qty, held, incoming, testing, lab_state, location, batch, harvest, weeks_on_hand)
    select p_src, x->>'ref', x->>'product', x->>'strain', x->>'kind', x->>'unit', coalesce((x->>'qty')::numeric, 0),
           coalesce((x->>'held')::numeric, 0), coalesce((x->>'incoming')::numeric, 0), coalesce((x->>'testing')::boolean, false),
           x->>'lab_state', x->>'location', x->>'batch', (x->>'harvest')::date, (x->>'weeks_on_hand')::numeric
      from jsonb_array_elements(p_rows) x
    on conflict (src, ref) do update set product = excluded.product, strain = excluded.strain, kind = excluded.kind,
      unit = excluded.unit, qty = excluded.qty, held = excluded.held, incoming = excluded.incoming, testing = excluded.testing,
      lab_state = excluded.lab_state, location = excluded.location, batch = excluded.batch, harvest = excluded.harvest,
      weeks_on_hand = excluded.weeks_on_hand;
    get diagnostics n_up = row_count;
    delete from public.pipeline_inventory t
     where t.src = p_src and not exists (select 1 from jsonb_array_elements(p_rows) x where x->>'ref' = t.ref);
    get diagnostics n_del = row_count;
  end if;
  insert into public.pipeline_inventory_meta as m (id, synced_at, changed_at, distru_as_of, nabis_as_of)
  values (1, now(), case when p_rows is not null then now() end, (p_meta->>'distru_as_of')::timestamptz, (p_meta->>'nabis_as_of')::timestamptz)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_rows is not null then now() else m.changed_at end,
    distru_as_of = coalesce(excluded.distru_as_of, m.distru_as_of),
    nabis_as_of = coalesce(excluded.nabis_as_of, m.nabis_as_of);
  return jsonb_build_object('ok', true, 'src', p_src, 'upserted', n_up, 'removed', n_del);
end $$;
revoke all on function public.pipeline_inventory_save(text, text, jsonb, jsonb) from public;
grant execute on function public.pipeline_inventory_save(text, text, jsonb, jsonb) to anon, authenticated;
