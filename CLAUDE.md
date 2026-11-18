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
   Production Pipeline `node tests/pipeline-check.mjs`, `node tests/pipeline-write-check.mjs`,
   `node tests/pipeline-sync-check.mjs` and `node scripts/pipeline-ci/check-sql.mjs`.
   If anything fails, fix it before pushing.
   Never push a failing check.
4. **Commit only your files, by name.** `git add <file> <file>`, never `git add -A` or `git add .`:
   this folder holds other people's unfinished work that must not ride along. Write the commit
   message as one plain sentence about what changed for the user.
5. **Push.** `git push origin main`. If it is rejected because someone pushed first, run
   `git pull --rebase --autostash origin main`, run the check again, and push again. Never force-push. Never
   rewrite, reset or revert someone else's commit unless the person you are working for asks.
6. **Confirm it is live.** GitHub Pages takes about a minute. Fetch the live page and look for a
   piece of text from your change before saying it is done. A Production Pipeline push also starts
   the Pipeline deploy job (below): check that its run for your commit passed before saying it is done.
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
  `tests/pipeline-*`, `supabase/pipeline-*.sql`, `supabase/pipeline-order.txt`,
  `supabase/functions/pipeline-*/` (the sheet save program and the sync programs), and this file.
  Every other app in this repo belongs to someone else. The deploy machinery stays Gianni's:
  `.github/workflows/pipeline-deploy.yml`, `scripts/pipeline-ci/` and `supabase/postgres/`.
- **The checks** (`node tests/pipeline-check.mjs`, `pipeline-write-check.mjs`,
  `pipeline-sync-check.mjs`, and `node scripts/pipeline-ci/check-sql.mjs`) make sure the page is
  whole, its script parses, every page is wired up, the sheet readers, models, save program and sync
  programs still give the right answers, and the SQL files are safe for the deploy job.

### How database and program changes go live (no Gianni needed)

- Every push to `main` that touches the pipeline runs the **Pipeline deploy** job on GitHub
  (`.github/workflows/pipeline-deploy.yml`, live since 2026-11-11). It runs the checks, then applies
  each file in `supabase/pipeline-order.txt` whose text changed, as the database role
  `pipeline_owner`, and deploys each `supabase/functions/pipeline-*` folder that changed.
