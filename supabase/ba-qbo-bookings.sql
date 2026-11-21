-- BA app: "Book in QuickBooks" for reimbursement submissions (ba/docs/qbo-reimbursements.md), 2026-11-21.
-- Only the accounts in ba_qbo_bookers see or touch any of it. The page asks through the RPCs below; the job on
-- Gianni's Mac (~/bookkeeping-automation/qbo/ba-reimb-worker.mjs) keeps the ba_qbo_* reference tables, books and
-- undoes through QuickBooks, and writes through the Management API (postgres). Safe to run again.
-- Who may book is seeded outside this public repo (no email addresses here).

-- ── 1. who may book ────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.ba_qbo_bookers (
  user_id  uuid primary key,
  added_at timestamptz not null default now()
);
alter table public.ba_qbo_bookers enable row level security;
revoke all on public.ba_qbo_bookers from anon, authenticated;

create or replace function public.ba_qbo_can_book() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from public.ba_qbo_bookers b where b.user_id = auth.uid());
$$;
revoke all on function public.ba_qbo_can_book() from public, anon;
grant execute on function public.ba_qbo_can_book() to authenticated;

-- ── 2. kept by the Mac ─────────────────────────────────────────────────────────────────────────────────────────
-- per QuickBooks company: accounts as {id, name}; categories maps an app expense category to its default account
-- (a category missing here has no default: Gianni picks one on the card); accounts are the ones the card offers
create table if not exists public.ba_qbo_setup (
  company    text primary key check (company in ('filifera', 'wtny', 'wafgus')),
  label      text not null,
  realm      text not null,
  credit     jsonb not null,
  mileage    jsonb not null,
  categories jsonb not null default '{}',
  accounts   jsonb not null default '[]',
  classes    jsonb not null default '[]',
  next_doc   bigint,
  updated_at timestamptz not null default now()
);
-- per app profile: which company's Gusto pays them, their department and the class it gives (null: pick on the card)
create table if not exists public.ba_qbo_people (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  company    text check (company in ('filifera', 'wtny', 'wafgus')),
  gusto_uuid text,
  gusto_name text,
  department text,
  class      jsonb,
  doc_name   text not null,
  how        text check (how in ('gusto_name', 'name', 'picked')),
  problem    text,
  updated_at timestamptz not null default now()
);
create table if not exists public.ba_qbo_gusto_people (
  company    text not null check (company in ('filifera', 'wtny', 'wafgus')),
  gusto_uuid text not null,
  name       text not null,
  department text,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company, gusto_uuid)
);
-- each company's regular biweekly payrolls; paid = {gusto_uuid: {"total": n, "lines": [n, ...]}} once processed
create table if not exists public.ba_qbo_paydays (
  company      text not null check (company in ('filifera', 'wtny', 'wafgus')),
  period_start date not null,
  period_end   date not null,
  check_date   date not null,
  processed    boolean not null default false,
  late         boolean not null default false,
  payroll_uuid text,
  paid         jsonb not null default '{}',
  updated_at   timestamptz not null default now(),
  primary key (company, period_start)
);
-- QuickBooks JEs that credit a company's Reimbursements account (last 400 days, the whole window a booking may be
-- dated in); booking_id once a booking has it
create table if not exists public.ba_qbo_jes (
  company     text not null check (company in ('filifera', 'wtny', 'wafgus')),
  je_id       text not null,
  txn_date    date not null,
  doc_number  text,
  name_key    text,
  total       numeric(12,2) not null,
  booking_id  uuid,
  created_qbo timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (company, je_id)
);
create table if not exists public.ba_qbo_worker (
  id                   int primary key default 1 check (id = 1),
  heartbeat_at         timestamptz,
  refreshed_at         timestamptz,
  refresh_requested_at timestamptz,
  last_error           text,
  version              text
);
insert into public.ba_qbo_worker (id) values (1) on conflict (id) do nothing;

