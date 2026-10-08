-- Manager Timesheets, California (timesheets.html). Gusto hours + breaks per employee-day for the
-- CA companies (Filifera, Slane, Waf & Gus, Imperial), shown to managers by company + department.
--
-- Who can see what
--   Access is an explicit allowlist: ts_access (one row per email) + ts_grants (company,
--   department pairs, '*' = all). It deliberately does NOT use is_staff(): every @wizardtrees.com
--   sign-in passes is_staff, BAs included, and that must never unlock payroll hours. It does not
--   use is_admin() / profiles either; ts_access.is_admin is this app's own admin flag.
--   A confirmed @wizardtrees.com user with no ts_access row sees nothing at all.
--   Only a GOOGLE sign-in counts (see ts_my_email): the BA app on the same site signs people in
--   with passwords, and BA-app admins can reset any account's password, so a password, magic
--   link or OTP session never unlocks anything here, even for an allowlisted email.
--   A '*' company grant means every company whose ts_companies.region is 'CA', so adding a
--   company from another region later never widens an existing grant.
--
-- What is stored
--   Hours and breaks only. No pay rates, wages, gross pay or any Gusto compensation field is
--   stored here, and the producer never requests them.
--
-- Who writes
--   Nobody writes the tables directly. authenticated has SELECT only (anon has nothing), and
--   there are no insert/update/delete policies. All writes go through security definer RPCs:
--     ts_sync(...)              the hourly producer (~/gusto-sync/ca-timesheets.mjs), which signs
--                               in as automation@wizardtrees.com; the body checks that email
--     ts_admin_save_user(...)   ts_access admins manage the allowlist from the page
--     ts_admin_delete_user(...)
--   ts_sync only deletes in-window day rows of people Gusto still lists as active (Gusto hides
--   terminated people's shifts, and their history must survive). It never deletes the rows of
--   an active person who has no day at all in the pull (held and reported instead), and a
--   breaker refuses a delete of more than 25 rows that is also more than 30% of the active
--   people's rows in the window. allow_mass_delete overrides both. People missing from a
--   non-empty people list are set inactive, never deleted.
--   automation@ signs in with a password, so ts_access refuses it: it can sync but never view.
--   That password is not enough to write: BA-app admins can reset it. ts_sync also requires the
--   sync key, sent by the producer as the x-ts-sync-key request header and checked against
--   ts_sync_keys, which holds only its sha256 and is readable by nobody. The plaintext lives only
--   in ~/gusto-sync/.ts-sync-key (0600) on Gianni's Mac; its hash is inserted when this file is
--   applied (never committed). Rotate: insert a new hash, set revoked_at on the old one.
--   A finished day (work_date before today, LA time) keeps the department it was first synced
--   under, so a department change in Gusto does not hand weeks of history to the new manager.
--
-- Grants
--   Supabase's default privileges hand anon/authenticated ALL on every new public table and
--   EXECUTE on every new public function, so every grant below starts with an explicit revoke
--   naming them (revoking from public alone leaves them reachable).
--   ts_my_email() and ts_my_grant_keys() are granted to authenticated because the RLS policies
--   call them and policy expressions run with the caller's privileges (without EXECUTE every
--   select fails with "permission denied for function"). Both only describe the caller.
--
-- Safe to re-run: create ... if not exists, create or replace, drop policy if exists.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, then run
-- supabase/ts-ca-timesheets-verify.sql (it rolls itself back) and check every row says pass.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ts_companies (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  name text not null,
  region text not null default 'CA',
  gusto_uuid text,
  connected boolean not null default false,
  last_sync_at timestamptz,
  sync_from date,
  sync_to date,
  label_csv_at timestamptz,          -- download time of the Gusto CSV used for break labels (null = none)
  day_rows int,
  updated_at timestamptz not null default now()
);
insert into public.ts_companies (key, name) values
  ('filifera', 'Filifera'), ('slane', 'Slane'), ('wafgus', 'Waf & Gus'), ('imperial', 'Imperial')