- `pipeline_owner` owns the `public.pipeline_*` tables and functions and nothing else. A change that
  needs anything outside them (another app's table, `schedule_board`, auth, cron, pg_net, Vault)
  still has to be applied from Gianni's computer.
- A new SQL file goes in `supabase/pipeline-<what-it-does>.sql`, starts with `set role pipeline_owner;`,
  ends with `reset role;`, must be safe to run again, and gets a line in `supabase/pipeline-order.txt`.
  A failing file rolls back alone and the run goes red; fix it and push again.
- Watch the run at https://github.com/claude759/salt-flat/actions/workflows/pipeline-deploy.yml , or
  without signing in: https://api.github.com/repos/claude759/salt-flat/actions/workflows/pipeline-deploy.yml/runs?per_page=3 .
  Never put `[skip ci]` in a pipeline commit: it skips the deploy.
- Who may edit the sheet from the app, the edit switches, and the cloud sync jobs are set on the
  **Admin** page (beta, pipeline admins only), not in SQL.

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
- **Editing the sheet from the page** (releases 1a and 1b, ON for Victoria's real sheet since
  2026-11-12: Gianni switched on rewrites and adds on all three tabs): an Edit
  button shows only with `?beta`, only for people listed in `pipeline_editors` (admins add them on
  the Admin page), and only from this week on. Each save can be undone from its Done card. A + on
  each day's header in the Week and Month views (same rules, from today on) opens Add for that day. Every write goes through the save program in `supabase/functions/pipeline-sheet-write/`,
  which checks each edit against the sheet as it is right now; `CONTRACT.md` there is the agreement
  between the page and the program. The page builds edits in its EDIT MODEL block. Add no other
  way to write to the sheet, and don't loosen what the program refuses from the page side.
  Release 1b (built November 2026, beta) adds an Add row to a day's view: Copy a line, Jars, or
  Who's on. It writes one merged one-row line in the first empty row under that day's last line,
  styled like a matching line Victoria already has, never inserts rows, and refuses a full day.
  Each kind is switched on separately (`pipeline_write_settings.kinds_on`: 'rewrite', 'add'), on
  the Admin page. The save program reaches the real workbook only through its "anyone with the
  link: editor" sharing; if that sharing is ever tightened, share the workbook with the program's
  Google account (pipeline-writer) by name as an Editor first, or every save is refused.
- **The Batch Label Sheet** (the BATCH LABEL SHEET tab of the same workbook as DISTRO PIPELINE since
  2026-11-11) is read live by the browser every few minutes since 2026-11-13, through `BATR`, a word-for-word
  copy of the parser in `supabase/functions/pipeline-batches-sync/job.js` (the check fails if they
  differ: change job.js, then copy it again). Its hourly copy (`pipeline_batches`) still runs: COA links
  come from it by Metrc UID (a CSV has no links), and it is the fallback when the tab can't be read.
- **Everything else is copied into the database by jobs**, and the page reads the copies: the
  sheet's red cells every 5 minutes, the 2026 TRIM SHEETS hourly
  (pounds trimmed, and the estimates for trims to come), and Distru and Nabis stock every 30
  minutes. Plan vs actual also reads the CA task tracker (labor-calculator.html) directly.
- **Red cells, trim sheets and the batch sheet have cloud versions in this repo**
  (`supabase/functions/pipeline-{marks,trims,batches}-sync/`, deployed 2026-11-11 and switched
  off). Their timers run in the database since 2026-11-11 (red cells every 5 minutes, trims and
  the batch sheet hourly); a job that is off answers at once and does nothing. An admin moves each job
  off, then shadow (compares only), then write, on the Admin page, after pasting its source link
  there; the Mac jobs keep running until then. Victoria's Claude can change these.
- **These stay on Gianni's computer** and Victoria's Claude cannot change them: the lab dates and
  THC (from Metrc and the lab's COA emails), Distru and Nabis stock, the COA watcher that fills the
  Batch Label Sheet, and the hourly backup copy of the sheet's tabs (the restore point if a sheet
  edit goes wrong). If a change needs one of them to read something new,
  build the page so it works without it and tell Victoria to ask Gianni.
- **Structure changes** (a new table, a new column, a new access rule) on pipeline tables ship with
  the push (see "How database and program changes go live"). Build the page so it keeps working
  while the run is in flight.
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
- **"Not in task tracker" flags.** A past day the sheet planned pre-rolls or jars and the task tracker
  has nothing for them gets an orange "Not in task tracker" bubble in that lane's tracker row, and
  counts as "not logged" (not "late") in the week strip. Logging the work clears it by itself. Anyone
  who can open the page can Dismiss one from its card, for everyone (`pipeline_flag_dismissals`,
  written only by `pipeline_flag_dismiss()`); the day's task tracker card then says who dismissed it,
  with Undo. Plan vs actual still lists those days as having nothing in the tracker.
- **Lab results before each Nabis pickup** (`pickupCoa()`). Each pickup from today on is checked
  against the strains its drop's testing line names: their Batch Label Sheet rows of the drop's own
  product (flower, or pre-rolls for a pre-roll drop), sampled from 5 days before the drop's first
  testing day to 3 days after its last. A strain is back, failed, or expected on the day Excelbis's
  usual turnaround gives (from the day the sample left, else from the planned testing day). The
  pickup gets "COA not back" when that day is on or after the pickup, "COA tight" when it is within 2
  days, 1 sample in 10 would be late, or a sample is past the 9-in-10 day; "Failed test" when the newest
  result failed. Shown as a tag on the pickup (never a fill), a section in its card, and "N COA risk" in
  the week strip. A testing line that names two drops gives no strains from a bracketed list.
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
- **Vapes on the Batches page** (Gianni, 2026-11-13). Excelbis tests the all-in-one vapes, but vapes
  never get rows on the Batch Label Sheet. The Batches view lists them in a Vapes band after Finished,
  from `pipeline_batch_labs` (the hourly lab job on Gianni's computer reads every Excelbis COA e-mail):
  a result is a vape when the COA's Type (else its Matrix) says vape, cart, concentrate, extract or
  distillate and its Metrc batch tag isn't on the sheet (`BAT.vapes()`). One group per lab order, the
  newest 3 shown. The batch code is the maker's (the COA's Batch#), THC is the COA's Total THC (not the
  x 1.10 label figure), Test is the COA's Collected day. Vapes stay out of the lab turnaround that
  dates expected COAs and the pickup lab check.
- **Lab results box** (top of Batches, 2026-11-13, after Gianni couldn't find new results at the bottom of
  the page): results back in the last 2 weeks per lab order (`BAT.labNews()`; a COA date typed on the
  sheet counts too) and samples still at the lab with their expected day. Show narrows the list to
  those batches until "Show all batches".
- **Test date opens the lab's order e-mail** (Gianni, 2026-11-13): the Confident "placed order" e-mails
  are copied hourly into `pipeline_lab_orders` by the lab job (cleaned of scripts, images and links) and
  shown in a sandboxed frame that runs and loads nothing. Matched by the COA's sample id, else by strain
  and the day the sample went out, within 3 days (`BAT.orderFor()`).
- **Batches read as a timeline** (Gianni, 2026-11-13): each batch is one step track (`btTrackHTML`), in
  its product's real order: flower Harvest, Trim, Test, COA, Pack, Pickup (packed after its COA); pre-rolls
  Harvest, Trim, Roll, Test, COA, Pickup (rolled before testing); vapes Test, COA. Done steps are filled,
  a blank step before a done one (or a blank Trim before any known later step) is passed, the next step
  is orange, planned or expected dates are dashed, a failed COA ends the track, finished batches have no
  next step. Rows with no UID, code, dates or THC are listed by name under their group.
- **Editing batches from the app** (Gianni's decisions, 2026-11-13; built 11/13, beta, the BATCH LABEL SHEET
  tab still switched off on the Admin page; a pen on each batch with a Metrc UID; `?beta&dry` checks a
  change against the live sheet without writing; save program CONTRACT.md "Release 1c"): through the save
  program only; Status, PCKG DATE, NABIS P/U DATE, TOTAL UNITS and BUDTENDER UNITS only (Status is a type-to-search
  box, Gianni's rule for every dropdown: `EDIT.pickFrom` takes the exact status in any case, else the one status that
  contains the text; anything else is refused and the last good status stays); a save finds its
  batch by Metrc UID and column header, never a row number; never the COA watcher's columns or formula
  cells; rows without a Metrc UID are not editable at first; ships switched off; the first real save is
  one value Victoria actually wants, after dry runs, with Undo. Later, Add a batch inserts a row under
  the drop's last batch (the no-insert rule is lifted for this tab only).
- **Every pick-list on the page is typable** (Gianni's rule for everything built for him, 2026-11-13; the last plain
  selects converted 2026-11-15): a text box with suggestions (input + datalist), never a `<select>` (the check fails on
  one). Add's Line to copy ("day · words"), Who / Add someone, and the Admin page's scope boxes resolve what was typed
  with `EDIT.pickFrom` (the exact entry in any case, else the one entry that contains it); anything else is refused and
  the last good choice stays. A suggestion picked from the list is used at once; typed text waits for Enter or leaving
  the box, so typing "Lor" never adds someone on the way to a longer name. Enter in a picker never saves the card, and
  Save pressed straight from a picker box first shows what it picked (`ED_PRESS`), so nothing is saved unseen.
- **Each step of a batch's track is clickable** (Gianni, 2026-11-13: "I want each column clickable"). A step is a
  button that opens a small card under it (a bottom sheet on phones), drawn from `BSTEP.card` (the BATCH STEP MODEL
  block) and the row's facts: Harvest (day, room, site, trim sheet pounds, and the Metrc harvest from
  `harvestReport(row)`, below), Trim (days, trim sheet tab, pounds, "rolled
  from flower batch X", or why the trim isn't known), Test (when the sample went out, the lab's order e-mail, the order
  on Confident LIMS), COA (day, result, THC, the COA link or the Confident results, the expected day), Pack/Roll and
  Pickup. Each has "Show <day> on the Production schedule". No links inside a step: they live in its card. For an
  editor (the pen's rules), Pack/Roll and Pickup cards have a Change date box whose Save opens the batch card on that
  date and saves through it (same checks, dry run, Done and Undo). The batch card's top is the batch's track with
  those two dates under their bubbles; Status and units stay below it. One card at a time: the pen and "open it"
  close the step card (a day typed there goes into the batch card, unsaved), and a step click never opens beside a
  batch card with a change. A step card's facts are keyed by the sheet row (`BSTEP.rowKey`), never the UID alone, since
  one UID can be typed on two rows. Save is checked again at the press and after each read; when it can't go ahead the
  card stays open with the typed day and the reason. The order link is the one the batch's lab sample number names; an
  order e-mail matched only by strain never overrides it, and says so when it is all there is.
- **The Harvest step shows the Metrc harvest, with a printable report** (Gianni, 2026-11-13: "Harvest (pdf harvest
  report from Metrc)"). Metrc's API has no harvest PDF, so the page draws its own from `pipeline_harvests` and
  `pipeline_batch_harvests` (filled every 3 hours by the job on Gianni's Mac). Pure part: the HARVEST MODEL block
  (`HARV`); page part: `harvestReport(row)`, `loadHarvests`, `bpopHvHTML`, `openHarvestPrint`. Harvest names repeat
  across sites, so a linked name is the harvest under the batch's own site (its code's; a pre-roll's is the one flower
  batch it was rolled from, `btFlowerOf`), else under the license the job linked, else the only harvest of that name,
  flagged "Metrc lists this harvest under X; the batch code says Y" when sites differ; several and none at the batch's
  site: each is shown, saying the name is used at more than one site. A blend mixes sites by design, so the batch's
  site (and that flag) applies only to the part harvested on the batch's own day; its other parts go by the linked
  license, else their only harvest (no flag), else every candidate. A linked name with no harvest row says "Not read
  from Metrc yet"; a tag with no link says "No Metrc harvest is linked to this batch yet" plus the 3-hour hedge, on
  paper too (a batch new to the sheet reaches the job in up to about 4 hours, so never "Metrc has none"). Strain:
  Metrc's, else the sheet's (strain codes without names exist). Weights in pounds first, grams small; a finished
  harvest's current weight is "Left at finish (moisture loss)", never "Still in harvest" (Metrc writes it off at the
  finish). A blend lists one folded section per harvest, oldest first. Each section lists the other batches on the sheet from that harvest; a click
  shows just that batch (the Lab results box's Show filter; it clears a typed search first). Print / Save as PDF opens a
  one-page report over the page and the print dialog; while it is open, printing prints only the report
  (`body.hv-printing`), on its own named page (`@page hvreport`, Letter portrait), so printing any other view keeps the
  browser's paper and layout. The report's timeline states come from the board's own rule (`btTrackStates`). The report is built
  from page data only: no links, images, scripts, ids beyond the batch's Metrc tag, or e-mail addresses. Egress: the
  one-row meta at each Batches read; the links and only the harvest rows linked to the sheet's batches (`.in('name')`,
  60 a request), again only when `pipeline_harvests_meta.changed_at` moves, a new batch's harvests weren't asked
  for, or on Refresh (a not-quiet read more than 30 seconds after the last). Vapes have no Harvest step. Not signed in: the card says the harvest isn't read here.
