# Working in this repo

Read this before changing anything. It is loaded by every Claude session opened in this folder.

This repo hosts several Wizard Trees web apps on GitHub Pages. More than one person's Claude
changes it, and every change goes straight to `main` with no branches and no pull requests. The
person asking for a change should never have to touch git. These rules keep that safe.

## Every change, every time

1. **Pull first.** Run `git pull --rebase --autostash origin main` before reading or editing anything. Someone
   else may have pushed since your last change, and editing a stale copy is how work gets lost.
   `--autostash` sets aside unsaved edits already in the folder (other people's work in progress)
   and puts them back afterwards; never discard them to make a pull succeed.
2. **Make only the requested change.** Edit only the files the request needs.
3. **Check it.** Run the check for the app you changed: NY Packaging `node tests/ny-check.mjs`,
   Production Pipeline `node tests/pipeline-check.mjs` and `node tests/pipeline-write-check.mjs`.
   If anything fails, fix it before pushing.
   Never push a failing check.
4. **Commit only your files, by name.** `git add <file> <file>`, never `git add -A` or `git add .`:
   this folder holds other people's unfinished work that must not ride along. Write the commit
   message as one plain sentence about what changed for the user.
5. **Push.** `git push origin main`. If it is rejected because someone pushed first, run
   `git pull --rebase --autostash origin main`, run the check again, and push again. Never force-push. Never
   rewrite, reset or revert someone else's commit unless the person you are working for asks.
6. **Confirm it is live.** GitHub Pages takes about a minute. Fetch the live page and look for a
   piece of text from your change before saying it is done.
7. **Report in plain English.** What changed, where to see it, and anything the person must do.

If a rebase conflicts on lines someone else just changed, keep both changes where they fit
together. If they truly contradict each other, stop and ask; do not pick a winner silently.

## NY Packaging app

- **File:** `labor-calculator-ny.html` (one self-contained page).
- **Live:** https://claude759.github.io/salt-flat/labor-calculator-ny.html
- **Who uses it:** the NY packaging crew, all day. A broken push breaks their board, so step 3 is
  not optional.
- **Who changes it:** Gianni and Kelsey (NY packaging lead), each through their own Claude.
- **Kelsey's sessions change only NY app files:** `labor-calculator-ny.html`, `tests/ny-*`,
  `supabase/ny-*.sql`, and this file. Every other app in this repo belongs to someone else.

### Adding a page

A page is two pieces and nothing else:

- a tab button in the nav: `<button class="tab" data-tab="mypage" data-beta>My page</button>`
- a container in `<main>`: `<div id="view-mypage" hidden> ... </div>`

The tab switcher finds them by name. **A new page keeps `data-beta` until its owner says it is
ready**: the crew does not see it, and it shows only when the address ends in `?beta`, for
example https://claude759.github.io/salt-flat/labor-calculator-ny.html?beta . Removing
`data-beta` is the launch.

### Data

- The app reads and writes live tables in a Supabase database shared with other apps. Everything
  saved from the page is real data the crew sees.
- **Structure changes** (a new table, a new column, a new access rule) can only be applied from
  Gianni's computer. Write the SQL to `supabase/ny-<what-it-does>.sql`, commit it, and tell the
  person to ask Gianni to apply it. Build the page so it keeps working before that happens.
- Never delete or bulk-update rows you did not create. Never run an UPDATE or DELETE without a
  WHERE that names exactly the rows meant.
- Timesheet rows marked **Gusto** are written by an hourly sync from Gusto on Gianni's computer.
  Hand edits to those rows are overwritten by the next sync; fix hours in Gusto instead.

### Decisions already made (add new ones here, so both Claudes know them)

- **Overtime is not a raise.** NY overtime is weekly, over 40 hours, and WTNY's Gusto week runs
  Saturday to Friday. A day with overtime shows a blended rate so hours times rate equals the day's
  gross pay, and carries a blue OT pill.
- **Uploaded (non-Gusto) workers are $25/hr.** Gusto workers use their roster rate.
- **Task costs absorb the day's actual payroll.** Each day's worked pay is spread over that day's
  task hours, so task totals always add up to real payroll.
- **5-pack units are single 0.7g sticks**, five per box.
- **Vape carts carry no weight.** They are costed per unit and stay out of every dollars-per-pound
  figure.
- **Sick pay** rows come from Gusto with no clock times and show a Sick Pay pill.

## Production Pipeline app

- **File:** `pipeline.html` (one self-contained page).
- **Live:** https://claude759.github.io/salt-flat/pipeline.html
- **What it is:** the CA harvest, trim and packaging plan from Victoria's DISTRO PIPELINE sheet as
  a week board, plus Strains, Supplies, Batches, Inventory and Plan vs actual pages.
- **Who uses it:** Victoria, the CA distro crew and Gianni. A broken push breaks their board, so
  step 3 is not optional.
- **Who changes it:** Gianni and Victoria (production manager), each through their own Claude.
- **Victoria's sessions change only Production Pipeline files:** `pipeline.html`,
  `tests/pipeline-*`, `supabase/pipeline-*.sql`, and this file. Every other app in this repo
  belongs to someone else. The sheet save program is Gianni's, not hers:
  `supabase/functions/pipeline-sheet-write/`, `tests/pipeline-write-check.mjs` and
  `supabase/pipeline-edits.sql`.
- **The check** (`node tests/pipeline-check.mjs`) makes sure the page is whole, its script parses,
  every page is wired up, and the sheet readers and models still give the right answers.

### Adding a page

A page is three pieces:

- a button in `<nav class="views">`: `<button type="button" data-view="mypage" data-beta>My page</button>`
- a section beside the others: `<section id="view-mypage" hidden> ... </section>`
- one entry in the `RENDER` list in the script, `mypage: () => renderMyPage()`, plus that function

New pages get the board's light look by themselves. **A new page keeps `data-beta` until its owner
says it is ready**: the crew does not see it, and it shows only when the address has `?beta`, for
example https://claude759.github.io/salt-flat/pipeline.html?beta . Removing `data-beta` is the
launch. The check fails if one of the three pieces is missing.

### Where the data comes from

- **The plan** (Week board, Strains): the DISTRO PIPELINE tab of Victoria's WIZARD TREES workbook,
  read live by the browser every few minutes. **Supplies:** the DISTRO SUPPLY and ACCESSORY SUPPLY
  tabs, read the same way. The sheet is the source of truth: to change the plan, change the sheet.
- **Editing the sheet from the page** (release 1a, November 2026, not switched on yet): an Edit
  button shows only with `?beta`, only for people listed in `pipeline_editors`, and only from this
  week on. Every write goes through the save program in `supabase/functions/pipeline-sheet-write/`,
  which checks each edit against the sheet as it is right now; `CONTRACT.md` there is the agreement
  between the page and the program. The page builds edits in its EDIT MODEL block. Add no other
  way to write to the sheet, and don't loosen what the program refuses from the page side.
- **Everything else is copied into the database by jobs on Gianni's computer**, and the page reads
  the copies: the sheet's red cells every 5 minutes, the Batch Label Sheet hourly (with test dates,
  COA dates and THC from Metrc and the lab's COA emails), the 2026 TRIM SHEETS hourly (pounds
  trimmed, and the estimates for trims to come), and Distru and Nabis stock every 30 minutes. Plan
  vs actual also reads the CA task tracker (labor-calculator.html) directly.
