-- BA app: store planning (Gianni 2026-11-21: "Ya, do all that", after looking at Amanda's Field Planner).
-- Brings her planner into the BA app on live data. Safe to run again.
--   1. store_plan          a store's planning profile: territory, the BAs who cover it, sample rules,
--                          promo days, demo booking link and contact, notes (managers edit, staff read)
--   2. store_sales         6-month net sales per sales account, written by the sales app's own numbers
--                          (~/ar-automation/lib/store-sales-feed.mjs); managers only
--   3. store_visit_summary last visit, EDU and PAD days per store from what the BAs logged
--   4. schedule_tasks      + task_time, booking (needs | confirmed), title
--   5. ba_activity         + the in-app post-visit report (ba_report_submit), linked to its task
--   6. schedule_task_digest + the 9 AM "Your tasks" email (ba-notify job 'tasks')
--   7. storage_report_photos_read: a report's photos open for everyone on its board
-- Run after ba-schedule-task-status.sql: both define schedule_restore_rows, and this one's carries the new columns.

-- ── 1. store profile ────────────────────────────────────────────────────────────────────────────
create table if not exists public.store_plan (
  dispensary_id uuid primary key references public.dispensaries(id) on delete cascade,
  territory     text,
  team          text[] not null default '{}',   -- schedule names, as the Schedule writes them (Ledy, Makenna)
  sample_rules  text[] not null default '{}',   -- hand | metrc | offsite
  promo_days    text[] not null default '{}',   -- Mon .. Sun
  demo_link     text,
  demo_contact  text,
  notes         text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
alter table public.store_plan enable row level security;
-- seen by whoever may see the store (the registry's own rules, read through the subquery)
drop policy if exists store_plan_select on public.store_plan;
create policy store_plan_select on public.store_plan for select to authenticated
  using (exists (select 1 from public.dispensaries d where d.id = store_plan.dispensary_id));
-- changed by managers: universal admins anywhere, regional admins in their own state
drop policy if exists store_plan_insert on public.store_plan;
create policy store_plan_insert on public.store_plan for insert to authenticated
  with check (public.is_universal_admin() or (public.is_admin() and exists (
    select 1 from public.dispensaries d where d.id = store_plan.dispensary_id and d.state = public.admin_region())));
drop policy if exists store_plan_update on public.store_plan;
create policy store_plan_update on public.store_plan for update to authenticated
  using (public.is_universal_admin() or (public.is_admin() and exists (
    select 1 from public.dispensaries d where d.id = store_plan.dispensary_id and d.state = public.admin_region())))
  with check (public.is_universal_admin() or (public.is_admin() and exists (
    select 1 from public.dispensaries d where d.id = store_plan.dispensary_id and d.state = public.admin_region())));
revoke delete on public.store_plan from anon, authenticated;
revoke all on public.store_plan from anon;

-- ── 2. 6-month sales per sales account (the sales app's Customers numbers) ───────────────────────
create table if not exists public.store_sales (
  state       text not null,
  sales_key   text not null,          -- tierNorm of the sales account name = dispensaries.sales_key
  name        text,
  net         numeric,
  orders      integer,
  first_order date,
  last_order  date,
  channel     text,
  window_from date,
  window_to   date,
  updated_at  timestamptz not null default now(),
  primary key (state, sales_key)
);
-- the board's stores the sales app itself links to this account (its regFor: the registry's name, sales key,
-- Pistil name and aliases, tierNorm'd), so a store whose sales key is typed differently still finds its sales;
-- null on a snapshot saved without them (the page then joins on sales_key alone)
alter table public.store_sales add column if not exists dispensary_ids uuid[];
alter table public.store_sales enable row level security;
drop policy if exists store_sales_select on public.store_sales;
create policy store_sales_select on public.store_sales for select to authenticated
  using (public.is_universal_admin() or (public.is_admin() and state = public.admin_region()));
revoke all on public.store_sales from anon;
revoke insert, update, delete on public.store_sales from authenticated;

create table if not exists public.store_sales_secret (id int primary key default 1, token_hash text not null);
alter table public.store_sales_secret enable row level security;
revoke all on public.store_sales_secret from anon, authenticated;

-- the feed replaces one state's snapshot at a time; an empty list is refused (a parse problem, not "no sales")
create or replace function public.store_sales_save(p_token text, p_state text, p_from date, p_to date, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not exists (select 1 from public.store_sales_secret
                 where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_state not in ('CA','NY','FL') then raise exception 'unknown state %', p_state; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'no rows: refusing to empty %', p_state; end if;
  delete from public.store_sales where state = p_state;
  -- two sales-app rows that reduce to one key are one account: add them up. A row's ids (the stores the sales
  -- app links to it) keep only real stores of this state; rows sent without ids leave dispensary_ids null.
  insert into public.store_sales (state, sales_key, name, net, orders, first_order, last_order, channel, window_from, window_to,
                                  updated_at, dispensary_ids)
  select p_state, g.k, g.nm, g.net, g.orders, g.f, g.l, g.ch, p_from, p_to, now(),
         case when g.has_ids then coalesce((select array_agg(d.id order by d.id) from public.dispensaries d
                                             where d.state = p_state
                                               and d.id::text in (select jsonb_array_elements_text(e) from unnest(g.idsets) e)), '{}') end
    from (select k, (array_agg(nm order by net desc nulls last))[1] as nm, sum(net) as net, sum(orders)::int as orders,
                 min(f) as f, max(l) as l, string_agg(distinct ch, ' + ') as ch, bool_or(has_ids) as has_ids, array_agg(ids) as idsets
            from (select r->>'sales_key' as k, r->>'name' as nm, nullif(r->>'net','')::numeric as net,
                         nullif(r->>'orders','')::int as orders, nullif(r->>'first','')::date as f, nullif(r->>'last','')::date as l,
                         nullif(r->>'channel','') as ch, jsonb_typeof(r->'ids') = 'array' as has_ids,
                         case when jsonb_typeof(r->'ids') = 'array' then r->'ids' else '[]'::jsonb end as ids
                    from jsonb_array_elements(p_rows) r) x
           where coalesce(k, '') <> ''
           group by k) g;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'state', p_state, 'rows', v_n);
end $$;
revoke all on function public.store_sales_save(text, text, date, date, jsonb) from public;
grant execute on function public.store_sales_save(text, text, date, date, jsonb) to anon, authenticated;

-- ── 3. what the BAs logged at each store ───────────────────────────────────────────────────────
-- One row per store of the board with a trip, hours or a post-visit report since p_since: the last day
-- anyone was there, how many days, the last EDU and PAD day and how many, and who was there last.
-- The general-activity placeholders ("* General BA activity" and the like) are not stores.
-- A trip or hours counts only when its kind names a visit (Store visit, Demo / PAD, Education talk, a
-- training, Brand event): a delivery, sales call, lead, travel or admin stop is not a visit. Every
-- post-visit report counts. Nothing dated after the board's own today counts (Pacific for CA, Eastern for
-- NY and FL): hours drafts can be entered days ahead, and nobody has been there yet.
create or replace function public.store_visit_summary(p_state text, p_since date default null)
returns table(dispensary_id uuid, last_visit date, visits integer, last_edu date, edu integer,
              last_pad date, pad integer, last_by text)
language sql stable security definer set search_path = public as $$
  with b as (
    select (now() at time zone case when p_state in ('NY','FL') then 'America/New_York'
                                    else 'America/Los_Angeles' end)::date as today
  ), ev as (
    select t.dispensary_id as d, t.trip_date as day, t.ba_id as who, null::text as rep, lower(coalesce(t.kind, '')) as kind
      from public.trips t, b
     where t.trip_date >= coalesce(p_since, current_date - 365) and t.trip_date <= b.today and t.dispensary_id is not null
       and coalesce(t.status, '') <> 'rejected'
       and lower(coalesce(t.kind, '')) ~ 'store visit|demo|\mpads?\M|educat|\medu\M|training|brand event'
    union all
    select x.d, h.work_date, h.ba_id, null, lower(coalesce(h.kind, ''))
      from public.hours h
      cross join b
      cross join lateral unnest(case when coalesce(cardinality(h.dispensary_ids), 0) > 0 then h.dispensary_ids
                                     else array[h.dispensary_id] end) as x(d)
     where h.work_date >= coalesce(p_since, current_date - 365) and h.work_date <= b.today and x.d is not null
       and coalesce(h.status, '') <> 'rejected'
       and lower(coalesce(h.kind, '')) ~ 'store visit|demo|\mpads?\M|educat|\medu\M|training|brand event'
    union all
    select a.dispensary_id, a.visit_date, null, a.rep_name, lower(coalesce(a.activities, ''))
      from public.ba_activity a, b
     where a.visit_date >= coalesce(p_since, current_date - 365) and a.visit_date <= b.today and a.dispensary_id is not null
  ), j as (
    select ev.*, coalesce(p.full_name, ev.rep) as by_name
      from ev join public.dispensaries d on d.id = ev.d
      left join public.profiles p on p.id = ev.who
     where d.state = p_state and d.name !~ '^\*\s'
  )
  select j.d, max(j.day), count(distinct j.day)::int,
         max(j.day) filter (where j.kind ~ 'educat|\medu\M|training'),
         (count(distinct j.day) filter (where j.kind ~ 'educat|\medu\M|training'))::int,
         max(j.day) filter (where j.kind ~ '\mpads?\M|demo'),
         (count(distinct j.day) filter (where j.kind ~ '\mpads?\M|demo'))::int,
         (array_agg(j.by_name order by j.day desc) filter (where j.by_name is not null))[1]
    from j
   where p_state = any(public.schedule_states())
   group by j.d;
$$;
revoke all on function public.store_visit_summary(text, date) from public, anon;
grant execute on function public.store_visit_summary(text, date) to authenticated;

-- ── 4. a visit's time and booking, a task's title ─────────────────────────────────────────────────
alter table public.schedule_tasks
  add column if not exists task_time text,   -- 'HH:MM', 24-hour, the board's own time
  add column if not exists booking text,     -- needs | confirmed (visits); null = not tracked
  add column if not exists title text;
alter table public.schedule_tasks drop constraint if exists schedule_tasks_booking_chk;
alter table public.schedule_tasks add constraint schedule_tasks_booking_chk check (booking is null or booking in ('needs','confirmed'));
alter table public.schedule_tasks drop constraint if exists schedule_tasks_time_chk;
alter table public.schedule_tasks add constraint schedule_tasks_time_chk check (task_time is null or task_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- restoring a backup carries the new columns too (same function as ba-schedule-task-status.sql plus these)
create or replace function public.schedule_restore_rows(p_state text, p_rows jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v_added int; v_removed int; v_pre bigint;
begin
  -- break-glass rule: open from SQL (auth.uid() null), admin-only in the app
  if auth.uid() is not null
     and (not public.is_admin() or not (p_state = any(public.schedule_states()))) then
    raise exception 'you cannot restore the % board', p_state;
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'backup rows must be a JSON array'; end if;
  -- a row belonging to another board would silently jump states: refuse the whole restore
  if exists(select 1 from jsonb_array_elements(p_rows) r
             where coalesce(r->>'state', p_state) <> p_state) then
    raise exception 'this backup contains rows from another board';
  end if;

  v_pre := public.schedule_snapshot(p_state, 'pre-restore', p_note);

  -- rows created after the snapshot: soft-delete (recoverable, never destroyed)
  with keep as (select (r->>'id')::uuid as id from jsonb_array_elements(p_rows) r)
  update public.schedule_tasks t set deleted_at = now(), deleted_by = auth.uid()
   where t.state = p_state and t.deleted_at is null
     and t.id not in (select id from keep);
  get diagnostics v_removed = row_count;

  insert into public.schedule_tasks
    (id, task_date, account, inv_total, region, driver, so_num, notes,
     created_by, created_at, updated_at, state, deleted_at, deleted_by,
     kind, done_at, done_by, done_how, done_note, done_on, task_time, booking, title)
  select (r->>'id')::uuid, (r->>'task_date')::date, r->>'account',
         nullif(r->>'inv_total','')::numeric, r->>'region', r->>'driver', r->>'so_num', r->>'notes',
         nullif(r->>'created_by','')::uuid,
         coalesce(nullif(r->>'created_at','')::timestamptz, now()), now(), p_state,
         nullif(r->>'deleted_at','')::timestamptz, nullif(r->>'deleted_by','')::uuid,
         nullif(r->>'kind',''), nullif(r->>'done_at','')::timestamptz, nullif(r->>'done_by','')::uuid,
         nullif(r->>'done_how',''), r->>'done_note', nullif(r->>'done_on','')::date,
         nullif(r->>'task_time',''), nullif(r->>'booking',''), r->>'title'
    from jsonb_array_elements(p_rows) r
  on conflict (id) do update set
     task_date=excluded.task_date, account=excluded.account, inv_total=excluded.inv_total,
     region=excluded.region, driver=excluded.driver, so_num=excluded.so_num, notes=excluded.notes,
     updated_at=now(), deleted_at=excluded.deleted_at, deleted_by=excluded.deleted_by,
     kind=excluded.kind, done_at=excluded.done_at, done_by=excluded.done_by,
     done_how=excluded.done_how, done_note=excluded.done_note, done_on=excluded.done_on,
     task_time=excluded.task_time, booking=excluded.booking, title=excluded.title;
  get diagnostics v_added = row_count;

  return jsonb_build_object('restored', v_added, 'removed', v_removed,
                            'state', p_state, 'undo_backup_id', v_pre);
end $function$;

-- ── 5. the in-app post-visit report ────────────────────────────────────────────────────────────
-- Same table as the Google form's responses (source 'form', ~/ba-forms/sync.mjs), so the calendar's
-- report pairing, the sales app's BA report and every reader keep working. App reports are source 'app'.
alter table public.ba_activity
  add column if not exists task_id uuid,
  add column if not exists staff_trained text,
  add column if not exists topics text,
  add column if not exists reorder text,
  add column if not exists notes text,
  add column if not exists created_by uuid;
create index if not exists ba_activity_task_idx on public.ba_activity (task_id) where task_id is not null;

-- File (or correct) a post-visit report. p: {id?, client_key?, task_id?, dispensary_id?, state?, visit_date?,
-- activities, promo, aged_product, stock_status, brand_presence, manager, connected_with, staff_trained, topics,
-- reorder, traffic, est_units, next_steps, notes, photos}. The reporter is the signed-in person. The report's
-- board is its store's state, else the task's, else p.state, and must be one of the caller's boards (a new
-- login with no board files nothing); a task's report must be for a store on the task's own board. A report
-- for a task marks the task done: as 'report' (what the automatic check also reads) when the task is theirs,
-- as 'marked' when someone files it for another BA. client_key is the page's own key for one Save: sending
-- it again (a retry after a lost answer) returns the first report instead of filing a second. Returns the
-- report's id.
create or replace function public.ba_report_submit(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_me public.profiles; v_task public.schedule_tasks; v_disp public.dispensaries;
        v_id uuid; v_day date; v_mine boolean; v_state text; v_key text;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  select * into v_me from public.profiles where id = v_uid and active;
  if v_me.id is null then raise exception 'no active profile'; end if;
  if nullif(p->>'task_id','') is not null then
    select * into v_task from public.schedule_tasks where id = (p->>'task_id')::uuid and deleted_at is null;
    if v_task.id is null then raise exception 'that task is gone'; end if;
    if not (v_task.state = any(public.schedule_states())) then raise exception 'not your board'; end if;
  end if;
  select * into v_disp from public.dispensaries
   where id = coalesce(nullif(p->>'dispensary_id','')::uuid,
                       case when v_task.id is not null then public.schedule_store(v_task.state, v_task.account) end);
  if v_disp.id is null then raise exception 'pick the store this report is for'; end if;
  v_state := coalesce(v_disp.state, v_task.state, nullif(p->>'state',''));
  if v_state is null or not (v_state = any(public.schedule_states())) then raise exception 'not your board'; end if;
  if v_task.id is not null and v_disp.state is not null and v_disp.state <> v_task.state then
    raise exception 'that store isn''t on this task''s board';
  end if;
  v_day := coalesce(nullif(p->>'visit_date','')::date, v_task.task_date, current_date);
  if v_day > current_date + 1 then raise exception 'a report can''t be for a day that hasn''t happened'; end if;

  if nullif(p->>'id','') is not null then
    -- correcting your own report (an admin may correct the reports of the BAs they manage)
    update public.ba_activity a set
      visit_date = v_day, dispensary_id = v_disp.id, store_raw = v_disp.name, state = v_state,
      activities = p->>'activities', promo = p->>'promo', aged_product = p->>'aged_product',
      stock_status = p->>'stock_status', brand_presence = p->>'brand_presence', manager = p->>'manager',
      connected_with = p->>'connected_with', staff_trained = p->>'staff_trained', topics = p->>'topics',
      reorder = p->>'reorder', traffic = p->>'traffic', est_units = p->>'est_units',
      next_steps = p->>'next_steps', notes = p->>'notes', photos = p->>'photos', synced_at = now()
     where a.id = (p->>'id')::uuid and a.source = 'app'
       and (a.created_by = v_uid or public.admin_sees_ba(a.created_by))
    returning a.id into v_id;
    if v_id is null then raise exception 'that report can''t be changed here'; end if;
  else
    v_id := gen_random_uuid();
    v_key := coalesce(nullif(p->>'client_key',''), v_id::text);
    insert into public.ba_activity (id, source, source_key, submitted_at, visit_date, rep_name, rep_email, state,
      store_raw, dispensary_id, activities, promo, aged_product, brand_presence, manager, photos, traffic,
      est_units, stock_status, connected_with, next_steps, raw, synced_at,
      task_id, staff_trained, topics, reorder, notes, created_by)
    values (v_id, 'app', v_key, now(), v_day, v_me.full_name, v_me.email, v_state,
      v_disp.name, v_disp.id, p->>'activities', p->>'promo', p->>'aged_product', p->>'brand_presence',
      p->>'manager', p->>'photos', p->>'traffic', p->>'est_units', p->>'stock_status', p->>'connected_with',
      p->>'next_steps', jsonb_build_object('app', true), now(),
      v_task.id, p->>'staff_trained', p->>'topics', p->>'reorder', p->>'notes', v_uid)
    -- this Save already reached us (a retry after a lost answer): keep the latest text she typed, on her own
    -- report only; someone else's key is refused
    on conflict (source, source_key) do update set
      visit_date = excluded.visit_date, dispensary_id = excluded.dispensary_id, store_raw = excluded.store_raw,
      state = excluded.state, activities = excluded.activities, promo = excluded.promo,
      aged_product = excluded.aged_product, brand_presence = excluded.brand_presence, manager = excluded.manager,
      photos = excluded.photos, traffic = excluded.traffic, est_units = excluded.est_units,
      stock_status = excluded.stock_status, connected_with = excluded.connected_with, next_steps = excluded.next_steps,
      staff_trained = excluded.staff_trained, topics = excluded.topics, reorder = excluded.reorder,
      notes = excluded.notes, synced_at = now()
      where public.ba_activity.created_by = v_uid and public.ba_activity.task_id is not distinct from excluded.task_id
    returning id into v_id;
    if v_id is null then raise exception 'that report key is already used'; end if;
  end if;

  if v_task.id is not null then
    v_mine := public.schedule_person(v_task.state, v_task.driver) = v_uid;
    update public.schedule_tasks set
      done_at = coalesce(done_at, now()), done_by = case when v_mine then null else v_uid end,
      done_how = case when v_mine and v_disp.id = public.schedule_store(v_task.state, v_task.account)
                       and v_day between task_date and task_date + 2 then 'report' else 'marked' end,
      done_on = case when v_mine then v_day else null end,
      done_note = coalesce(done_note, 'Post-visit report filed'), updated_at = now()
     where id = v_task.id and (done_at is null or done_how in ('trip','hours','report','reopened'));
  end if;
  return v_id;
end $$;
revoke all on function public.ba_report_submit(jsonb) from public, anon;

-- reports (form and app) are read by admins and by the people on that report's board, not by any login
drop policy if exists ba_activity_select on public.ba_activity;
create policy ba_activity_select on public.ba_activity for select to authenticated
  using (public.is_admin() or state = any(public.schedule_states()));
grant execute on function public.ba_report_submit(jsonb) to authenticated;

-- ── 6. the 9 AM "Your tasks" email ──────────────────────────────────────────────────────────────
create table if not exists public.schedule_task_digest_log (
  person_id uuid not null,
  sent_on   date not null,
  task_ids  uuid[] not null default '{}',
  sent_at   timestamptz not null default now(),
  primary key (person_id, sent_on)
);
alter table public.schedule_task_digest_log enable row level security;
revoke all on public.schedule_task_digest_log from anon, authenticated;

-- Who gets a "Your tasks" email today, and what goes in it: new for them (a task of theirs from today on,
-- added or changed in the last 2 days by someone else, that no email of theirs has listed yet: a task
-- reassigned to them counts, however far ahead it is), today's tasks, and trainings and follow-ups past
-- their day that aren't done (visits confirm themselves from what the BAs log, so they're never chased
-- here; past the last 30 days they're left out). Deliveries are left out. People already emailed today are
-- left out. Only the notification function (service role) calls it. updated_at has no trigger: the page
-- sets it on every change it saves, and so do the app's own functions.
-- Replaced by supabase/ba-task-notices.sql (2026-11-23), which adds the new-task email's test to New for you.
-- If this file is run again, run ba-task-notices.sql right after it.
create or replace function public.schedule_task_digest(p_today date)
returns table(person_id uuid, email text, full_name text, state text,
              new_tasks jsonb, today_tasks jsonb, overdue_tasks jsonb)
language sql stable security definer set search_path = public as $$
  with t as (
    select s.*, public.schedule_person(s.state, s.driver) as person,
           coalesce(s.kind, case when nullif(trim(coalesce(s.so_num, '')), '') is null then 'visit' else 'delivery' end) as k
      from public.schedule_tasks s
     where s.deleted_at is null and s.done_at is null and s.task_date >= p_today - 30
  ), j as (
    select t.*, p.email, p.full_name as pname
      from t join public.profiles p on p.id = t.person and p.active and coalesce(p.email, '') <> ''
     where t.k <> 'delivery'
  ), pick as (
    select j.*,
      (j.task_date >= p_today and j.created_by is distinct from j.person
         and greatest(j.created_at, j.updated_at) > now() - interval '2 days'
         and not exists (select 1 from public.schedule_task_digest_log l
                          where l.person_id = j.person and j.id = any(l.task_ids))) as is_new,
      (j.task_date = p_today) as is_today,
      (j.k in ('training','followup') and j.task_date < p_today) as is_overdue
      from j
  ), item as (
    select pick.*, jsonb_build_object('id', pick.id, 'date', pick.task_date, 'time', pick.task_time, 'kind', pick.k,
             'title', pick.title, 'account', pick.account, 'notes', pick.notes, 'booking', pick.booking) as obj
      from pick where pick.is_new or pick.is_today or pick.is_overdue
  )
  select i.person, max(i.email), max(i.pname), max(i.state),
         coalesce(jsonb_agg(i.obj order by i.task_date, i.task_time nulls last) filter (where i.is_new and not i.is_today), '[]'),
         coalesce(jsonb_agg(i.obj order by i.task_time nulls last) filter (where i.is_today), '[]'),
         coalesce(jsonb_agg(i.obj order by i.task_date) filter (where i.is_overdue), '[]')
    from item i
   where not exists (select 1 from public.schedule_task_digest_log l where l.person_id = i.person and l.sent_on = p_today)
   group by i.person;
$$;
revoke all on function public.schedule_task_digest(date) from public, anon, authenticated;
grant execute on function public.schedule_task_digest(date) to service_role;

-- 9 AM Pacific (the function itself checks the hour; two runs cover daylight saving)
select cron.schedule('ba-task-digest', '4 16,17 * * *', $cron$
  select net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
    body := jsonb_build_object('job','tasks'));
$cron$);

-- ── 7. a report's photos open for everyone on its board ─────────────────────────────────────────
-- The in-app report uploads its photos to the private receipts bucket (the uploader's own folder,
-- ba/index.html uploadPhoto) and keeps them as 'sb:receipts/<path>' in ba_activity.photos. Reports are
-- read by every signed-in person, but storage_ba_rw opens a file only to its uploader and
-- storage_admin_read only to admins, so a teammate got "Photo unavailable". This opens a receipts file
-- only when an app report on one of the reader's boards names it, and only when it sits in the report
-- author's own folder: naming someone else's expense receipt in a report opens nothing. Expense receipts
-- stay as they were. (A photo an admin adds while correcting someone's report sits in the admin's folder
-- and opens only for admins; the page has no correction screen yet.)
drop policy if exists storage_report_photos_read on storage.objects;
create policy storage_report_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and exists (
    select 1 from public.ba_activity a
     where a.source = 'app' and a.state = any(public.schedule_states())
       and position('sb:receipts/' || objects.name in coalesce(a.photos, '')) > 0
       and (storage.foldername(objects.name))[1] = a.created_by::text));
