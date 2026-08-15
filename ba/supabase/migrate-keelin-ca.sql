-- ── Keelin moves FL → CA, and her FL history stays FL ──────────────────────
-- Every trip/expense/hours row carries the `state` it was logged in (stamped by
-- trg_item_state_default at insert), so her 83 FL hours are already marked FL and a
-- region change cannot rewrite them. What DID need fixing is the report: it decided
-- which region a row belonged to from the person's CURRENT region, so the moment she
-- became CA her $19,747 of FL labor would have shown up in the CA report as well.
-- ba/index.html now attributes each row by the row itself (linked store's state →
-- the row's own state → the logger's region only for rows with neither).
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

-- ── 1. no row should be left without a state to be attributed by ────────────
-- (5 legacy expenses predate the state stamp; give them their owner's region)
update public.expenses e
   set state = coalesce(p.region, p.home_region)
  from public.profiles p
 where p.id = e.ba_id and e.state is null and coalesce(p.region, p.home_region) is not null;

-- ── 2. the move ─────────────────────────────────────────────────────────────
-- She was the FL regional admin; she becomes a California BA. Her pay rate is left
-- exactly as it is ($35.00/hr) — change it separately if CA should differ.
update public.profiles
   set role = 'ba', region = 'CA', home_region = null
 where email = 'keelin@wizardtrees.com';

-- Verify — her history stays FL, and nothing of hers is CA yet:
--   select coalesce(state,'(null)') as state, count(*), sum(amount)
--     from public.hours where ba_id=(select id from profiles where email='keelin@wizardtrees.com')
--    group by 1;
--   -- expect: FL | 83 | 19747.57
--
-- Undo:
--   update public.profiles set role='admin', region='FL' where email='keelin@wizardtrees.com';
