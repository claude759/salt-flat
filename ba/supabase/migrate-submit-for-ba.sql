-- ── submitted_by: who pressed Submit ───────────────────────────────────────
-- Managers can now submit a period on behalf of someone on their team (Maddy for the
-- NY crew). That makes "who submitted this?" a real question — a BA already reported
-- a period as having "submitted on its own" when in fact someone submitted it for
-- them, and nothing in the record could confirm it either way.
--
-- approved_by already existed for the approval half; this is its twin.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

alter table public.submissions add column if not exists submitted_by uuid references public.profiles(id);
comment on column public.submissions.submitted_by is
  'Who pressed Submit. NULL (or equal to ba_id) = the BA submitted their own period; '
  'anyone else = a manager submitted it on their behalf.';

-- Verify:
--   select s.status, p.full_name as ba, b.full_name as submitted_by
--     from submissions s join profiles p on p.id=s.ba_id
--     left join profiles b on b.id=s.submitted_by where s.submitted_by is not null;
