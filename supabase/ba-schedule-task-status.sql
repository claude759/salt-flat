-- BA app Schedule: task types and completion (Gianni 2026-11-20, for Amanda: "assigning follow-ups and
-- trainings and tracking when they're done"). Safe to run again.
--
-- A task (schedule_tasks, the app-made rows on the Schedule) gets a type and a done mark:
--   kind      visit | pad | edu | training | followup | delivery   (null = an older task: a visit, or a
--             delivery when it carries an SO#)
--   done_at   when it was marked done; null = still open (overdue once its date has passed)
--   done_by   who marked it (null when the app marked it from what the BA logged)
--   done_how  marked | trip | hours | report; 'reopened' (with done_at null) = someone marked it not
--             done, so the automatic check leaves it alone from then on
--   done_note what the person wrote when marking it
--   done_on   the day the visit happened, for a mark from the BA's records (the task's day for a trip or
--             hours, the day the post-visit report says); empty for a mark made by hand
-- Visits, Demo / PAD and EDU visits mark themselves done when the assigned BA logs a trip or hours at
-- that store on that day, or files the post-visit report for it (visit day up to 2 days on: reps file
-- the next morning). Trainings and follow-ups are only done when someone marks them.

alter table public.schedule_tasks
  add column if not exists kind text,
  add column if not exists done_at timestamptz,
  add column if not exists done_by uuid,
  add column if not exists done_how text,
  add column if not exists done_note text,
  add column if not exists done_on date;

alter table public.schedule_tasks drop constraint if exists schedule_tasks_kind_chk;
alter table public.schedule_tasks add constraint schedule_tasks_kind_chk
  check (kind is null or kind in ('visit','pad','edu','training','followup','delivery'));
alter table public.schedule_tasks drop constraint if exists schedule_tasks_done_how_chk;
alter table public.schedule_tasks add constraint schedule_tasks_done_how_chk
  check (done_how is null or done_how in ('marked','trip','hours','report','reopened'));

create index if not exists schedule_tasks_open_idx on public.schedule_tasks (state, task_date)
  where deleted_at is null and done_at is null;

-- The person a task is assigned to. The Schedule stores a first name as the schedule writes it
-- (schedCanon in ba/index.html: "Ledy" is Leti Granados, "Makenna" also arrives as McKenna); this
-- returns that board's one active person with that first name, else null (no guess on a tie).
create or replace function public.schedule_person(p_state text, p_driver text)
returns uuid language sql stable security definer set search_path = public as $$
  with k as (
    select case
      when n in ('leticia','leti','ledy','leticia (ledy)') then 'ledy'
      when n in ('makennna','makenna','mckenna','mckennna') then 'makenna'
      else n end as k
      from (select lower(regexp_replace(trim(coalesce(p_driver,'')), '\s+', ' ', 'g')) as n) s
  ), cand as (
    select p.id
      from public.profiles p, k
     where p.active
       and (p.region = p_state or p.home_region = p_state)
       and k.k <> '' and position('/' in k.k) = 0 and position(',' in k.k) = 0
       and (case when lower(split_part(trim(p.full_name), ' ', 1)) in ('leti','leticia','ledy') then 'ledy'
                 when lower(split_part(trim(p.full_name), ' ', 1)) in ('makenna','mckenna') then 'makenna'
                 else lower(split_part(trim(p.full_name), ' ', 1)) end = k.k
            or lower(trim(p.full_name)) = k.k)
  )
  select case when (select count(*) from cand) = 1 then (select id from cand) end;
$$;

-- A store name reduced the way the post-visit forms sync matches typed names (normStore in
-- ba/docs/ba-forms-sync.mjs): no trailing [..], & as "and", no (rec)/(med), punctuation as spaces, and
-- without llc, inc, the, dispensary, cannabis, co. "Kolas - ARDEN" and "KOLAS Arden" become one key.
create or replace function public.schedule_store_key(p text)
returns text language sql immutable set search_path = public as $$
  select trim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 replace(lower(regexp_replace(coalesce(p, ''), '\s*\[[^\]]*\]\s*$', '')), '&', ' and '),
                 '\((rec|med)\.?\)', ' ', 'g'),
               '[^a-z0-9]+', ' ', 'g'),
             '\m(llc|inc|the|dispensary|cannabis|co)\M', ' ', 'g'),
           '\s+', ' ', 'g'));