- Those jobs live on Gianni's computer, not in this repo, so Victoria's Claude cannot change them.
  If a change needs a job to read something new, build the page so it works without it and tell
  Victoria to ask Gianni.
- **Structure changes** (a new table, a new column, a new access rule) can only be applied from
  Gianni's computer. Write the SQL to `supabase/pipeline-<what-it-does>.sql`, commit it, and tell
  the person to ask Gianni to apply it. Build the page so it keeps working before that happens.
- **Nothing private goes in this repo:** the repo and the page are public. Never commit the
  workbook's id, any other file id, a token, a key or an email address. The page gets the
  workbook id from the database after sign-in.

### Trying a change before pushing

- Serve this folder (for example `python3 -m http.server 8000`) and open
  `http://localhost:8000/pipeline.html?wb=<workbook id>&beta`. On localhost only, `wb` skips the
  sign-in and shows the Week board, Strains and Supplies from the live sheet. The id is the part
  of the sheet's address between `/d/` and `/edit`; use it in the address bar only.
- Batches, Inventory, Plan vs actual, red cells and trim pounds need a signed-in session, so check
  those on the live page after pushing (Victoria's login sees every page).

### Decisions already made (add new ones here, so both Claudes know them)

- **The board reads like the sheet.** Light page, days across, one lane per kind of work, solid
  fills like the sheet (trim light green, testing pale yellow). Trim and Who's on are one bubble
  per day; strain rows show the sheet's amounts in a pill ("500 5pk · 450 1g"). Details only on
  click, and a click opens only the item clicked.
- **Removed on purpose, do not bring back:** a label column down the left of the board, the key
  under the board, section header rows inside the board, the highlight-a-name chips and the strain
  search (a Go to date box replaced them), and the Details/Compact toggle on laptops.
- **The board scrolls sideways through the weeks** without paging, with a summary strip on top of
  each week.
- **Red on the sheet is red on the app** (red fill, red text, or some red words), and only while
  the cell still holds the text that was marked.
- **Units.** The task tracker's "5pk produced" counts sticks (divide by 5 for boxes); its labeled
  counts are boxes. A 5-pack is five 0.7g sticks. Jar plans are in pounds: 1 lb = 129.6 jars of 3.5g.
- **Plan vs actual.** The batch sheet's counts are the official actual; the task tracker is a
  reconciling line. Reaching 90% of plan counts as on plan. Labor shows person-hours, never dollars.
- **Jar jobs without pounds.** Since late October 2026 jar jobs read "STRAIN --- 3.5G & 1.5G
  BUDTENDER SAMPLE" with no amount. Plan vs actual compares jars counted only for strains that have
  pounds on the sheet; jars of the others are shown beside the plan, and Inventory's "coming" leaves
  them out.
- **Trim estimates** = room lights x the site's average pounds per light over its last 3 trims
  (bigs plus littles). Trims under 1.2 lb per light are partial and left out of the average.
- **Inventory.** On hand = Distru ready + Distru in testing + Nabis available. Coming = planned
  packaging not counted yet, plus upcoming trims as bulk pounds (their packaging is not planned
  yet), within 2 weeks, 4 weeks or everything planned.
- **Batch Label Sheet THC:** labeled rows carry the COA's Total THC x 1.10; rows not labeled yet
  carry the COA value.
- **Strain names:** Jungle Juice is Antidote. M8, Voodoo and Medusa stay separate, except on the
  trim sheets, where M8 and Medusa mean Voodoo.
