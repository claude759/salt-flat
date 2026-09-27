-- Reminders keep going out until each person submits (Gianni 2026-09-26: "as a rule, make
-- sure the reminder emails keep going out until the BAs submit their reimbursement/mileage").
-- Applied to the live project 2026-09-26.
--
-- Before: ONE reminder per period, the morning after it ended (pay_periods.reminder_sent_at
-- stamped it "done"), then the app locked the period Sunday 11am. Anyone who hadn't
-- submitted by then was never reminded again and could not submit without an admin reopen.
--
-- Now (ba-notify job:'reminder', same 9am cron):
--   · every morning, anyone with an ended, not-closed period (ending 2026-09-25 or later)
--     that they haven't submitted gets a reminder, until they submit (or tap Nothing to
--     claim) or an admin approves / marks the period done for them (Mark done button);
--   · the app keeps that period open to THEM (late submit) so the email is always actionable;
--   · someone with no mileage or expenses submits "nothing to claim" to stop the reminders.
--
-- reminder_log is one row per person, period and LA calendar day: it stops a double send if
-- the job runs twice in a day, and numbers the follow-ups. Only the service role writes it.
-- Safe to re-run.
create table if not exists public.reminder_log (
  id         bigserial primary key,
  ba_id      uuid not null references public.profiles(id) on delete cascade,
  period_id  uuid not null references public.pay_periods(id) on delete cascade,
  sent_on    date not null,
  sent_at    timestamptz not null default now(),
  unique (ba_id, period_id, sent_on)
);
comment on table public.reminder_log is
  'One row per reminder email: person, pay period, LA calendar day. Written by ba-notify only.';
alter table public.reminder_log enable row level security;
drop policy if exists reminder_log_admin_read on public.reminder_log;
create policy reminder_log_admin_read on public.reminder_log
  for select to authenticated using (public.admin_sees_ba(ba_id));

-- This morning's (Sat Sep 26, 9:00) once-only reminder for the Sep 12-25 period, so tomorrow
-- counts as a follow-up. The six people still unsubmitted at the time of this migration.
insert into public.reminder_log (ba_id, period_id, sent_on, sent_at)
select p.id, pp.id, date '2026-09-26', pp.reminder_sent_at
  from public.pay_periods pp
  join public.profiles p on p.email in ('cesar@wizardtrees.com','drew@wizardtrees.com','joanna@wizardtrees.com',
                                        'keelin@wizardtrees.com','leticia@wizardtrees.com','makenna@wizardtrees.com')
 where pp.end_date = '2026-09-25' and pp.reminder_sent_at is not null
on conflict (ba_id, period_id, sent_on) do nothing;

select count(*) as backfilled from public.reminder_log;
