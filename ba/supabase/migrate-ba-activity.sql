-- ── Post-visit form responses (BA retailer visit form) ──────────────────────
-- Synced from the "WIZARD TREES RETAILER VISIT FORM (Responses)" sheet by
-- ~/ba-forms/sync.mjs. One row per submission; store resolved to the central
-- registry (dispensaries) so the calendar can pair a response with its visit.
create table if not exists public.ba_activity (
  id             uuid primary key default gen_random_uuid(),
  source         text not null default 'form',
  source_key     text not null,                         -- timestamp|rep|store — idempotency key
  submitted_at   timestamptz,
  visit_date     date,                                  -- parsed from the free-text answer, else the submission date
  rep_name       text,
  rep_email      text,
  state          text,
  store_raw      text,                                  -- exactly what the BA typed
  dispensary_id  uuid references public.dispensaries(id),
  activities     text,
  promo          text,
  aged_product   text,
  brand_presence text,
  manager        text,
  photos         text,
  traffic        text,
  est_units      text,
  stock_status   text,
  connected_with text,
  next_steps     text,
  raw            jsonb,
  synced_at      timestamptz not null default now(),
  unique (source, source_key)
);
create index if not exists ba_activity_date_idx on public.ba_activity(visit_date);
create index if not exists ba_activity_disp_idx on public.ba_activity(dispensary_id);
alter table public.ba_activity enable row level security;

-- readable by anyone signed into the BA app (it's the team's own field reporting);
-- writes only from the service role (the sync job) — no client-side write policy.
drop policy if exists ba_activity_select on public.ba_activity;
create policy ba_activity_select on public.ba_activity for select to authenticated using (true);

-- public projection for the sales web app (anon): no emails, no raw payload
create or replace function public.ba_activity_feed()
returns table(visit_date date, dispensary_id uuid, store_raw text, rep_name text,
              activities text, promo text, aged_product text, brand_presence text,
              stock_status text, next_steps text, traffic text, est_units text)
language sql stable security definer set search_path=public as $$
  select visit_date, dispensary_id, store_raw, rep_name, activities, promo, aged_product,
         brand_presence, stock_status, next_steps, traffic, est_units
  from public.ba_activity
  where visit_date >= current_date - 400
  order by visit_date desc;
$$;
grant execute on function public.ba_activity_feed() to anon, authenticated;
