-- Reopen the Aug 29 to Sep 11 period for Leti Granados and Makenna Luffborough
-- (applied to the live project Mon 2026-09-14).
--
-- Both were still "not submitted" when the extended window closed Sunday 11pm.
-- edit_until is period-wide (see migrate-period-reopen.sql): it reopens editing
-- for everyone in the period who has not submitted, which right now is Leti,
-- Makenna, Amanda (unsubmitted on request) and Drew. Submitted/approved rows stay
-- locked by their submission status regardless.
--
-- Window: through end of day Tuesday Sep 15 (11pm Los Angeles, the same cutoff
-- convention the admin Reopen button uses). Extend or shorten by re-running with
-- a different instant, or from the admin page.
update public.pay_periods
   set edit_until = timestamptz '2026-09-15 23:00:00 America/Los_Angeles'
 where end_date = '2026-09-11';

select end_date,
       to_char(edit_until at time zone 'America/Los_Angeles', 'Dy Mon DD, HH12:MI AM') as open_until_la,
       edit_until > now() as reopened_now
  from public.pay_periods where end_date = '2026-09-11';