on conflict do nothing;

create table if not exists public.ts_people (
  company text references public.ts_companies(key),
  employee_uuid text,
  name text not null,
  department text not null default 'No department',
  job_title text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company, employee_uuid)
);

create table if not exists public.ts_days (
  id text primary key,                                -- '<company>:<employee_uuid>:<YYYY-MM-DD>'
  company text not null references public.ts_companies(key),
  region text not null default 'CA',
  employee_uuid text not null,
  employee_name text not null,
  department text not null default 'No department',
  job_title text,
  work_date date not null,
  first_in timestamptz,
  last_out timestamptz,                               -- null = still clocked in
  shifts jsonb not null default '[]' check (jsonb_typeof(shifts) = 'array'),
  span_min int not null default 0,
  worked_min int not null default 0,
  paid_break_min int not null default 0,
  unpaid_break_min int not null default 0,
  reg_min int,
  ot_min int,
  dt_min int,
  ot_src text check (ot_src in ('gusto', 'est')),
  label_src text not null default 'none' check (label_src in ('gusto', 'rule', 'mixed', 'none')),
  gusto_total_min int,
  approval text,
  note text,
  flags jsonb not null default '[]' check (jsonb_typeof(flags) = 'array'),   -- [{code, sev, msg}]
  open boolean not null default false,               -- a shift still clocked in
  hours_only boolean not null default false,         -- admin "hours only" entry, no real punches
  synced_at timestamptz not null default now()
);
create index if not exists ts_days_company_work_date_idx on public.ts_days (company, work_date);
create index if not exists ts_days_work_date_idx on public.ts_days (work_date);

create table if not exists public.ts_access (
  email text primary key check (email = lower(email)),
  is_admin boolean not null default false,
  active boolean not null default true,
  note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text
);
insert into public.ts_access (email, is_admin, active, note)
  values ('gianni@wizardtrees.com', true, true, 'owner')
on conflict do nothing;
-- The sync account signs in with a password (ts_my_email lets it through for ts_sync only), so
-- it must never hold a view: no ts_access row means no grants, no admin, no freshness rows.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ts_access_not_sync_account'
                  and conrelid = 'public.ts_access'::regclass) then
    alter table public.ts_access add constraint ts_access_not_sync_account
      check (email <> 'automation@wizardtrees.com');
  end if;
end $$;

create table if not exists public.ts_grants (
  email text not null references public.ts_access(email) on delete cascade,
  company text not null check (company = '*' or company ~ '^[a-z0-9_]+$'),   -- a ts_companies.key or '*' (every company with region 'CA')
  department text not null,      -- a department title or '*' (all departments)
  created_at timestamptz default now(),
  updated_by text,
  primary key (email, company, department)
);

-- sha256 of the producer's sync key (see the header). RLS on, no policies, no grants: only the
-- security definer ts_sync can read it.
create table if not exists public.ts_sync_keys (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.ts_sync_keys enable row level security;
revoke all on public.ts_sync_keys from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Identity helpers (used by the policies; every relation is schema-qualified)
-- ---------------------------------------------------------------------------------------------

-- The caller's confirmed sign-in email, lowercased, or null. Two kinds of session count:
--   * A Google sign-in. The account has Google among its providers, it has a Google identity
--     with the same email from the wizardtrees.com Workspace (hd claim), AND this session was
--     made by OAuth: the JWT's amr says 'oauth', which is what signInWithIdToken records. The
--     identities alone prove nothing, because BA-app admins can set any account's password
--     (admin-reset-ba-password) and the BA app shares this page's origin and session storage.
--     A password, magic-link, OTP or recovery session of the same account gets null.
--   * automation@wizardtrees.com, the sync account, which signs in with a password. It is let
--     through for ts_sync only: ts_access refuses that email, so it never holds a view.
-- Null for anon, unknown or unconfirmed users.
create or replace function public.ts_my_email()
returns text language sql stable security definer set search_path = public as $$
  select lower(u.email)::text from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null
     and (lower(u.email) = 'automation@wizardtrees.com'
          or ((coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb) @> '["google"]'::jsonb
               or u.raw_app_meta_data->>'provider' = 'google')
              and coalesce(auth.jwt()->'amr', '[]'::jsonb) @> '[{"method": "oauth"}]'::jsonb
              and exists (select 1 from auth.identities i
                           where i.user_id = u.id and i.provider = 'google'
                             and lower(i.identity_data->>'email') = lower(u.email)
                             and lower(i.identity_data->'custom_claims'->>'hd') = 'wizardtrees.com')))
   limit 1
