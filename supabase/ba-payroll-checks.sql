-- BA app: the Payroll list and the after-submit reimbursement check (ba/docs/qbo-reimbursements.md, "Payroll list"),
-- 2026-11-24. WTNY's 10/28 payroll paid each NY BA their Sep 26 to Oct 9 claim a second time instead of Oct 10 to 23.
-- Gianni: "Let's build this" (a payroll list per check date in the app, and a check right after each payroll is
-- submitted), and the differences are "added or subtracted from their next payroll reimbursement".
-- Only the accounts in ba_qbo_bookers see or change any of it. The page changes adjustments only through the RPCs
-- below; the job on Gianni's Mac (~/bookkeeping-automation/qbo/ba-payroll-watch.mjs) writes ba_payroll_checks through
-- the Management API (postgres). Applied from Gianni's Mac: node ~/claude-sql/run-sql-ca.mjs supabase/ba-payroll-checks.sql
-- Safe to run again. No names, amounts or email addresses here: the first adjustments are seeded outside this public repo.

-- ── 1. adjustments ─────────────────────────────────────────────────────────────────────────────────────────────
-- An amount added to (cents > 0) or taken off (cents < 0) one person's reimbursement on one payday. What to type into
-- Gusto for them that payday = their approved claim for the period it pays + every adjustment on that payday that isn't
-- cancelled. Rows are never deleted or edited: a change is a cancel plus a new row. A carry moves part of an adjustment
-- to a later payday as a pair of rows (one on each payday, same carry_group), so the sum of a person's rows is always
-- the whole settlement.
create table if not exists public.ba_reimb_adjustments (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id),
  company           text not null check (company in ('filifera', 'wtny', 'wafgus')),
  check_date        date not null,
  cents             integer not null check (cents <> 0 and abs(cents) <= 10000000),
  reason            text not null check (length(btrim(reason)) between 1 and 500),
  source_check_date date,                                                -- the payroll where the difference arose
  carried_from      uuid references public.ba_reimb_adjustments(id),    -- a carry half: the row it moved part of
  carry_group       uuid,                                                -- both halves of one carry share it
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  cancelled_by      uuid
);
create index if not exists ba_reimb_adjustments_day on public.ba_reimb_adjustments (company, check_date) where cancelled_at is null;
create index if not exists ba_reimb_adjustments_person on public.ba_reimb_adjustments (profile_id) where cancelled_at is null;
create index if not exists ba_reimb_adjustments_from on public.ba_reimb_adjustments (carried_from) where carried_from is not null;

-- ── 2. what the Mac found in each payroll right after it was submitted ─────────────────────────────────────────
-- One row per Gusto payroll (regular or off-cycle) of the three BA companies, written and rewritten by the Mac's check
-- while the payroll can still change. sig = a hash of each person's reimbursement amounts (a re-run changes it).
-- lines: [{gusto_uuid, profile_id (null: not linked to the app), name, period_start, claim_status ('approved',
--   'submitted', 'draft', 'rejected', 'none', null when not linked), approved_cents (null: no claim), adjust_cents,
--   expected_cents (null: nothing to compare), paid_cents, kind, tone ('ok', 'info', 'warn'), text}]
-- kind: 'ok' | 'adjusted' (ok, with an adjustment) | 'late' (the extra is an earlier approved claim no payroll paid) |
--   'repeat' (the same amount as this person's previous payroll) | 'earlier' (an earlier period's claim, already paid) |
--   'mismatch' | 'unpaid' (an approved claim with nothing paid) | 'unapproved' (paid while the claim isn't approved) |
--   'outside' (Gusto paid someone not linked to the BA app) | 'offcycle' (an off-cycle payroll paid a reimbursement).
create table if not exists public.ba_payroll_checks (
  company      text not null check (company in ('filifera', 'wtny', 'wafgus')),
  payroll_uuid text not null,
  check_date   date not null,
  period_start date,
  period_end   date,
  off_cycle    boolean not null default false,
  processed_at timestamptz,                  -- when Gusto processed (submitted) it
  deadline     timestamptz,                  -- Gusto's payroll deadline: it can be cancelled in Gusto until then
  sig          text not null,
  status       text not null check (status in ('ok', 'problems', 'error')),
  lines        jsonb not null default '[]',
  summary      text,
  checked_at   timestamptz not null default now(),
  alerted_at   timestamptz,
  alerted_sig  text,
  primary key (company, payroll_uuid)
);
create index if not exists ba_payroll_checks_day on public.ba_payroll_checks (company, check_date);

do $$
declare t text;
begin
  foreach t in array array['ba_reimb_adjustments', 'ba_payroll_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ba_qbo_read on public.%I', t);
    execute format('create policy ba_qbo_read on public.%I for select to authenticated using (public.ba_qbo_can_book())', t);
  end loop;
end $$;

-- ── 3. what the page can ask for ───────────────────────────────────────────────────────────────────────────────
-- a regular payday of this company that Gusto hasn't run yet (as far as the Mac's tables know: ba_qbo_paydays is
-- refreshed hourly, ba_payroll_checks within minutes of a submit)
create or replace function public.ba_reimb_payday_open(p_company text, p_day date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ba_qbo_paydays d where d.company = p_company and d.check_date = p_day and not d.processed)
     and not exists (select 1 from public.ba_payroll_checks c where c.company = p_company and c.check_date = p_day and not c.off_cycle);