$$;

-- The store a task names, best match first: its exact name, then an exact alias or Pistil name, then the
-- same two with names reduced by schedule_store_key; within each, the board's own store before a store
-- with no state. Only the first kind of match that finds anything counts, and only when it finds exactly
-- one store (a tie is no guess). Never the sales key: one sales key covers every branch of a chain.
create or replace function public.schedule_store(p_state text, p_account text)
returns uuid language sql stable security definer set search_path = public as $$
  with a as (select lower(trim(coalesce(p_account, ''))) as k, public.schedule_store_key(p_account) as nk),
  m as (
    select d.id,
      case
        when lower(trim(d.name)) = a.k then case when d.state = p_state then 1 else 2 end
        when exists (select 1 from unnest(coalesce(d.aliases, '{}'::text[])) x where lower(trim(x)) = a.k)
             or lower(trim(coalesce(d.pistil_name, ''))) = a.k then case when d.state = p_state then 3 else 4 end
        when a.nk <> '' and public.schedule_store_key(d.name) = a.nk then case when d.state = p_state then 5 else 6 end
        when a.nk <> '' and (exists (select 1 from unnest(coalesce(d.aliases, '{}'::text[])) x where public.schedule_store_key(x) = a.nk)
                             or public.schedule_store_key(d.pistil_name) = a.nk) then case when d.state = p_state then 7 else 8 end
      end as tier
      from public.dispensaries d, a
     where a.k <> '' and coalesce(d.active, true) and (d.state = p_state or d.state is null)
  ),
  best as (select min(tier) as t from m where tier is not null)
  select case when (select count(distinct m.id) from m, best where m.tier = best.t) = 1
              then (select m.id from m, best where m.tier = best.t limit 1) end;
$$;

revoke all on function public.schedule_person(text, text) from public, anon, authenticated;
revoke all on function public.schedule_store(text, text) from public, anon, authenticated;
revoke all on function public.schedule_store_key(text) from public, anon, authenticated;