$$;
revoke all on function public.ts_my_email() from public, anon, authenticated;
grant execute on function public.ts_my_email() to authenticated;   -- needed by the RLS policies

-- True when the caller has an ACTIVE ts_access row with is_admin.
create or replace function public.ts_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ts_access a
                  where a.email = public.ts_my_email() and a.active and a.is_admin)
$$;
revoke all on function public.ts_is_admin() from public, anon, authenticated;
grant execute on function public.ts_is_admin() to authenticated;

-- May the caller see rows of this company + department? Admins see everything; everyone else
-- needs an active ts_access row and a matching grant. A '*' department matches any department;
-- a '*' company matches only companies whose ts_companies.region is 'CA'.
-- This is the reference rule. The ts_days / ts_people policies apply the same rule through
-- ts_my_grant_keys() so the caller's grants are looked up once per query instead of once per
-- row (per-row calls cost ~0.13 ms each: 575 ms for one pay period as a limited manager).
-- The verify script checks the policy and this function agree row for row. Internal, not granted.
create or replace function public.ts_can_view(p_company text, p_department text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ts_is_admin()
      or exists (select 1 from public.ts_access a
                   join public.ts_grants g on g.email = a.email
                  where a.email = public.ts_my_email() and a.active
                    and (g.company = p_company
                         or (g.company = '*' and exists (select 1 from public.ts_companies c
                                                          where c.key = p_company and c.region = 'CA')))
                    and g.department in (p_department, '*'))
$$;
revoke all on function public.ts_can_view(text, text) from public, anon, authenticated;

-- The caller's grants as 'company|department' keys, with a '*' company spelled out as one key
-- per CA company; empty unless the caller has an ACTIVE ts_access row. A row (c, d) is visible
-- when the keys overlap {c|d, c|*}, which is exactly ts_can_view's rule ('|' never appears in a
-- company: keys are [a-z0-9_]+ or '*').
create or replace function public.ts_my_grant_keys()
returns text[] language sql stable security definer set search_path = public as $$
  with g as (select g.company, g.department
               from public.ts_access a join public.ts_grants g on g.email = a.email
              where a.email = public.ts_my_email() and a.active)
  select coalesce(array_agg(distinct k.key order by k.key), '{}'::text[])
    from (select g.company || '|' || g.department as key from g where g.company <> '*'
          union all
          select c.key || '|' || g.department from g join public.ts_companies c on c.region = 'CA'
           where g.company = '*') k
$$;
revoke all on function public.ts_my_grant_keys() from public, anon, authenticated;
grant execute on function public.ts_my_grant_keys() to authenticated;   -- needed by the RLS policies

-- What the page needs after sign-in. An email with no ts_access row (or an inactive one) gets
-- active:false and no grants, and the page shows "ask Gianni to add you". A session that is not
-- a Google sign-in (for example a BA-app password session on the same site) gets email null:
-- the page should sign that session out locally and offer Google sign-in instead.
create or replace function public.ts_me()
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (select public.ts_my_email() as email),
       acc as (select a.active, a.is_admin from public.ts_access a, me where a.email = me.email)
  select jsonb_build_object(
    'email',    (select email from me),
    'active',   coalesce((select active from acc), false),
    'is_admin', coalesce((select active and is_admin from acc), false),
    'grants',   case when coalesce((select active from acc), false) then
                  coalesce((select jsonb_agg(jsonb_build_object('company', g.company, 'department', g.department)
                                             order by g.company, g.department)
                              from public.ts_grants g, me where g.email = me.email), '[]'::jsonb)
                else '[]'::jsonb end)