-- ── 3. bookings ────────────────────────────────────────────────────────────────────────────────────────────────
-- source 'app': booked by the Mac from a request; 'hand': a JE Gianni booked himself, linked to its items by the Mac.
-- plan (app): {doc_name, class:{id,name}, credit:{id,name}, lines:[{account:{id,name}, amount, description}],
--              items:[{kind, id, amount, account, description}], total, full, receipts:[receipt_path], date_how}
create table if not exists public.ba_qbo_bookings (
  id           uuid primary key default gen_random_uuid(),
  source       text not null default 'app' check (source in ('app', 'hand')),
  ba_id        uuid not null references public.profiles(id),
  period_id    uuid not null references public.pay_periods(id),
  company      text not null check (company in ('filifera', 'wtny', 'wafgus')),
  txn_date     date not null,
  total        numeric(12,2) not null,
  plan         jsonb not null default '{}',
  status       text not null default 'queued' check (status in ('queued', 'working', 'booked', 'failed', 'cancelled',
                 'expired', 'undo_queued', 'undoing', 'undone', 'undo_failed')),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  je_id        text,
  doc_number   text,
  sync_token   text,
  attachments  jsonb not null default '[]',
  detail       text,
  undo_by      uuid,
  undo_at      timestamptz
);
create index if not exists ba_qbo_bookings_person on public.ba_qbo_bookings (ba_id, period_id);
create index if not exists ba_qbo_bookings_open on public.ba_qbo_bookings (requested_at)
  where status in ('queued', 'working', 'undo_queued', 'undoing');
create unique index if not exists ba_qbo_bookings_hand_je on public.ba_qbo_bookings (company, je_id, period_id)
  where source = 'hand' and status = 'booked';

create table if not exists public.ba_qbo_booking_items (
  booking_id uuid not null references public.ba_qbo_bookings(id) on delete cascade,
  kind       text not null check (kind in ('trip', 'expense')),
  item_id    uuid not null,
  amount     numeric(12,2) not null,
  live       boolean not null default true,
  primary key (booking_id, kind, item_id)
);
-- an item is in at most one live booking
create unique index if not exists ba_qbo_booking_items_live on public.ba_qbo_booking_items (kind, item_id) where live;

-- a booking that ends without a JE in QuickBooks lets its items go; a finished one is never reopened
create or replace function public.trg_ba_qbo_booking_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('failed', 'cancelled', 'expired', 'undone') and new.status is distinct from old.status then
    raise exception 'A finished booking can''t be reopened. Book it again.';
  end if;
  if new.status in ('failed', 'cancelled', 'expired', 'undone') and new.status is distinct from old.status then
    update public.ba_qbo_booking_items set live = false where booking_id = new.id and live;
  end if;
  return new;
end $$;
drop trigger if exists ba_qbo_booking_status on public.ba_qbo_bookings;
create trigger ba_qbo_booking_status before update of status on public.ba_qbo_bookings
  for each row execute function public.trg_ba_qbo_booking_status();

-- ── 4. reading: bookers only; writing: only through the RPCs (and the Mac, as postgres) ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['ba_qbo_setup', 'ba_qbo_people', 'ba_qbo_gusto_people', 'ba_qbo_paydays', 'ba_qbo_jes',
                           'ba_qbo_worker', 'ba_qbo_bookings', 'ba_qbo_booking_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ba_qbo_read on public.%I', t);
    execute format('create policy ba_qbo_read on public.%I for select to authenticated using (public.ba_qbo_can_book())', t);
  end loop;
end $$;