$$;

-- p = {profile_id, company, check_date, cents, reason, source_check_date?}
create or replace function public.ba_reimb_adjust_add(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_profile uuid := nullif(p->>'profile_id', '')::uuid;
  v_company text := nullif(p->>'company', '');
  v_day     date := nullif(p->>'check_date', '')::date;
  v_cents   bigint := nullif(p->>'cents', '')::bigint;
  v_reason  text := btrim(coalesce(p->>'reason', ''));
  v_source  date := nullif(p->>'source_check_date', '')::date;
  v_id      uuid;
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  if v_profile is null or not exists (select 1 from public.profiles where id = v_profile) then raise exception 'Pick who this is for.'; end if;
  if v_company is null or v_company not in ('filifera', 'wtny', 'wafgus') then raise exception 'Pick the company that pays them.'; end if;
  if not exists (select 1 from public.ba_qbo_people q where q.profile_id = v_profile and q.company = v_company) then
    raise exception 'That person isn''t paid by that company in Gusto.';
  end if;
  if v_cents is null or v_cents = 0 or abs(v_cents) > 10000000 then raise exception 'Type an amount above zero.'; end if;
  if length(v_reason) = 0 then raise exception 'Say why, in a few words.'; end if;
  if length(v_reason) > 500 then raise exception 'Keep the reason under 500 characters.'; end if;
  if v_day is null or not public.ba_reimb_payday_open(v_company, v_day) then raise exception 'Pick a payday Gusto hasn''t run yet.'; end if;
  insert into public.ba_reimb_adjustments (profile_id, company, check_date, cents, reason, source_check_date, created_by)
  values (v_profile, v_company, v_day, v_cents::integer, v_reason, v_source, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- move p_cents of an adjustment (same sign as what it still holds on its payday, at most all of it) to a later payday
-- that Gusto hasn't run: one row takes it off this payday, one adds it to the later one (same carry_group)
create or replace function public.ba_reimb_adjust_carry(p_id uuid, p_cents bigint, p_to date) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r       public.ba_reimb_adjustments;
  v_left  bigint;
  v_group uuid := gen_random_uuid();
  v_id    uuid;
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  select * into r from public.ba_reimb_adjustments where id = p_id for update;
  if r.id is null or r.cancelled_at is not null then raise exception 'That adjustment is already gone.'; end if;
  -- what it still holds on its own payday: itself, less what earlier carries already moved off that payday
  select r.cents + coalesce(sum(a.cents), 0) into v_left from public.ba_reimb_adjustments a
   where a.carried_from = r.id and a.check_date = r.check_date and a.cancelled_at is null;
  if p_cents is null or p_cents = 0 or v_left = 0 or sign(p_cents) <> sign(v_left) or abs(p_cents) > abs(v_left) then
    raise exception 'Carry part of what this adjustment still holds on its payday, at most all of it.';
  end if;
  if p_to is null or p_to <= r.check_date then raise exception 'Carry it to a later payday.'; end if;
  if not public.ba_reimb_payday_open(r.company, r.check_date) or not public.ba_reimb_payday_open(r.company, p_to) then
    raise exception 'Both paydays must be ones Gusto hasn''t run yet.';
  end if;
  insert into public.ba_reimb_adjustments (profile_id, company, check_date, cents, reason, source_check_date, carried_from, carry_group, created_by)
  values (r.profile_id, r.company, r.check_date, (-p_cents)::integer, 'Carried to ' || to_char(p_to, 'FMMon FMDD'),
          r.source_check_date, r.id, v_group, auth.uid());
  insert into public.ba_reimb_adjustments (profile_id, company, check_date, cents, reason, source_check_date, carried_from, carry_group, created_by)
  values (r.profile_id, r.company, p_to, p_cents::integer, left(r.reason, 440) || ' (carried from ' || to_char(r.check_date, 'FMMon FMDD') || ')',
          r.source_check_date, r.id, v_group, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- cancel an adjustment: a carry half cancels its whole carry, and anything carried on from what is cancelled goes too.
-- Refused once Gusto has run any payday it touches (what was paid stays as paid; add a new adjustment instead).
create or replace function public.ba_reimb_adjust_cancel(p_id uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r     public.ba_reimb_adjustments;
  v_ids uuid[];
  v_n   integer;
begin
  if not public.ba_qbo_can_book() then raise exception 'Only Gianni can do this.'; end if;
  select * into r from public.ba_reimb_adjustments where id = p_id for update;
  if r.id is null or r.cancelled_at is not null then raise exception 'That adjustment is already gone.'; end if;
  with recursive fam(id) as (
    select a.id from public.ba_reimb_adjustments a
     where a.cancelled_at is null and (a.id = r.id or (r.carry_group is not null and a.carry_group = r.carry_group))
    union
    select a.id from public.ba_reimb_adjustments a join fam on a.carried_from = fam.id where a.cancelled_at is null
  )
  select array_agg(distinct id) into v_ids from fam;
  if exists (select 1 from public.ba_reimb_adjustments a
              where a.id = any(v_ids) and not public.ba_reimb_payday_open(a.company, a.check_date)) then
    raise exception 'Gusto already ran a payday this touches, so it stays as paid; add a new adjustment instead.';
  end if;
  update public.ba_reimb_adjustments set cancelled_at = now(), cancelled_by = auth.uid()
   where id = any(v_ids) and cancelled_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── 4. adjustments follow their payday ─────────────────────────────────────────────────────────────────────────
-- The booking worker moves a payday's check_date when Gusto expects a later day for a late payroll (WTNY's Nov 7 to 20
-- payroll went from 11/25 to 11/30) and to the real day once it is processed. The adjustments on that payday move with it,
-- so they are never left on a day no payday has (and cancel and carry keep working).
create or replace function public.trg_ba_reimb_follow_payday() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.company = old.company and new.check_date is distinct from old.check_date
     and not exists (select 1 from public.ba_qbo_paydays d
                      where d.company = old.company and d.check_date = old.check_date and d.period_start <> old.period_start) then
    update public.ba_reimb_adjustments set check_date = new.check_date
     where company = old.company and check_date = old.check_date and cancelled_at is null;
  end if;
  return new;
end $$;
revoke all on function public.trg_ba_reimb_follow_payday() from public, anon, authenticated;
drop trigger if exists ba_reimb_follow_payday on public.ba_qbo_paydays;
create trigger ba_reimb_follow_payday after update of check_date on public.ba_qbo_paydays
  for each row when (old.check_date is distinct from new.check_date) execute function public.trg_ba_reimb_follow_payday();

do $$
declare f text;
begin
  foreach f in array array['ba_reimb_adjust_add(jsonb)', 'ba_reimb_adjust_carry(uuid, bigint, date)', 'ba_reimb_adjust_cancel(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.ba_reimb_payday_open(text, date) from public, anon, authenticated;