$$;
revoke all on function public.ts_me() from public, anon, authenticated;
grant execute on function public.ts_me() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Producer write: ts_sync
-- ---------------------------------------------------------------------------------------------
-- p_days   : ts_days rows (keys = column names; synced_at is set here). Every id must start
--            with '<p_company>:' and a row's company, when present, must equal p_company.
-- p_people : [{employee_uuid, name, department, job_title, active}] for p_company.
-- p_meta   : {active_uuids:[...], label_csv_at, gusto_uuid, allow_mass_delete}
-- Deletes only rows of p_company with work_date in [p_from, p_to], whose id is not in p_days and
-- whose employee_uuid is in active_uuids. An empty p_days never deletes anything.
-- Holds (keeps, and reports in held / held_people) the rows of an active person who has no day
-- at all in p_days: Gusto returning nothing for someone it still lists as active (a termination
-- in progress, a partial pull) must not wipe their history, because once Gusto hides those
-- shifts they never come back. allow_mass_delete releases held rows and overrides the breaker.
-- When p_people is not empty, people of p_company missing from it are set active = false
-- (never deleted).
-- Returns {ok, upserted, deleted, people, deactivated, held[, held_people][, note]}.
create or replace function public.ts_sync(p_company text, p_from date, p_to date,
                                          p_days jsonb, p_people jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_days    jsonb := coalesce(p_days, '[]'::jsonb);
  v_people  jsonb := coalesce(p_people, '[]'::jsonb);
  v_meta    jsonb := coalesce(p_meta, '{}'::jsonb);
  v_active  text[];      -- employee_uuids Gusto lists as active (only their rows may be deleted)
  v_ids     text[];      -- day ids in the payload
  v_have    text[];      -- employee_uuids with at least one day in the payload
  v_listed  text[];      -- employee_uuids in p_people
  v_force   boolean;
  v_region  text;
  v_window  int := 0;    -- in-window rows of active people: the breaker's 100%
  v_del     int := 0;
  v_held    int := 0;
  v_held_people jsonb := '[]'::jsonb;
  v_ups     int := 0;
  v_ppl     int := 0;
  v_off     int := 0;
  v_note    text;
  v_bad     text;
begin
  if public.ts_my_email() is distinct from 'automation@wizardtrees.com' then
    raise exception 'ts_sync is for the timesheet sync account only' using errcode = '42501';
  end if;
  -- the account's password alone is not enough (BA-app admins can reset it): the request must
  -- also carry the sync key that only the producer's Mac holds
  if not exists (select 1 from public.ts_sync_keys k
                  where k.revoked_at is null
                    and k.key_hash = encode(sha256(convert_to(coalesce(
                          nullif(current_setting('request.headers', true), '')::jsonb->>'x-ts-sync-key', ''), 'utf8')), 'hex')) then
    raise exception 'ts_sync needs the sync key' using errcode = '42501';
  end if;
  select c.region into v_region from public.ts_companies c where c.key = p_company;
  if not found then raise exception 'Unknown company: %', p_company; end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Bad sync window: % to %', p_from, p_to;
  end if;
  if jsonb_typeof(v_days) <> 'array' or jsonb_typeof(v_people) <> 'array' or jsonb_typeof(v_meta) <> 'object' then
    raise exception 'p_days and p_people must be arrays, p_meta an object';
  end if;
  if jsonb_typeof(coalesce(v_meta->'active_uuids', '[]'::jsonb)) <> 'array' then
    raise exception 'p_meta.active_uuids must be an array';
  end if;

  -- payload sanity: a bad row fails the whole sync loudly instead of landing half-written
  select coalesce(d->>'id', '(no id)') into v_bad from jsonb_array_elements(v_days) d
   where left(coalesce(d->>'id', ''), length(p_company) + 1) <> p_company || ':'
      or coalesce(d->>'employee_uuid', '') = '' or coalesce(d->>'employee_name', '') = ''
      or coalesce(d->>'work_date', '') = ''
      or (d ? 'company' and d->>'company' is distinct from p_company)
   limit 1;
  if v_bad is not null then raise exception 'Bad day row for %: %', p_company, v_bad; end if;
  select coalesce(p->>'employee_uuid', '(no employee_uuid)') into v_bad from jsonb_array_elements(v_people) p
   where coalesce(p->>'employee_uuid', '') = '' or coalesce(p->>'name', '') = ''
   limit 1;
  if v_bad is not null then raise exception 'Bad person row for %: %', p_company, v_bad; end if;

  -- (none of these can hold a null: ids and uuids were checked above)
  v_active := array(select jsonb_array_elements_text(coalesce(v_meta->'active_uuids', '[]'::jsonb)));
  v_ids    := array(select d->>'id' from jsonb_array_elements(v_days) d);
  v_have   := array(select distinct d->>'employee_uuid' from jsonb_array_elements(v_days) d);
  v_listed := array(select distinct p->>'employee_uuid' from jsonb_array_elements(v_people) p);
  v_force  := coalesce((v_meta->>'allow_mass_delete')::boolean, false);

  -- one sync per company at a time
  perform pg_advisory_xact_lock(hashtext('ts_sync:' || p_company));

  if jsonb_array_length(v_days) = 0 then
    if exists (select 1 from public.ts_days t where t.company = p_company and t.work_date between p_from and p_to) then
      v_note := 'empty payload, nothing deleted';
    end if;
  else
    select count(*) into v_window from public.ts_days t
     where t.company = p_company and t.work_date between p_from and p_to and t.employee_uuid = any (v_active);
    -- stale = in window, person active in Gusto, id not in the payload; held = stale rows of a
    -- person with no day at all in the payload
    select count(*) filter (where v_force or t.employee_uuid = any (v_have)),
           count(*) filter (where not v_force and not (t.employee_uuid = any (v_have))),
           coalesce(jsonb_agg(distinct t.employee_uuid)
                      filter (where not v_force and not (t.employee_uuid = any (v_have))), '[]'::jsonb)
      into v_del, v_held, v_held_people
      from public.ts_days t
     where t.company = p_company and t.work_date between p_from and p_to
       and t.employee_uuid = any (v_active) and not (t.id = any (v_ids));
    if v_del > 25 and v_del > 0.3 * v_window and not v_force then
      raise exception 'ts_sync breaker: would delete % of % active-person day rows for % (% to %); pass allow_mass_delete to override',
        v_del, v_window, p_company, p_from, p_to;
    end if;
    if v_held > 0 then
      v_note := format('kept %s day rows of %s active people with no shifts in this pull; allow_mass_delete removes them',
                       v_held, jsonb_array_length(v_held_people));
    end if;
  end if;

  insert into public.ts_people as tp (company, employee_uuid, name, department, job_title, active, updated_at)
  select distinct on (p.employee_uuid)
         p_company, p.employee_uuid, p.name, coalesce(nullif(p.department, ''), 'No department'),
         nullif(p.job_title, ''), coalesce(p.active, true), now()
    from jsonb_to_recordset(v_people) as p(employee_uuid text, name text, department text,
                                           job_title text, active boolean)
   order by p.employee_uuid
  on conflict (company, employee_uuid) do update
     set name = excluded.name, department = excluded.department, job_title = excluded.job_title,
         active = excluded.active, updated_at = now();
  get diagnostics v_ppl = row_count;

  -- a full people list is the roster: whoever of this company is missing from it is inactive
  if jsonb_array_length(v_people) > 0 then
    update public.ts_people tp set active = false, updated_at = now()
     where tp.company = p_company and tp.active and not (tp.employee_uuid = any (v_listed));
    get diagnostics v_off = row_count;
  end if;

  insert into public.ts_days as td (id, company, region, employee_uuid, employee_name, department,
         job_title, work_date, first_in, last_out, shifts, span_min, worked_min, paid_break_min,
         unpaid_break_min, reg_min, ot_min, dt_min, ot_src, label_src, gusto_total_min, approval,
         note, flags, "open", hours_only, synced_at)
  select distinct on (d.id)
         d.id, p_company, coalesce(nullif(d.region, ''), v_region, 'CA'), d.employee_uuid,
         d.employee_name, coalesce(nullif(d.department, ''), 'No department'), nullif(d.job_title, ''),
         d.work_date, d.first_in, d.last_out, coalesce(d.shifts, '[]'::jsonb),
         coalesce(d.span_min, 0), coalesce(d.worked_min, 0), coalesce(d.paid_break_min, 0),
         coalesce(d.unpaid_break_min, 0), d.reg_min, d.ot_min, d.dt_min, nullif(d.ot_src, ''),
         coalesce(nullif(d.label_src, ''), 'none'), d.gusto_total_min, d.approval, d.note,
         coalesce(d.flags, '[]'::jsonb), coalesce(d."open", false), coalesce(d.hours_only, false), now()
    from jsonb_to_recordset(v_days) as d(id text, region text, employee_uuid text, employee_name text,
         department text, job_title text, work_date date, first_in timestamptz, last_out timestamptz,
         shifts jsonb, span_min int, worked_min int, paid_break_min int, unpaid_break_min int,
         reg_min int, ot_min int, dt_min int, ot_src text, label_src text, gusto_total_min int,
         approval text, note text, flags jsonb, "open" boolean, hours_only boolean)
   order by d.id
  on conflict (id) do update
     set company = excluded.company, region = excluded.region, employee_uuid = excluded.employee_uuid,
         employee_name = excluded.employee_name,
         -- a finished day keeps the department it was synced under (filling in a missing one is fine)
         department = case when td.work_date < (now() at time zone 'America/Los_Angeles')::date
                                and td.department <> 'No department'
                           then td.department else excluded.department end,
         job_title = excluded.job_title, work_date = excluded.work_date, first_in = excluded.first_in,
         last_out = excluded.last_out, shifts = excluded.shifts, span_min = excluded.span_min,
         worked_min = excluded.worked_min, paid_break_min = excluded.paid_break_min,
         unpaid_break_min = excluded.unpaid_break_min, reg_min = excluded.reg_min,
         ot_min = excluded.ot_min, dt_min = excluded.dt_min, ot_src = excluded.ot_src,
         label_src = excluded.label_src, gusto_total_min = excluded.gusto_total_min,
         approval = excluded.approval, note = excluded.note, flags = excluded.flags,
         "open" = excluded."open", hours_only = excluded.hours_only, synced_at = now();
  get diagnostics v_ups = row_count;

  if v_del > 0 then
    delete from public.ts_days t
     where t.company = p_company and t.work_date between p_from and p_to
       and t.employee_uuid = any (v_active) and not (t.id = any (v_ids))
       and (v_force or t.employee_uuid = any (v_have));
    get diagnostics v_del = row_count;
  end if;

  update public.ts_companies c
     set connected = true, last_sync_at = now(), sync_from = p_from, sync_to = p_to,
         label_csv_at = nullif(v_meta->>'label_csv_at', '')::timestamptz,
         gusto_uuid = coalesce(nullif(v_meta->>'gusto_uuid', ''), c.gusto_uuid),
         day_rows = (select count(*) from public.ts_days t where t.company = p_company),
         updated_at = now()
   where c.key = p_company;

  return jsonb_build_object('ok', true, 'upserted', v_ups, 'deleted', v_del, 'people', v_ppl,
                            'deactivated', v_off, 'held', v_held)
         || case when v_held > 0 then jsonb_build_object('held_people', v_held_people) else '{}'::jsonb end
         || case when v_note is null then '{}'::jsonb else jsonb_build_object('note', v_note) end;
end $$;
revoke all on function public.ts_sync(text, date, date, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ts_sync(text, date, date, jsonb, jsonb, jsonb) to authenticated;   -- body checks the email

-- ---------------------------------------------------------------------------------------------
-- Admin RPCs (ts_access admins only)
-- ---------------------------------------------------------------------------------------------

-- One user as the admin panel shows it. Internal, not granted.
create or replace function public.ts_user_json(p_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', a.email, 'is_admin', a.is_admin, 'active', a.active, 'note', a.note,
    'created_at', a.created_at, 'updated_at', a.updated_at, 'updated_by', a.updated_by,
    'grants', coalesce((select jsonb_agg(jsonb_build_object('company', g.company, 'department', g.department)
                                         order by g.company, g.department)
                          from public.ts_grants g where g.email = a.email), '[]'::jsonb))
    from public.ts_access a where a.email = p_email
$$;
revoke all on function public.ts_user_json(text) from public, anon, authenticated;

create or replace function public.ts_admin_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ts_is_admin() then
    raise exception 'Only timesheet admins can do this' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(public.ts_user_json(a.email) order by a.email) from public.ts_access a),
                  '[]'::jsonb);