- **Batch V2** (beta, view only; Gianni 2026-11-13: "an experimental page called batch V2"): `data-view="batches2"`,
  after Batches. Since 2026-11-18 it is **the Canvas only** (below). **The Timeline was removed 2026-11-18** (Gianni:
  "drop the Timeline too", then "Yes, delete it" to deleting its code): its lanes and bubbles, the On hand column, the
  hub's In band and out rows, sales by week as bubbles, the rail, the trace overlay and Go to date are gone, and so are
  Flow's step columns (retired 2026-11-17) and the Stages columns (dropped the same day). Do not bring any of them back
  unasked. What follows is what still holds for the model, the reads and the cards the Canvas shares.
  - **The model** is the BATCH V2 MODEL block (`BT2`; pure, tested in the check). Harvests come from the DISTRO PIPELINE
    harvest lines and the batch codes (merged per room and day; a code's day wins over HRVST DATE when the room's other
    batches or a harvest line agree, else the harvest is marked amber); trims from the trim sheets (done, pounds) and the
    plan (planned); drying links a harvest to the next trim of its room whose tab lists its strains. Harvest pounds are
    the Metrc wet weight of every Metrc harvest (one per strain) of that site, room and day (`BT2.metrc`), from the
    page's own read of `pipeline_harvests` (`b2LoadMetrc`, signed in; again only when `pipeline_harvests_meta.changed_at`
    moves, the days grow, or Refresh), never the Batches page's linked-only `loadHarvests` read. Each Metrc harvest
    counts once: one with a room before one without, then the nearer day, the earlier, the lower room. Trim estimates are
    the board's. Pounds and units only, never dollars.
  - **Metrc lots** (Gianni, 2026-11-15): signed in, `b2LoadFlow` reads `pipeline_flow_lots` (one lot per site, room and
    Metrc harvest day, written hourly by the flow job on Gianni's Mac through `pipeline_flow_save`): the one-row
    `pipeline_flow_meta` each poll, the rows again only when its `changed_at` moves or on Refresh; without the table (or
    signed out) the page works as before. Lots and the Metrc harvests (2026 on) are a third harvest source in
    `BT2.build`: each joins the sheets' harvest of the same site and room within 2 days, else is a harvest of its own; a
    voided (archived) or weightless Metrc harvest is no harvest; "A / B / C" is each strain. A lot with no trim in its
    room dries to the one unclaimed trim of its site 3 to 30 days on that lists its strains (else whose plan named its
    room), else Metrc's first packaging day is its trim ("first packaged", never "trimmed"). **"Left" means our six
    licenses** (the four grows, the Filifera distro, Imperial's distro; Nabis is not counted). **Trim is by product name
    only** ("Bulk Trim" / "Trim"; Sugar Leaves is flower); left is flower in flower-equivalent pounds (jar and 5-pack
    3.5 g, 1g 1 g, pouch and pre-roll 1.5 g, vapes 0). Stock is traced by Metrc tag lineage, batch codes only as a
    fallback, never both. Blends follow their parents, each weighted by what it held when the blend was made, else split
    equally. A package Metrc archived without finishing was never made. A harvest name Metrc wrote another way still
    makes its lot. A lot's first packaging day is its earliest packaging (never a lab sample's or a sale's day). The trim
    card has "Where the pounds went" (`went`: sold bulk by buyer, Nabis, Distru, labs, written off, in transit, not read
    yet, not accounted for, still at our licenses). Today's amounts only, never worked-out past ones; the job records
    each day's numbers for a history view later.
  - **Testing** (Gianni, 2026-11-15; `BT2.labGroups`): one send per lot (samples of one lot, or one site's pre-rolls,
    sent within 2 days), placed by Metrc lineage (`pipeline_batch_harvests`, read with the Metrc harvests), else the
    sheet row; a send more than 21 days after its lot's last day is a unit of its own. Days are the Batches track's
    (`BAT.labDays`): TEST DATE, else the lab's Collected, else the manifest; COA RETURN DATE, else the COA e-mail. A COA
    still out is expected on `BAT.coaOutlook`'s day (pickupCoa's rule), late past the 9-in-10 day, gone after 30 days;
    "no COA" only while someone still waits; "not all" when the rest came back; a fail is amber, never red. A retest is a
    send of its own; a COA RETURN DATE typed ahead is not a result; a sheet date before the harvest, or a TEST DATE over 60
    days ahead, is left out and the card says to check the year. Vapes are not on Batch V2 (the Batches page's Vapes band
    has them). Lab results load on open, every 10 minutes at most on the polls (`b2Labs`), and on Refresh; signed out,
    only the sheet's dates. The lab card (`b2LabHTML`) has each batch's Test and COA facts (`BSTEP.card`, `b2StepHTML`).
  - **Pack** (Gianni, 2026-11-16; `BT2.packGroups`): from the Batch Label Sheet's PCKG DATE and counted units (the
    official actual), re-read back to 1/1/26 for Pack only (`b2PackRows`, only while the rows shown are the live read's).
    Pounds = units x grams (jar and 5-pack 3.5, 1g 1, 1.5g and pouch 1.5), never the bulk weight. Failed rows are never
    drawn (the Jars card counts them); a (UID, product) typed twice counts once. Placed as Testing places a tag
    (`BT2.placeTag`). A PCKG DATE ahead, and jars the sheet plans for a strain only one lot holds unfinished, are planned;
    when two lots hold it, nothing is drawn and both lots' cards say so. Words never say "packaged".
  - **Sales by week** (Gianni, 2026-11-16) now live only in the week and channel cards (a pickup card's "What Nabis sold
    to stores", the Distru and bulk cards): the flow job's weekly block in `pipeline_flow_meta.summary.sales` (no table;
    only the payload's units and samples), read through `b2LoadFlow`'s meta poll (`sales_sig`), the body again only when
    the sig moves; a block the page can't use is not read again until its sig moves (`B2.salesBad`) and the line under
    the title says "Couldn't read the sales.". N and D are the sales app's Sales-by-Type numbers (samples in, vapes out);
    Nabis lines dated today or later are scheduled; bulk is from Metrc by origin license, clipped at the Mac's Metrc copy
    (weekday mornings). The sales app's numbers more than 26 hours old turn the cards' source line amber.
    `pipeline_flow_save` drops a sales block whose keys name money. Never shown: store names, money, Nabis stock in
    "left", or "transferred to Distru" (Distru is our distro's software).
  - **The 25th distro** (Gianni, 2026-11-16; `BT2.hub`): the Filifera distro license in the 25th building; in 2026 it
    packed every jar, 5-pack and pre-roll, pulled every lab sample, and shipped every Nabis pickup and Distru delivery.
    "In" is only a move into the 25th distro (Metrc's move day, flower of 1 lb or more, a move between our licenses, never
    a sale; only flower moves set its days); Imperial's distro is not counted, and trim on a move that doesn't say which
    distro never counts in an In. To Nabis is one per pickup (Metrc, a transfer into Nabis's warehouse, days in a row
    joined; the sheet's planned pickups after Metrc's copy are planned, with pickupCoa's lab risk; days after today joined
    apart from today's). To Nabis and Nabis sold are never added together. Pre-roll units of grows that start, roll or
    send within 2 days of each other are one run. Data: `went.to_distro_by`, `went.nabis_by`, the sales block and the
    sheet's drops.
  - **Find** (Gianni, 2026-11-17) sits in the top row and is typable (`EDIT.pickFrom`), by lot or by strain (`F.strains`
    from `BT2.flowView`: a lot's Metrc strains, its harvest's and its trim plan's, else its trim tab's; "A / B" is each;
    "Smoothie #6" is under its own name and under Smoothie). A strain picked shows a strip under the title (`b2fStrainSync`,
    `B2.fstrain`): a button per lot that holds it, with that strain's flower still ours, "+N lots in All 2026", and
    Clear; the Canvas's other lots dim. A strain in one lot goes to it at once. Text used by leaving the box waits for the
    press under way (`B2.fdown`). The strain is never in the address. **One name per strain in Find** (`BT2.strainMerge`,
    Find only: `PIPE.strainKey` and every other page keep the names as written): spaces ("Flash Bang", "Flashbang"), a cut
    without its # when the name is known alone ("Black Light 27"), crosses written short (`FLOW_ABBR`: ZB Zangbanger, DM
    Dark Matter, LL Limelight, NY New Yorker, BM Black Magic, SM Smoothie, Zang or Zan Zangria), PHENOS, and `FLOW_SAME`.
    Not merged: W, BB, Wiz OG, a cross written the other way round. The Week board's removed strain search stays removed.
  - **The dark look** (Gianni, 2026-11-17: "Add a dark look"): Light | Dark at the right of the top row, dark by default,
    kept in the browser (`pipeline.flow.look`), never in the address. `b2fDark()` makes `render()` leave `data-light` off
    and set `body.b2f-dark`; every dark rule is scoped `body.b2f-dark ...`. Same meanings in both looks: purple for what is
    planned, amber for a warning, never red. Text at 4.5:1 or better; check a new card or row in both looks.
  - **Cards, the address, the line under the title.** Every card docks on the right on laptops (`#b2-pop`; the page
    makes room, `body.b2f-open`; `B2.hold` keeps that room through a redraw), a bottom sheet on phones; a click opens only
    the item clicked. A card's links (`data-b2`) open the harvest, trim, move ('i:'), lab, Jars, pickup ('n:'), run and
    week ('w:', 'k:') cards through `b2Open`. The item picked is in the address (`&sel=<id>`), and All 2026 (`&show=all`);
    old `&mode=` links open the Canvas. **No summary sentence** (Gianni, 2026-11-17: "this stuff is just clutter please
    remove"): the line under the title (`#b2-sentence`) says only what couldn't be read. **Open items throb** (Gianni: "a
    faint throbbing glow"): a COA still out, and a move in or a Nabis pickup Metrc hasn't marked received (`went.open_by`
    on a lot, `[[day, 'distro' | 'nabis', lb]]`, from the flow job, live since 2026-11-17; open only on a check under 6
    hours old). Never on a plan.
  - **The Stages model** (Gianni, 2026-11-17: a picture of a production-chain tool, "a bit more like this"):
    `BT2.stageView(F, HB, { outs, today, waitIn, waitPick })` over `BT2.flowView`'s lots and `BT2.stageTrace` give the
    Canvas its rows: a lot's harvest, trim, move in, test, and **a row for each packaged product** (a strain and a unit
    type: 3.5g jars, pouches, 5-packs, 1g and 1.5g pre-rolls; pouches ride their jars' row; jars follow the test,
    pre-rolls come straight from the trim), and where it went (Nabis pickups by day, Distru deliveries, Packaged and Loose
    flower still here, bulk buyers). **A click lights what the item came from in gold and where it went in blue** (gold
    is not a warning here). **Where each packaged product went is the flow job's `went.products`** (Gianni's Mac, hourly,
    since 2026-11-17): keyed by the batch's Metrc tag (the Batch Label Sheet's METRC UID), then by unit type, `{ nabis:
    [[day, units]], distru, left }`, counted from the packages made from that tag (a blend's units split equally). Units,
    never dollars; store names never shown. The card (`b2sCardHTML`) has three figures, came from, went to, and the other
    cards one press away. Planned pickups shown: today to 21 days on. Default "Last 90 days", or "All 2026" (`B2.fscope`).
  - **Canvas: Batch V2's one view** (beta, view only; Gianni, 2026-11-18, of the Stages view: "I think you
    misunderstood. I wanted view like this but combined with the timeline view in a sort of free floating space where the
    user can scroll in any direction", then "Yes, build it" to the mockup). No view buttons (`B2.mode` stays 'cv'); the
    Stages and Timeline buttons were dropped the same day and their code deleted ("Yes, delete it"); old `&mode=tl`,
    `&mode=st` and `&mode=flow` links open the Canvas. The Canvas is the
    Stages rows, each on its own day (30px a day): a lot's harvest, trim, Test and COA along one row (a test is two rows,
    the day the sample went out and the day its result came or is expected, when both are known: `BT2.canvasLab`), a
    stack of product rows (a strain and a unit type) under a heading at each packing day. **Two sections, not a strip per
    facility** (Gianni, 2026-11-18: "doesn't this get transferred to 25th first before being packaged?", then "instead
    of having rows dedicated to specific facilities there's one row for the harvest/trim grow section and one for the
    distro", then "Yes, build it" to the mockup): **Grows** on top, every facility together (Olympic too; the harvest's
    square is its grow's colour, the strip's label is the key), holding only each lot's harvest and trim; under it the
    **25th distro**, framed in blue down to the pickups' row, holding each lot's move in ("23rd RM2 · in · 85 lb", the
    model's `L.inn`, kind 'i': one per lot, its first move day to its last, flowView's pounds), then its Test, COA and
    product stacks, because every lot is tested, packed and shipped from there. The line from a trim down into its move
    is the one link with its own colour at rest (`path.mv`, `--s-mv`). In the model the test and the products hang off
    the move, not the trim; bulk buyers and flower left at the grow leave from the trim, flower left at the distro from
    the move. A move in or a pickup Metrc hasn't marked received throbs (`waitIn`, `waitPick`, the flow job's
    `went.open_by`). A lot with no move read starts its distro row at its test (which then names the lot). **A trim row has two lines**
    (Gianni, 2026-11-18: "on each trim I want the number of lbs trim (to the second decimal) and under it the what
    remains in METRC from that trim"): its pounds to two decimals (the trim sheet's bigs + littles; Metrc's flower when
    no tab has the trim; "≈" an estimate while it is planned), and under them "85.00 left in Metrc", the flower Metrc
    still shows at our licenses from that lot (`L.t.sheet`, `L.t.left`; the flow job sends packaged and left flower
    to the hundredth of a pound since 2026-11-18); a planned trim, or a lot with no Metrc lot read, has no second line. Rows are
    packed as high as they fit in their section. A row sits on its real day and moves right only where
    the one before it is still in the way; hover (or the pick) draws a band over its real day or days and rings those
    dates. **Three things stay put while it is dragged**: the dates on top (month, weekday letter, day; a month's name
    stays in view while any of its days is), the Nabis pickups on their days in the 25th distro's row at the window's
    bottom, and what has no day (Distru deliveries, Packaged and Loose flower still here, bulk buyers) in a column docked
    at the right, with a little map of the whole canvas under it (a press jumps there). It drags in any direction; Today
    puts today's line three fifths across. Model: `BT2.stageView` (the Stages model, unchanged), laid out by the pure
    `BT2.canvasLay(V, { w, today, top })` from the rows' measured widths (its `sites` are the two sections, 'GROW' and
    'HUB'; each position carries its `band`). Page: `b2cBody`, `b2cFit`, `b2cLinks`,
    `b2cGuide`, `b2cMini`, `b2cToday`, `b2cSee`, `b2cWords`, classes `b2c-*`; it is drawn in the Stages box
    (`#b2-stage`; `b2sOn()` means the Canvas), so the click, the gold and blue trail, the card (`b2sCardHTML`), Find,
    the strain's dimming, Light | Dark and `&sel=` are the Stages view's own code. Links are thin curves, faint at rest;
    those into the docked column are drawn only when lit; on a scroll only the links into the pickups' row and the
    docked column are drawn again. One set of rules for both looks (the `.b2s` box's `--s-*` variables; no
    `body.b2f-dark .b2c-` rules). Phones: the box scrolls natively, the column sits under it and its links are not drawn.
    A change of the lots shown opens on today again (or on the item picked). Not on the Canvas, and so not shown anywhere
    in Batch V2 since the Timeline went: sales to stores by week as rows (the week cards still have them) and the On hand
    column (what is still ours is the docked column's Still here rows and each lot's card).