-- ── 5. what the page can ask for ───────────────────────────────────────────────────────────────────────────────
-- p = {ba_id, period_id, company, txn_date, plan}. Checks the items against the database as they are now, queues the
-- booking and holds its items so nothing else can book them. The Mac checks everything again before it books.
create or replace function public.ba_qbo_request(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_ba      uuid := nullif(p->>'ba_id', '')::uuid;
  v_period  uuid := nullif(p->>'period_id', '')::uuid;
  v_company text := p->>'company';
  v_date    date := nullif(p->>'txn_date', '')::date;
  v_plan    jsonb := coalesce(p->'plan', '{}'::jsonb);
  v_total   numeric;
  v_id      uuid;
  n_bad     int;
  v_sum     numeric;
  v_why     text;
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can book reimbursements in QuickBooks.'; end if;
  if v_ba is null or v_period is null or v_date is null or v_company is null then
    raise exception 'Something is missing from the booking (person, period, company or date).';
  end if;
  if not exists (select 1 from public.ba_qbo_setup s where s.company = v_company) then
    raise exception 'That QuickBooks company isn''t set up yet. The Mac sets it up on its next refresh.';
  end if;
  if v_date < current_date - 400 or v_date > current_date + 60 then
    raise exception 'Pick a date within the last year or the next two months.';
  end if;
  if not exists (select 1 from public.pay_periods pp where pp.id = v_period and pp.end_date >= current_date - 400) then
    raise exception 'This pay period is older than the JEs the Mac checks, so book it by hand in QuickBooks.';
  end if;
  if jsonb_typeof(v_plan->'items') is distinct from 'array' or jsonb_array_length(v_plan->'items') = 0 then
    raise exception 'There is nothing to book.';
  end if;
  if (select count(*) from (select distinct x->>'kind', x->>'id' from jsonb_array_elements(v_plan->'items') x) d)
     <> jsonb_array_length(v_plan->'items') then
    raise exception 'An item is listed twice.';
  end if;
  v_total := round((v_plan->>'total')::numeric, 2);
  if v_total is null or v_total <= 0 then raise exception 'The total must be more than zero.'; end if;

  with it as (
    select x->>'kind' as kind, nullif(x->>'id', '')::uuid as id, round((x->>'amount')::numeric, 2) as amount
      from jsonb_array_elements(v_plan->'items') x
  ), chk as (
    select it.amount,
      case it.kind
        when 'trip' then (
          select case when t.id is null then 'an item is gone'
                      when t.ba_id <> v_ba or t.period_id is distinct from v_period then 'an item moved'
                      when t.status <> 'approved' then 'an item isn''t approved'
                      when round(t.amount, 2) is distinct from it.amount then 'an amount changed' end
            from (select 1) one left join public.trips t on t.id = it.id)
        when 'expense' then (
          select case when e.id is null then 'an item is gone'
                      when e.ba_id <> v_ba or e.period_id is distinct from v_period then 'an item moved'
                      when e.status <> 'approved' then 'an item isn''t approved'
                      when e.payment in ('company', 'company_bank') then 'an item is company-paid'
                      when e.source = 'books' then 'an item came from QuickBooks'
                      when round(e.amount, 2) is distinct from it.amount then 'an amount changed' end
            from (select 1) one left join public.expenses e on e.id = it.id)
        else 'an item isn''t a trip or an expense' end as why
      from it
  )
  select count(*) filter (where why is not null), sum(amount), string_agg(distinct why, ', ') filter (where why is not null)
    into n_bad, v_sum, v_why
    from chk;
  if n_bad > 0 then raise exception 'Something changed since you opened this (%). Open it again.', v_why; end if;
  if round(v_sum, 2) <> v_total then raise exception 'The items add up to %, not %. Open it again.', round(v_sum, 2), v_total; end if;
  if (select round(coalesce(sum((l->>'amount')::numeric), 0), 2) from jsonb_array_elements(coalesce(v_plan->'lines', '[]'::jsonb)) l)
     <> v_total then
    raise exception 'The lines don''t add up to the total. Open it again.';
  end if;

  insert into public.ba_qbo_bookings (source, ba_id, period_id, company, txn_date, total, plan, status, requested_by)
  values ('app', v_ba, v_period, v_company, v_date, v_total, v_plan, 'queued', auth.uid())
  returning id into v_id;
  begin
    insert into public.ba_qbo_booking_items (booking_id, kind, item_id, amount)
    select v_id, x->>'kind', (x->>'id')::uuid, round((x->>'amount')::numeric, 2)
      from jsonb_array_elements(v_plan->'items') x;
  exception when unique_violation then
    raise exception 'Some of these items are already in QuickBooks or on their way there. Open it again.';
  end;
  return v_id;
end $$;

create or replace function public.ba_qbo_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  update public.ba_qbo_bookings set status = 'cancelled', finished_at = now(), detail = 'Cancelled before the Mac picked it up.'
   where id = p_id and status = 'queued';
  if not found then raise exception 'It isn''t waiting anymore: the Mac already has it.'; end if;
end $$;

-- take a booking this app made back out of QuickBooks (the Mac deletes the JE and the files it attached)
create or replace function public.ba_qbo_undo(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  update public.ba_qbo_bookings set status = 'undo_queued', undo_by = auth.uid(), undo_at = now(), detail = null
   where id = p_id and source = 'app' and status in ('booked', 'undo_failed');
  if not found then raise exception 'Only a JE this app booked can be undone here.'; end if;
end $$;

-- "not these items": forget the Mac's link between one of Gianni's own JEs and these items (QuickBooks untouched)
create or replace function public.ba_qbo_unlink(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  update public.ba_qbo_bookings set status = 'undone', undo_by = auth.uid(), undo_at = now(), finished_at = now(),
         detail = 'Unlinked: these items aren''t in that JE. QuickBooks wasn''t changed.'
   where id = p_id and source = 'hand' and status = 'booked';
  if not found then raise exception 'That link is already gone.'; end if;
end $$;

-- "who is this in Gusto?": link a profile to a Gusto employee of one of the three companies
create or replace function public.ba_qbo_link_person(p_profile uuid, p_company text, p_gusto_uuid text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text; v_full text;
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  select g.name into v_name from public.ba_qbo_gusto_people g where g.company = p_company and g.gusto_uuid = p_gusto_uuid;
  if v_name is null then raise exception 'That person isn''t on that company''s Gusto list.'; end if;
  select pr.full_name into v_full from public.profiles pr where pr.id = p_profile;
  if v_full is null then raise exception 'That app account doesn''t exist.'; end if;
  insert into public.ba_qbo_people (profile_id, company, gusto_uuid, gusto_name, doc_name, how, problem, updated_at)
  values (p_profile, p_company, p_gusto_uuid, v_name, split_part(trim(v_full), ' ', 1), 'picked', 'Getting their department from Gusto…', now())
  on conflict (profile_id) do update
    set company = excluded.company, gusto_uuid = excluded.gusto_uuid, gusto_name = excluded.gusto_name, how = 'picked',
        department = null, class = null, problem = excluded.problem, updated_at = now();
  update public.ba_qbo_worker set refresh_requested_at = now() where id = 1;
end $$;

create or replace function public.ba_qbo_refresh() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  update public.ba_qbo_worker set refresh_requested_at = now() where id = 1;
end $$;

do $$
declare f text;
begin
  foreach f in array array['ba_qbo_request(jsonb)', 'ba_qbo_cancel(uuid)', 'ba_qbo_undo(uuid)', 'ba_qbo_unlink(uuid)',
                           'ba_qbo_link_person(uuid, text, text)', 'ba_qbo_refresh()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.trg_ba_qbo_booking_status() from public, anon, authenticated;

-- ── 6. a booked item stays as it was booked ────────────────────────────────────────────────────────────────────
-- The words the guards use: what holds it, and what the person asking can do about it.
create or replace function public.ba_qbo_held_msg(p_doc text, p_source text, p_what text, p_status text) returns text
language plpgsql stable security definer set search_path = public as $$
declare me boolean := public.ba_qbo_can_book();
begin
  if p_status = 'working' then
    return format('%s is being booked in QuickBooks right now%s, so try again in a few minutes.', p_what,
      case when p_doc is null then '' else format(' as JE %s', p_doc) end);
  elsif p_status in ('undo_queued', 'undoing') then
    return format('%s is being taken out of QuickBooks right now, so try again in a few minutes.', p_what);
  elsif p_status = 'queued' or p_doc is null then
    return format('%s is on its way to QuickBooks. %s', p_what,
      case when me then 'Cancel that booking first.' else 'Ask Gianni to cancel that booking first.' end);
  elsif p_source = 'hand' then
    return format('%s is in QuickBooks as JE %s, booked by hand, so it can''t change here. %s', p_what, p_doc,
      case when me then 'If that JE isn''t for these items, use Not these items in their QuickBooks section.'
           else 'Ask Gianni.' end);
  end if;
  return format('%s is in QuickBooks as JE %s. %s', p_what, p_doc,
    case when me then 'Undo the booking first.' else 'Ask Gianni to undo that booking first.' end);
end $$;
revoke all on function public.ba_qbo_held_msg(text, text, text, text) from public, anon, authenticated;
drop function if exists public.ba_qbo_held_msg(text, text, text);

-- Runs after the tables' own before-triggers (names sort last), so it compares what would really be saved.
create or replace function public.trg_ba_qbo_item_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k    text := case tg_table_name when 'trips' then 'trip' else 'expense' end;
  keys text[] := case tg_table_name
                   when 'trips' then array['amount', 'status', 'ba_id', 'period_id', 'trip_date']
                   else array['amount', 'status', 'ba_id', 'period_id', 'expense_date', 'payment', 'category', 'source'] end;
  msg  text;
begin
  select public.ba_qbo_held_msg(b.doc_number, b.source, 'This', b.status) into msg
    from public.ba_qbo_booking_items i join public.ba_qbo_bookings b on b.id = i.booking_id
   where i.kind = k and i.item_id = old.id and i.live
   limit 1;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE'
     or exists (select 1 from unnest(keys) c where (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c)) then
    raise exception '%', msg;
  end if;
  return new;
end $$;
revoke all on function public.trg_ba_qbo_item_guard() from public, anon, authenticated;
drop trigger if exists zz_qbo_guard on public.trips;
create trigger zz_qbo_guard before update or delete on public.trips
  for each row execute function public.trg_ba_qbo_item_guard();
drop trigger if exists zz_qbo_guard on public.expenses;
create trigger zz_qbo_guard before update or delete on public.expenses
  for each row execute function public.trg_ba_qbo_item_guard();

-- an approved submission with items in QuickBooks can't be sent back, except by the person re-submitting it with a
-- forgotten item (their booked items stay locked by the item guard; the new one goes to review as usual)
create or replace function public.trg_ba_qbo_submission_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare msg text;
begin
  if old.status = 'approved' and new.status is distinct from 'approved' then
    if auth.uid() = old.ba_id and new.status = 'submitted' and new.submitted_at is distinct from old.submitted_at then
      return new;
    end if;
    select public.ba_qbo_held_msg(b.doc_number, b.source, 'This period', b.status) into msg
      from public.ba_qbo_bookings b
     where b.ba_id = old.ba_id and b.period_id = old.period_id
       and exists (select 1 from public.ba_qbo_booking_items i where i.booking_id = b.id and i.live)
     order by case b.status when 'working' then 0 when 'undoing' then 1 when 'undo_queued' then 2 when 'queued' then 3 else 4 end, b.requested_at desc
     limit 1;
    if found then raise exception '%', msg; end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_ba_qbo_submission_guard() from public, anon, authenticated;
drop trigger if exists zz_qbo_guard on public.submissions;
create trigger zz_qbo_guard before update on public.submissions
  for each row execute function public.trg_ba_qbo_submission_guard();