-- Keeps the automatic done marks right. Called by the app when a Schedule or My tasks loads (boards the
-- caller can see only), and every 30 minutes by the timer below (no signed-in user: every board).
--   * an open visit, Demo / PAD or EDU task is marked done when the assigned BA's own records show it:
--     a trip or hours at that store that day, else a post-visit report for that store whose visit day is
--     the task's day or up to 2 days later (one report closes only the latest of that BA's tasks at that
--     store on or before the report's day, as the calendar pairs them); done_on is that visit's day;
--   * a task the records marked done is checked again: a different record updates how and when, no record
--     any more (a trip deleted or rejected, the task moved) opens it again. When the BA or the store can't
--     be told any more (someone left, a store was duplicated), the task is left as it is;
--   * a task someone marked done, or marked not done ('reopened'), is never touched;
--   * only tasks dated up to the board's own today (Pacific for CA, Eastern for NY and FL).
-- Stores are matched as schedule_store does, worked out once for all the tasks (one call per task took
-- about 45 ms, past the 8-second limit on the app's call over a few months).
create or replace function public.schedule_tasks_autocomplete(p_state text default null, p_from date default null, p_to date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer := 0;
        v_to date := least(coalesce(p_to, current_date + 1), current_date + 1);
        v_from date := coalesce(p_from, current_date - 21);
begin
  if auth.uid() is not null and (p_state is null or not (p_state = any(public.schedule_states()))) then
    return 0;
  end if;
  if v_from < v_to - 120 then v_from := v_to - 120; end if;
  with base as (
    select t.id, t.state, t.task_date, t.done_at, t.done_how, t.done_on,
           public.schedule_person(t.state, t.driver) as person,
           lower(trim(coalesce(t.account, ''))) as ak, public.schedule_store_key(t.account) as ank
      from public.schedule_tasks t
     where t.deleted_at is null
       and (p_state is null or t.state = p_state)
       and t.task_date between v_from and v_to + 2
       and coalesce(t.kind, case when nullif(trim(coalesce(t.so_num, '')), '') is null then 'visit' else 'delivery' end)
           in ('visit','pad','edu')
  ), dk as (   -- every active store's names, once: exact (red 0) or reduced (red 1); name (src 0) or alias / Pistil name (src 1)
    select d.id, d.state, 0 as red, 0 as src, lower(trim(d.name)) as key from public.dispensaries d where coalesce(d.active, true)
    union all select d.id, d.state, 0, 1, lower(trim(x)) from public.dispensaries d, unnest(coalesce(d.aliases, '{}'::text[])) x where coalesce(d.active, true)
    union all select d.id, d.state, 0, 1, lower(trim(d.pistil_name)) from public.dispensaries d where coalesce(d.active, true) and coalesce(d.pistil_name, '') <> ''
    union all select d.id, d.state, 1, 0, public.schedule_store_key(d.name) from public.dispensaries d where coalesce(d.active, true)
    union all select d.id, d.state, 1, 1, public.schedule_store_key(x) from public.dispensaries d, unnest(coalesce(d.aliases, '{}'::text[])) x where coalesce(d.active, true)
    union all select d.id, d.state, 1, 1, public.schedule_store_key(d.pistil_name) from public.dispensaries d where coalesce(d.active, true) and coalesce(d.pistil_name, '') <> ''
  ), hits as (   -- tier 1..8 exactly as schedule_store: exact name, exact alias, reduced name, reduced alias; board's state first
    select b.id as task_id, k.id as store_id, 1 + k.red * 4 + k.src * 2 + case when k.state = b.state then 0 else 1 end as tier
      from base b join dk k on (k.state = b.state or k.state is null) and coalesce(k.key, '') <> ''
       and ((k.red = 0 and k.key = b.ak) or (k.red = 1 and k.key = b.ank))
  ), top as (
    select h.task_id, min(h.store_id::text)::uuid as store_id, count(distinct h.store_id) as n
      from hits h join (select task_id, min(tier) as t from hits group by task_id) m on m.task_id = h.task_id and m.t = h.tier
     group by h.task_id
  ), cand as (
    select b.id, b.state, b.task_date, b.done_at, b.done_how, b.done_on, b.person,
           case when s.n = 1 then s.store_id end as store
      from base b left join top s on s.task_id = b.id
  ), chk as (
    select c.* from cand c
     where c.task_date <= v_to
       and c.task_date <= (now() at time zone case when c.state in ('NY','FL') then 'America/New_York'
                                                   else 'America/Los_Angeles' end)::date
       and coalesce(c.done_how, '') <> 'reopened'
       and (c.done_at is null or c.done_how in ('trip','hours','report'))
  ), ev as (
    select c.id, c.task_date, c.done_how, c.done_on,
      (c.person is not null and c.store is not null) as known,
      exists (select 1 from public.trips tr
               where tr.ba_id = c.person and tr.trip_date = c.task_date and tr.dispensary_id = c.store
                 and coalesce(tr.status, '') <> 'rejected') as by_trip,
      exists (select 1 from public.hours h
               where h.ba_id = c.person and h.work_date = c.task_date
                 and (h.dispensary_id = c.store or c.store = any(coalesce(h.dispensary_ids, '{}'::uuid[])))
                 and coalesce(h.status, '') <> 'rejected') as by_hours,
      (select min(a.visit_date) from public.ba_activity a join public.profiles p on p.id = c.person
        where a.dispensary_id = c.store and a.visit_date between c.task_date and c.task_date + 2
          and (lower(coalesce(a.rep_email, '')) = lower(coalesce(p.email, '-'))
               or (coalesce(a.rep_name, '') <> ''
                   and lower(split_part(trim(a.rep_name), ' ', 1)) = lower(split_part(trim(p.full_name), ' ', 1))))
          and not exists (select 1 from cand n
                           where n.person = c.person and n.store = c.store and n.id <> c.id
                             and n.task_date > c.task_date and n.task_date <= a.visit_date)) as report_day
      from chk c
  ), res as (
    select e.id,
      case when not e.known then e.done_how when e.by_trip then 'trip' when e.by_hours then 'hours'
           when e.report_day is not null then 'report' end as how,
      case when not e.known then e.done_on when e.by_trip or e.by_hours then e.task_date else e.report_day end as on_day
      from ev e
  )
  update public.schedule_tasks t
     set done_at = case when r.how is null then null else coalesce(t.done_at, now()) end,
         done_how = r.how, done_on = case when r.how is null then null else r.on_day end,
         done_by = null, updated_at = now()
    from res r
   where r.id = t.id
     and ((t.done_at is null and r.how is not null)
          or (t.done_at is not null and t.done_how in ('trip','hours','report')
              and (t.done_how is distinct from r.how or t.done_on is distinct from r.on_day)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.schedule_tasks_autocomplete(text, date, date) from public, anon;
grant execute on function public.schedule_tasks_autocomplete(text, date, date) to authenticated;

-- Every 30 minutes, every board, the last 3 weeks.
select cron.schedule('schedule-tasks-autocomplete', '*/30 * * * *',
  $cron$select public.schedule_tasks_autocomplete(null, current_date - 21, current_date)$cron$);

-- Backups already keep every column (schedule_snapshot stores to_jsonb of the row); restoring one now
-- puts the type and done mark back too. A backup taken before these columns existed restores them as
-- empty, which is what the board held then.
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
  -- a row belonging to another board would silently jump states — refuse the whole restore
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
     kind, done_at, done_by, done_how, done_note, done_on)
  select (r->>'id')::uuid, (r->>'task_date')::date, r->>'account',
         nullif(r->>'inv_total','')::numeric, r->>'region', r->>'driver', r->>'so_num', r->>'notes',
         nullif(r->>'created_by','')::uuid,
         coalesce(nullif(r->>'created_at','')::timestamptz, now()), now(), p_state,
         nullif(r->>'deleted_at','')::timestamptz, nullif(r->>'deleted_by','')::uuid,
         nullif(r->>'kind',''), nullif(r->>'done_at','')::timestamptz, nullif(r->>'done_by','')::uuid,
         nullif(r->>'done_how',''), r->>'done_note', nullif(r->>'done_on','')::date
    from jsonb_array_elements(p_rows) r
  on conflict (id) do update set
     task_date=excluded.task_date, account=excluded.account, inv_total=excluded.inv_total,
     region=excluded.region, driver=excluded.driver, so_num=excluded.so_num, notes=excluded.notes,
     updated_at=now(), deleted_at=excluded.deleted_at, deleted_by=excluded.deleted_by,
     kind=excluded.kind, done_at=excluded.done_at, done_by=excluded.done_by,
     done_how=excluded.done_how, done_note=excluded.done_note, done_on=excluded.done_on;
  get diagnostics v_added = row_count;

  return jsonb_build_object('restored', v_added, 'removed', v_removed,
                            'state', p_state, 'undo_backup_id', v_pre);
end $function$;

-- schedule_undelete (migrate-schedule-backup.sql) skips its board check when nobody is signed in, and
-- Supabase grants new functions to anon: only signed-in people (the app's Undo) may call it.
revoke all on function public.schedule_undelete(uuid, integer) from public, anon;
grant execute on function public.schedule_undelete(uuid, integer) to authenticated, service_role;

-- The sales app's Upcoming column reads this feed: a deleted task (soft delete, since the backup
-- release) is no longer on the schedule, so it leaves the feed too.
create or replace function public.schedule_tasks_feed()
returns table(task_date date, account text, driver text, notes text, so_num text, state text)
language sql stable security definer set search_path = public as $$
  select task_date, account, driver, notes, so_num, coalesce(state,'CA')
  from public.schedule_tasks
  where task_date >= current_date - 14 and deleted_at is null
  order by task_date;
$$;
