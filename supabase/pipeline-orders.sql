set role pipeline_owner;
-- Production Pipeline page (pipeline.html), On hand: packaging materials (step 4 of the planning views, Gianni 2026-11-24).
-- The page reads the CA tab of the supplier's Order Tracker (the China orders sheet) straight from Google Sheets, to know
-- which packaging parts are on the way and when they ship. The sheet is shared by link. Its id lives in
-- pipeline_order_source, set by a pipeline admin on the Admin page (Gianni chose to paste it there, so pipeline.html never
-- carries a file id, the repo's rule), and goes only to signed-in accounts that may open the pipeline. This keeps the id
-- out of pipeline.html; it does not make the tracker private (the same id is in the public order-tracker.html).
--   pipeline_order_tracker()                 { id, gid } for pipeline_can_view() callers; null when not set or not allowed
--   pipeline_admin_order_tracker()           admins: whether it is set, the id's last 6 characters, who set it and when
--   pipeline_admin_order_tracker_set(link)   admins: set it from the tab's address ('' clears it); logged in
--                                            pipeline_admin_log as a settings change (never the id)
-- The page downloads the CA tab and keeps only each order's invoice and PO numbers, words, status, dates, transport and
-- quantity; it never shows or keeps the money columns.
-- Needs pipeline-access.sql, pipeline-batches.sql (pipeline_can_view) and pipeline-admin.sql (pipeline_is_admin, the
-- log). Applied by the Pipeline deploy workflow as pipeline_owner (supabase/pipeline-order.txt). Safe to re-run.

create table if not exists public.pipeline_order_source (
  id         smallint primary key default 1 check (id = 1),
  sheet_id   text check (sheet_id ~ '^[A-Za-z0-9_-]{20,200}$'),
  tab_gid    text check (tab_gid ~ '^[0-9]{1,12}$'),
  updated_at timestamptz not null default now(),
  updated_by text
);
comment on table public.pipeline_order_source is
  'The China Order Tracker sheet (its CA tab) that On hand reads for packaging on the way. One row. Set through '
  'pipeline_admin_order_tracker_set() by pipeline admins; read through pipeline_order_tracker().';
alter table public.pipeline_order_source enable row level security;   -- no policies: only the functions below touch it
revoke all on table public.pipeline_order_source from public, anon, authenticated;
insert into public.pipeline_order_source (id) values (1) on conflict (id) do nothing;

create or replace function public.pipeline_order_tracker()
returns json
language sql stable security definer
set search_path = public
as $$
  select json_build_object('id', o.sheet_id, 'gid', o.tab_gid)
    from public.pipeline_order_source o
   where o.id = 1 and o.sheet_id is not null and o.tab_gid is not null
     and public.pipeline_can_view();
$$;
revoke all on function public.pipeline_order_tracker() from public, anon;
grant execute on function public.pipeline_order_tracker() to authenticated;

create or replace function public.pipeline_admin_order_tracker()
returns json
language plpgsql stable security definer
set search_path = public
as $$
declare o public.pipeline_order_source;
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can see this.' using errcode = '42501';
  end if;
  select * into o from public.pipeline_order_source where id = 1;
  return json_build_object(
    'set',        o.sheet_id is not null and o.tab_gid is not null,
    'end',        right(o.sheet_id, 6),
    'updated_at', case when o.updated_by is null then null else o.updated_at end,
    'updated_by', o.updated_by);
end $$;
revoke all on function public.pipeline_admin_order_tracker() from public, anon, service_role;
grant execute on function public.pipeline_admin_order_tracker() to authenticated;

-- The tab's address as the browser shows it (.../d/<id>/edit#gid=<n>), or '' to clear. The gid is required: it names
-- the CA tab. The live WIZARD TREES workbook is refused (it is not the tracker).
create or replace function public.pipeline_admin_order_tracker_set(p_link text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   text := coalesce(nullif(public.pipeline_jwt_email(), ''), 'unknown');
  v_in   text := btrim(coalesce(p_link, ''));
  v_old  public.pipeline_order_source;
  v_id   text;
  v_gid  text;
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can change this.' using errcode = '42501';
  end if;
  select * into v_old from public.pipeline_order_source where id = 1 for update;
  if v_in = '' and v_old.sheet_id is null then
    return public.pipeline_admin_order_tracker();   -- already clear: nothing to change or log
  end if;
  if v_in <> '' then
    v_id  := substring(v_in from '/d/([A-Za-z0-9_-]{20,200})');
    v_gid := substring(v_in from '[#?&]gid=([0-9]{1,12})');
    if v_id is null then
      raise exception 'Open the Order Tracker''s CA tab and paste the address from the browser''s address bar (it has /d/ in it).' using errcode = '22023';
    end if;
    if v_gid is null then
      raise exception 'That address doesn''t name a tab. Click the CA tab first, then copy the address (it ends in gid= and a number).' using errcode = '22023';
    end if;
    if v_id = public.schedule_board_ca_workbook() then
      raise exception 'That''s the WIZARD TREES workbook, not the Order Tracker.' using errcode = '22023';
    end if;
  end if;
  if v_id is not distinct from v_old.sheet_id and v_gid is not distinct from v_old.tab_gid then
    return public.pipeline_admin_order_tracker();   -- the same address again: nothing to change or log
  end if;
  update public.pipeline_order_source
     set sheet_id = v_id, tab_gid = v_gid, updated_at = now(), updated_by = v_me
   where id = 1;
  insert into public.pipeline_admin_log (email, action, before, after)
  values (v_me, 'settings',
          jsonb_build_object('order_tracker', v_old.sheet_id is not null),
          jsonb_build_object('order_tracker', v_id is not null,
                             'order_tracker_changed', v_id is not null and v_old.sheet_id is not null
                                                      and (v_id <> v_old.sheet_id or v_gid is distinct from v_old.tab_gid)));
  return public.pipeline_admin_order_tracker();
end $$;
revoke all on function public.pipeline_admin_order_tracker_set(text) from public, anon, service_role;
grant execute on function public.pipeline_admin_order_tracker_set(text) to authenticated;

reset role;