- **COGS page** (beta; Gianni, 2026-11-17: "can we have a page for COGS? Let's start with flower COGS for each facility
  ... track non-packaging costs over the grow cycle up to harvest and divide things like labor, utilities, rent ect over
  the number of rooms", "I want this to be a page on the production pipeline app"). `data-view="cogs"`, hidden until
  `cogs_can_view()` says yes: only the accounts in `cogs_viewers` (Gianni and Victoria, his choice) see the tab or can read
  the numbers. **The one page that shows dollars**; "Labor shows person-hours, never dollars" stands everywhere else.
  Its SQL (`supabase/cogs.sql`) and its job (`~/ar-automation/cogs-sync.mjs` with `lib/cogs-core.mjs`, 20 minutes after
  each financials update) are Gianni's: applied from his computer, owned by postgres, never by the deploy job. Never move
  the viewer list or the data into `pipeline_*` tables, never put a number in the page source, and never cache it in the
  browser. The page only draws the one row (`cogs_snapshot`); the method lives in cogs-core.mjs: each grow's own books
  (Slane = 23rd, Imperial = 15th, Filifera = 25th) plus Imperial's rent and utilities paid outside QuickBooks, with pay
  read from the payrolls themselves (below); left out: royalties, Scott's pay, interest, taxes, the books' tax depreciation, bought flower,
  packaging, testing, Nabis fees and distro pay. Every day a grow's costs are shared among its flower rooms by lights (his choice); a harvest
  carries its room's share from the day after the room's previous Metrc harvest to its own. 25th: power, water,
  cultivation pay and growing supplies count in full, shared costs at 3 rooms of 4, the distro counted as one more room
  (his choice). Rent, power and water, security and insurance are spread evenly at the last 12 closed months' average.
  Licenses and permits (Gianni, same day: "annual licensing fees like dcr and dcc renewal should be divided by 12 and split
  evenly over each harvest"): each payment counts a twelfth a month for the 12 months from its month (one in the books'
  first year also stands for the year before), shared equally by the rooms, not by lights. The three cultivation managers
  work for all three grows (Gianni: their pay is split "between each company by number of lights"): all of it is shared
  among the three grows by lights, day by day; never name anyone or anyone's pay in this repo (code, commits, notes); the page names people only from the private snapshot (below). Equipment and building work on the books (his choice, "Spread over useful life"): every
  addition to a grow's fixed-asset accounts counts a month at a time, equipment over 5 years, building work over 10 or
  to the end of the lease (23rd St: June 2028); packaging tools stay with the distro. Trim pay is its own column (his
  choice), charged to the trims by pounds (by payday, below). Per pound = (grow + trim) / bigs + littles on the trim sheets. Olympic shows
  what Filifera paid (bought, not grown). "High" (over 1.2 times the grow's middle finished harvest per pound) and "Low
  yield" (under 0.8 times its pounds per light) are amber tags. Each cost line of a harvest opens the accounts behind it
  and how the harvest's part was worked out (Gianni: "I'd like to be able to click on these rows"). Corrections found
  while costing packaging (same day): the harvest crew's bills follow where the crew worked by the shift app from July
  2026 (harvest shifts to that grow; packaging, Portal's void pouches and Olympic's harvests to no grow); 25th's
  Intercompany Labor Income isn't netted (that crew is paid in Distro Wages, left out); brand ambassadors' pay booked in
  Filifera's undepartmented Wages is selling, left out; distro staff paid through a grow company stay with the distro.
  **Pay by payday** (Gianni, 2026-11-18: "It might be better to pull the data from Gusto and the payroll app?", "the
  non-gusto trim pay from the payroll app should be down here"): QuickBooks' wage and payroll-tax accounts are Gusto's
  journal entries, so from each company's first Gusto payroll they are left out and pay is read from every processed Gusto
  payroll (`lib/cogs-pay.mjs`, private cache `data/cogs/pay-gusto.json`: per employee id only name, gross, employer taxes,
  benefits, hours and Gusto department) and from the payroll app's paydays (the old workbooks before it) through the cash
  book. Gusto departments make the groups (they tie to QuickBooks to the dollar): Cultivation / Cultivation Hourly / Salary
  are crew (the three managers apart), Trim are trimmers, Owner, Distro, Sales and BA are left out, no department is crew
  (25th: shared at 3 of 4, like its pay outside Gusto). Each payday counts evenly over the days it paid for (Gusto's pay
  period; the app's hourly crew and salaried people the two weeks ending 5 days before payday), never the check date.
  This also moved 15th St's trimmers' Gusto pay, booked in Imperial's general Wages since February 2026, out of grow crew
  pay into trim. Trim: the trimmers move between the grows and the app's trim bills reuse old names, so each payday's
  trim pay (every company's Trim department in Gusto plus the cash book's trim pay outside Gusto) is shared by every trim,
  at all grows, done in the days it paid for, by pounds (a payday with no trim in its days looks a week either side,
  twice). Trim days after the newest payday whose trim bills are in the payroll app count at the pay a pound of the trims
  done in the six weeks before ("part estimated"), and Gusto trim pay for those days waits for that payday. Trim pay
  before the 2026 trim sheets begin (2025) has no trim to land on and is reported, not charged. **The click-open boxes**
  (Gianni, same day: "all of these more-info bubbles are very messy"): each cost line opens one box, its amount, one
  sentence and one plain table: pay by payday (paid, the days, through Gusto, outside Gusto, this harvest; managers: all
  three grows, this grow's share), trim by pay period (trim pay of all grows, pounds trimmed then, this trim), bills
  booked in the month by account and month of the cycle, spread-evenly costs by the 12 months' total (bills month by month
  on a click), licenses by payment, equipment by purchase. **Cultivator payroll** (the line's name since 2026-11-18,
  Gianni: "grow crew pay, should be Cultivator payroll"; wages plus the employer's payroll taxes, Social Security, Medicare
  and unemployment, which Gusto charges on each person's first $7,000 of the year) and **Cultivation managers** open By
  person (Gianni, same day: "On click, I want these to show names"), each person's hours, wages, employer taxes and part of
  the harvest, or By payday. The names are in the `cogs_snapshot` row only, which only `cogs_viewers` can read; they never
  go in this repo, a commit or the page source.
  **Packaged tab** (his answers 2026-11-17): each Batch Label Sheet batch of jars (pouches inside), 5-packs and 1g from
  August 2026 carries flower at its source harvest's flower-page cost per pound by Metrc lineage (littles cost the same
  as bigs: "Same $/lb as bigs"; Olympic at the invoice price), the standard BOM at the lot price in use (private
  `~/ar-automation/lib/pack-bom.json`) with Mallen's noted, unbilled freight as its own line ("Count it now"), the crew's
  tracker hours through the run they were packed in at each day's real shift-app wages plus employer taxes, and $399 a
  lab sample. Distro overhead (its one-room-of-four share of 25th's shared costs, the distro departments' pay less the
  crew already charged, packaging equipment) is its own line per unit, spread by crew hours ("Its own line per unit").
  Engine `lib/cogs-pack.mjs` in the same job. No revenue or profit yet.
- **Strain names:** Jungle Juice is Antidote. M8, Voodoo and Medusa stay separate, except on the
  trim sheets, where M8 and Medusa mean Voodoo.
- **The app and the sheet stay interchangeable during the move** (Gianni, 2026-11-10: "I want them
  to feel like they can use this or the sheet until they're comfortable only using this"). For the
  production sheet (DISTRO PIPELINE and the supply tabs) that means what the app writes into the
  sheet looks as if Victoria typed it, and changes made in the sheet show in the app within minutes.
  The Delivery/Visit schedule is the BA app's own schedule; its app-made tasks live in the app, as
  they always have.
- **The Week tab is called "Production schedule"** ("Production" on phones). Its key is still
  `week` (`data-view="week"`, `#view=week` links, the CSS and the script); change only the words.
- **Lane buttons** (beta, behind `?beta`): a row of small solid buttons in the schedule's toolbar,
  one per lane in board order and the sheet's fills: Who's on, Harvest, Trim, Jars, Pre-rolls,
  Testing, Nabis & orders, Supplies & other, plus All. None pressed shows everything; pressing some
  shows only those lanes on the week board, the day panel, the phone's day view and the month. The
  week strip, the urgent bar and the sentence above the board still count everything. The choice
  lives in the address (`&lanes=jars,prerolls`), never in the sheet. These are not the removed
  highlight-a-name chips.
- **Month view** (beta): a Week | Month toggle in the toolbar (Day | Week | Month on phones), drawn
  by the script (`data-wkmode`), not a page of its own. One row per week, Monday first, each row the
  board's own week model, so a run that crosses Sunday continues on the next row. A click opens only
  the item clicked; a day's header opens the whole day; the week strip offers "Show this week on the
  board". Rows cap at about 6 tracks, then "+N more" per day (supplies hidden first). Phones get a
  compact grid with a thin stripe per kind of work. Address: `&mode=month&month=YYYY-MM`. The
  removed-on-purpose list applies here too.
- **Delivery/Visit schedule tab** (beta, right of Production schedule): the BA app's CA schedule
  shown inside the pipeline. Its code lives in `ba/` and is Gianni's, not Victoria's; the pipeline
  side only hosts it. The frame opens `ba/index.html?embed=schedule&board=CA` (same site, same
  sign-in), sits in a fixed box outside `<main>`, loads in the background after the board draws when
  `schedule_states()` lists CA, and is never moved. Messages, each side checking the origin and the
  other window: the frame sends `{source:'ba-schedule', status:'loading'|'ready'|'signed-out'|
  'no-access'|'error', board:'CA', message?}`; the page sends `{source:'pipeline', type:'show'}`
  when the tab opens and `{source:'pipeline', type:'refresh'}` for Refresh. The frame shows only
  after it has answered; with no answer in 12 seconds (an old BA build) the page drops it and offers
  a link to the BA app, so the whole BA app never shows inside the pipeline.
