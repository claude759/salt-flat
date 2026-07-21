-- ============================================================================
--  Wizard Trees NY Labor Tracker · THE ROSTER IS THE DISTRO CREW · 2026-07-21
-- ----------------------------------------------------------------------------
--  Gianni: "it's just these people" — the tracker's roster is the distro team,
--  six Packaging Techs on Distro Hourly. Brand Ambassadors and Cultivators are
--  on the same Gusto company but are not this tracker's crew, and Kelsey Meyer
--  (Post Harvest Manager, Distro Salary) leads the team and stays out of it.
--
--  Rates come from the Gusto rate export.
--
--  This list is also what scopes the nightly Gusto import: hours land only for
--  people on this roster (~/gusto-sync/import-ny.mjs).
--
--  Safe to re-run: it converges the roster on exactly these seven.
-- ============================================================================

insert into public.ny_roster (id, last, first, team, default_company, default_rate, aliases, active) values
  ('bee00001-0000-4000-8000-000000000004','D''Haiti',        'Murphy','Packaging Tech',      'Wizard Trees NY', 23.00, array['Murph'], true),
  ('bee00001-0000-4000-8000-000000000008','Gomez-Sarmiento','Leslie','Packaging Tech',      'Wizard Trees NY', 23.00, null,           true),
  ('bee00001-0000-4000-8000-000000000010','Gonzalez',       'George','Packaging Tech',      'Wizard Trees NY', 23.00, null,           true),
  ('bee00001-0000-4000-8000-000000000012','Herrera',        'Luis',  'Packaging Tech',      'Wizard Trees NY', 23.00, array['Lu'],    true),
  ('bee00001-0000-4000-8000-000000000014','Marcial',        'Harry', 'Packaging Tech',      'Wizard Trees NY', 23.00, null,           true),
  ('bee00001-0000-4000-8000-000000000018','Velazquez',      'Irene', 'Packaging Tech',      'Wizard Trees NY', 23.00, null,           true)
on conflict (id) do update set
  last            = excluded.last,
  first           = excluded.first,
  team            = excluded.team,
  default_company = excluded.default_company,
  default_rate    = excluded.default_rate,
  aliases         = excluded.aliases,
  active          = excluded.active;

-- everyone else came from the first, too-wide seed
delete from public.ny_roster
 where id not in (
   'bee00001-0000-4000-8000-000000000004','bee00001-0000-4000-8000-000000000008',
   'bee00001-0000-4000-8000-000000000010','bee00001-0000-4000-8000-000000000012',
   'bee00001-0000-4000-8000-000000000014','bee00001-0000-4000-8000-000000000018');

select last, first, team, default_rate from public.ny_roster order by last;