end $$;
revoke all on function public.ts_admin_list() from public, anon, authenticated;
grant execute on function public.ts_admin_list() to authenticated;

-- Upsert one user and REPLACE their grants with p_grants ([{company, department}]).
create or replace function public.ts_admin_save_user(p_email text, p_is_admin boolean, p_active boolean,
                                                     p_note text, p_grants jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me     text := public.ts_my_email();
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_grants jsonb := coalesce(p_grants, '[]'::jsonb);
  v_bad    text;
begin
  if not public.ts_is_admin() then
    raise exception 'Only timesheet admins can do this' using errcode = '42501';
  end if;
  if v_email !~ '^[a-z0-9._%+-]+@wizardtrees\.com$' then
    raise exception 'Use a @wizardtrees.com email address';
  end if;
  if v_email = 'automation@wizardtrees.com' then
    raise exception 'automation@wizardtrees.com is the sync account and cannot have a timesheet view';
  end if;
  if v_email = v_me and (not coalesce(p_is_admin, false) or not coalesce(p_active, false)) then
    raise exception 'You cannot remove your own admin access';
  end if;
  if jsonb_typeof(v_grants) <> 'array' then raise exception 'Grants must be a list'; end if;
  select coalesce(g->>'company', '(blank)') || ' / ' || coalesce(g->>'department', '(blank)') into v_bad
    from jsonb_array_elements(v_grants) g
   where jsonb_typeof(g) <> 'object'
      or coalesce(trim(g->>'department'), '') = ''
      or not (lower(trim(coalesce(g->>'company', ''))) = '*'
              or exists (select 1 from public.ts_companies c where c.key = lower(trim(g->>'company'))))
   limit 1;
  if v_bad is not null then raise exception 'Unknown company or blank department in grant: %', v_bad; end if;

  insert into public.ts_access as a (email, is_admin, active, note, updated_at, updated_by)
  values (v_email, coalesce(p_is_admin, false), coalesce(p_active, false), nullif(trim(p_note), ''), now(), v_me)
  on conflict (email) do update
     set is_admin = excluded.is_admin, active = excluded.active, note = excluded.note,
         updated_at = now(), updated_by = v_me;

  delete from public.ts_grants g where g.email = v_email;
  insert into public.ts_grants (email, company, department, updated_by)
  select distinct v_email, lower(trim(g->>'company')), trim(g->>'department'), v_me
    from jsonb_array_elements(v_grants) g
  on conflict do nothing;

  return jsonb_build_object('ok', true) || public.ts_user_json(v_email);
end $$;
revoke all on function public.ts_admin_save_user(text, boolean, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.ts_admin_save_user(text, boolean, boolean, text, jsonb) to authenticated;

create or replace function public.ts_admin_delete_user(p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_n int;
begin
  if not public.ts_is_admin() then
    raise exception 'Only timesheet admins can do this' using errcode = '42501';
  end if;
  if v_email = public.ts_my_email() then
    raise exception 'You cannot delete your own access';
  end if;
  delete from public.ts_access a where a.email = v_email;   -- grants go with it (on delete cascade)
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_n);
end $$;
revoke all on function public.ts_admin_delete_user(text) from public, anon, authenticated;
grant execute on function public.ts_admin_delete_user(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row level security: SELECT only, to authenticated. No write policies (writes = RPCs above).
-- (select ...) around the caller-only helpers lets Postgres evaluate them once per query.
-- ---------------------------------------------------------------------------------------------

alter table public.ts_companies enable row level security;
alter table public.ts_people    enable row level security;
alter table public.ts_days      enable row level security;
alter table public.ts_access    enable row level security;
alter table public.ts_grants    enable row level security;

revoke all on table public.ts_companies from public, anon, authenticated;
revoke all on table public.ts_people    from public, anon, authenticated;
revoke all on table public.ts_days      from public, anon, authenticated;
revoke all on table public.ts_access    from public, anon, authenticated;
revoke all on table public.ts_grants    from public, anon, authenticated;
grant select on table public.ts_companies to authenticated;
grant select on table public.ts_people    to authenticated;
grant select on table public.ts_days      to authenticated;
grant select on table public.ts_access    to authenticated;
grant select on table public.ts_grants    to authenticated;

-- = ts_can_view(company, department), evaluated with the caller's grants fetched once per query
-- (ts_my_grant_keys already spells a '*' company out as the CA companies)
drop policy if exists ts_days_select on public.ts_days;
create policy ts_days_select on public.ts_days for select to authenticated
  using ((select public.ts_is_admin())
         or (select public.ts_my_grant_keys())
            && array[company || '|' || department, company || '|*']);

drop policy if exists ts_people_select on public.ts_people;
create policy ts_people_select on public.ts_people for select to authenticated
  using ((select public.ts_is_admin())
         or (select public.ts_my_grant_keys())
            && array[company || '|' || department, company || '|*']);

-- freshness only (no names): any active allowlisted user
drop policy if exists ts_companies_select on public.ts_companies;
create policy ts_companies_select on public.ts_companies for select to authenticated
  using (exists (select 1 from public.ts_access a where a.email = (select public.ts_my_email()) and a.active));

drop policy if exists ts_access_select on public.ts_access;
create policy ts_access_select on public.ts_access for select to authenticated
  using ((select public.ts_is_admin()) or email = (select public.ts_my_email()));

drop policy if exists ts_grants_select on public.ts_grants;
create policy ts_grants_select on public.ts_grants for select to authenticated
  using ((select public.ts_is_admin()) or email = (select public.ts_my_email()));

notify pgrst, 'reload schema';

-- Post-apply checks (all read-only):
--   select relname, relrowsecurity from pg_class where relname like 'ts\_%' and relkind = 'r';   -- 5 rows, all true
--   anon GET /rest/v1/ts_days?select=id  -> 401/permission denied ; rpc/ts_me as anon -> permission denied
--   then run supabase/ts-ca-timesheets-verify.sql: every row pass = true, and it rolls back.
--   Finally sign in on timesheets.html with Google: rpc/ts_me must show your email and active.
--   If it shows email null, check that session's JWT amr says 'oauth' (see ts_my_email).
