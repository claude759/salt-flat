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
- **Batch V2** (beta, view only, Gianni 2026-11-13: "an experimental page called batch V2 ... a left/right
  scrollable timeline showing harvests and trims"; reshaped 2026-11-15: "all companies shown vertically without having to
  scroll down", "remove the crap at the bottom", "Don't split them up by room, each bubble can just say H: RM1: ###lbs
  (more info on click)"): `data-view="batches2"`, after Batches. Lanes: the four grows (23rd, 15th, Olympic, then 25th's grow),
  always all four, then the 25th distro; each named by a strip above it, never a label column. A lane packs its items into as few tracks as keep them
  from overlapping (`BT2.pack`, greedy by start day, bubbles' real widths); a harvest, its dotted drying line and the trim
  it dried for are one unit on one track. All sites fit the window on a laptop (tracks 34px down to 24px); the box scrolls
  only sideways. Bubbles say only "H: RM1: 412 lbs" / "T: RM1: 132 lbs" / planned "T: RM1: ≈111 lbs" (`BT2.bubble`;
  "RM?" when the room isn't known; no pounds when none are known): harvest pounds are the Metrc wet weight of every Metrc
  harvest (one per strain) of that site, room and day (`BT2.metrc`), from the page's own read of `pipeline_harvests` for
  the timeline's days (`b2LoadMetrc`, signed in; again only when `pipeline_harvests_meta.changed_at` moves, the days grow,
  or Refresh), never the Batches page's linked-only `loadHarvests` read, which would show part of a room. Each Metrc
  harvest counts once: a harvest with a room before one without, then the nearer day, the earlier, the lower room. Trim
  pounds are the trim sheets or the estimate. Everything else (strains, crew, batches, drying days, the Metrc harvests) is in the card a click opens. Nothing
  under the timeline; what can't be placed isn't drawn. Underneath, harvests and trims keep their rooms: harvests from the
  DISTRO PIPELINE harvest lines and the batch codes (merged per room and day; a code's day wins over HRVST DATE when the
  room's other batches or a harvest line agree, else the harvest is marked amber); trims from the trim sheets (done,
  pounds) and the plan (planned, dashed); drying links a harvest to the next trim of its room whose tab lists its
  strains. Model in the BATCH V2 MODEL block (`BT2`).
  - **Metrc lots, pounds left and the On hand column** (Gianni, 2026-11-15: each trim bubble gets a second number, how
    much is still available in Metrc; scrolling right, bubbles that still have product collect in a column on the left;
    data back to 1/1/26). Signed in, the page reads `pipeline_flow_lots` (one lot per site, room and Metrc harvest day,
    written hourly by the flow job on Gianni's Mac through `pipeline_flow_save`) in `b2LoadFlow`: the one-row
    `pipeline_flow_meta` each poll, the rows again only when its `changed_at` moves or on Refresh; without the table (or
    signed out) the page works as before. Lots, and the Metrc harvests the page reads (2026 on), are a third harvest
    source in `BT2.build`: each joins the sheets' harvest of the same site and room within 2 days, else is a harvest of its
    own, so one room-day is never drawn twice; a Metrc harvest that was voided (archived) or has no wet weight is no
    harvest, and a strain written "A / B / C" is each of its strains. A lot with no trim in its room dries to the one unclaimed trim of its site
    3 to 30 days on that lists its strains (or, when the strains can't tell, whose plan named its room; the sheets name
    Olympic's rooms differently from Metrc), else Metrc's first packaging day is its trim ("from Metrc"; its cards say
    "first packaged", not "trimmed" or "days drying"; no packaging day known, no such trim). A trim with lots reads "T: RM3: 115 · 15 left" (`BT2.bubble`, measured
    before packing): the first number stays the trim sheet's bigs + littles (Metrc's packaged flower only when no tab
    has it), the second is flower still at our licenses, with a thin bar filled by left / packaged and an amber dot when
    the lot is partial. **"Left" means our six licenses** (the four grows, the Filifera distro and Imperial's distro;
    Nabis, Garden of Weeden, is not counted). **Trim is by product name only** ("Bulk Trim" / "Trim"; Sugar Leaves is flower); left is
    flower in flower-equivalent pounds (jar and 5-pack 3.5 g, 1g 1 g, pouch and pre-roll 1.5 g, vapes 0); trim left is
    in the card. **Stock is traced by Metrc tag lineage**, batch codes only as a fallback, never both. **Blends** follow
    their parent packages, each weighted by what it still held when the blend was made, else split equally (the lot's
    note says so). A package Metrc archived without finishing (voided, made again under a new tag) was never made: not
    packaged, not written off. A harvest name Metrc wrote another way ("F3-SmoZang-010626", "A-Wizzy12202025") still
    makes its lot (the room from its first part, the day from Metrc's start day). A lot's first packaging day is the
    earliest packaging, first line out of a grow package, or package made from it (never a lab sample's or a sale's
    day). No "being processed" stage. Pounds and units
    only, never dollars. The trim's card has "Where the pounds went" (the lot's `went`: sold bulk by buyer, Nabis,
    Distru, labs, written off, in transit, not read yet, not accounted for, still at our licenses), left by place and lab
    stage, trim, and the job's note. **The On hand column is Gianni's own request, a column of lots, not the removed
    label column**: a sticky panel at the left of each site's lane inside the scroll box (bubbles slide under it),
    headed "Still on hand today". It lists that site's lots trimmed by the first day right of it (a lot's day is its
    trim's first day, else Metrc's first packaging day) that still have flower **today** (`BT2.onHand`), oldest first,
    as chips "RM3 10/7 · 15 lb". **Today's amounts only, never worked-out past ones** (the critique: derived history
    would be wrong); the job records each day's numbers (data/flow/daily on Gianni's Mac) and its weekly `series`
    uses those recorded weeks, for a history view later. Lots under 5 lb fold into one "+N small · X lb" chip; the
    site's total on top ("<1 lb" under half a pound, as the chips say); amber (never red) when first packaged more than
    30 days ago; chips past the lane's room become "+N more" (lanes take the window's spare height first). It is drawn
    again on scroll (one frame at a time) only when a lane's chips change. A chip opens its lot's card; "+N small" and "+N more" open only the
    lots they stand for, each with the strains that still have flower (Gianni, 2026-11-16: "on click, these popups give
    more information only about the thing that was clicked on"); phones' "N lots" opens the site's list. A redraw reopens a card by the element it was opened from (a bubble, else the chip). Phones show the total and an "N lots" button. Go to date and Today place the day a third of the way
    into what the column leaves in view.
  - **Fills the page; future bubbles glow purple** (Gianni, 2026-11-15: "I want this to vertically fill the page, also for
    any future/projected bubbles I want a purple glow/outline"). On laptops the timeline ends at the window's bottom:
    tracks grow to 40px, the spare height is shared by the lanes (the On hand column's needs first) and each lane's tracks
    spread over it; it draws again when what sits above it changes height. A planned harvest, a trim not done yet (its
    estimate included) and its drying line carry a purple outline and glow (#7C3AED); past plans that never happened
    don't. Projected bubbles added later (expected lab results, projections) glow the same way.
  - **Testing bubbles** (Gianni, 2026-11-15: "we'll also need bubbles for when stuff is sent for testing and when we
    receive the testing results back"): Test and COA bubbles in the board's testing yellow (COA deeper), one pair per
    send, never one per batch (samples of one lot, or one site's pre-rolls, sent within 2 days are one send). Sends are
    drawn in the 25th distro (samples are pulled there), on their lot's chain (Metrc lineage through
    pipeline_batch_harvests, read with the Metrc harvests in `b2LoadMetrc`, else the sheet row); a send more than 21
    days after its unit's last day is a unit of its own. Pre-rolls get a unit per site and send (the lineage's site; with several, the code's site when it
    is one of them, else the site with most source harvests; no lineage: the sheet harvest's, else the code's). Vapes
    are not on Batch V2 (the Batches page's Vapes band has them). Days are the Batches track's (`BAT.labDays`): TEST
    DATE, else the lab's Collected, else the manifest; COA RETURN DATE, else the COA e-mail. A COA still out is dashed
    purple on its expected day (`BAT.coaOutlook`, pickupCoa's rule), at today once past it, amber " · late" past the
    9-in-10 day; after 30 days with nothing back it is gone, and the Test reads amber " · no COA" only while someone
    still waits: its sheet row isn't finished or Done, or it has no row and went within the sheet reader's 120 days
    (a tag sent before that is one the reader no longer lists: not flagged). When the rest of the send came back, the
    flag goes on its COA instead, amber " · not all". A fail is amber " · N fail", never red. A new sample sent after a
    tag's results (the lab job's newest manifest after its COA, or a TEST DATE typed after the COA RETURN DATE: a
    retest) is a send of its own, at the lab, and the earlier one keeps its result. A COA RETURN DATE typed ahead is
    not a result. A sheet TEST DATE or COA RETURN DATE before the batch's harvest, or a TEST DATE over 60 days ahead (a
    year typed wrong), is left out for the lab's day and the card says to check the year. The sentence counts each
    sample at the lab once ("5 samples at the lab, results about Wed Nov 18. 1 more past the usual day."), and says
    when the Metrc lineage couldn't be read (tried again on each poll).
    Planned sends from the pipeline sheet's testing lines are not drawn yet (only a TEST DATE typed ahead and projected
    COAs glow purple). Words only "Test: RM1" / "COA: RM1" ("Test: Pre-rolls"; on the lot's chain in the 25th distro, short of room,
    "Test" / "COA"); never a bare number. A testing bubble never cuts the bubble before it: it moves on (`BT2.row`).
    Everything else is in the card a click opens (`b2LabHTML`): days and sources, the result, the lab's order e-mail,
    the order on Confident LIMS, the day on the Production schedule, the batches on the Batches page, and each batch's
    own Test and COA facts (BSTEP.card, drawn by `b2StepHTML`, not the Batches page's `bpopHTML`). Lab results load on
    open, every 10 minutes at most on the polls (`b2Labs`), and on Refresh; signed out, only the sheet's TEST DATE and
    COA RETURN DATE are drawn.
  - **Pack bubbles and sales by week** (Gianni, 2026-11-16: "it doesn't look like anything for sales has been added
    yet, we also need packaging bubbles to be added"). Pack: one orange bubble per lot and pack day ("Jars: 41 lbs";
    "Jars: RM3: 41 lbs" when packed more than 21 days after the lot's last step, drawn as its own unit), and for
    pre-rolls one per site and day in the model, drawn in the 25th distro as runs (the hub bullet: rolls of several
    grows within 2 days are one bubble, "Pre-rolls: 39 lbs" with a square per grow, their sends one Test and one COA),
    from the Batch Label Sheet's PCKG DATE and counted units (the official actual). Pounds = units x grams (jar and
    5-pack 3.5, 1g 1, 1.5g and pouch 1.5), never the bulk weight and never Metrc's first packaging day (that is the
    trim). Failed rows are never drawn (each lot's Jars card counts them, a row with no PCKG DATE by its HRVST DATE or
    code day); a (UID, product) typed twice counts once. Placed as Testing places a tag
    (`BT2.placeTag`: Metrc lineage, the sheet harvest, then, for rows older than the 120-day reader, the batch code,
    the code's room and day, a flower batch of the same strain and day). Batch V2 re-reads the tab back to 1/1/26 for
    Pack only (`b2PackRows`), and only while the rows shown are the live read's (else the hourly copy's 120-day rows,
    never an older live read); harvests and Testing keep the 120-day rows. Jars packed while a send of the lot is at the
    lab (after its Test, before its COA) stay on the lot's chain but are drawn after that COA (`g.after`,
    `BT2.evOrder`), so Test, the at-lab line and the COA keep their days; the card gives the PCKG DATE. The Lot row
    says the trim's room when the trim sheet names it differently ("trimmed Oct 20-21 as RM2"). A PCKG DATE ahead,
    and jars the pipeline sheet plans for a strain only one lot holds unfinished (rule 1), are dashed with the purple
    glow; when two lots hold it, nothing is drawn and both lots' cards say so. Words never say "packaged".
    Sales by week (Nabis to stores, Distru, each grow's bulk) come from the flow job's weekly block in
    `pipeline_flow_meta.summary.sales` (no table; it reads only the payload's units and samples, never index 6, and its
    sig leaves out the payload's time). N and D are the sales app's Sales-by-Type numbers (the Monday e-mail; samples
    in, vapes out); distro deliveries that arrived before Jan 13 come from Metrc's distro lines, by the day they arrived
    (as the sales app files Distru's; in 2026 there are none: Distru's first invoices are the deliveries that left Jan
    12, never counted twice). Nabis lines dated today or later are scheduled: their week reads "≈17 sold" with the purple
    glow; a week over by the page's today counts them as sold (the job's today can lag: a run before midnight, a Mac
    asleep), never the glow. Bulk is from Metrc by origin license, clipped at the last day Metrc's weekly copy has
    read, with a grey hatch to today. Read through `b2LoadFlow`'s meta poll (`sales_sig`; no new poll, the poll and
    Refresh lines are unchanged), the body again only when the sig moves (or on Refresh); a block the page can't use (a
    newer version, a week that isn't a Monday) is not read again until its sig moves (`B2.salesBad`), and the sentence
    says "Couldn't read the sales."; signed out, or before the job writes a block, no weeks. The sales app's numbers
    more than 26 hours old, or its file unread, turn the distro strip's note and the cards' source line amber.
    `pipeline_flow_save` drops a sales block whose keys name money (or that holds a $). Not shown: store names, money,
    Nabis stock in "left", or "transferred to Distru" (Distru is our distro's software).
  - **The 25th distro hub** (Gianni, 2026-11-16: "25th is the only company that sell packaged product to nabis/distru so we
    should probably give it some prominence and make it visually clear that the product from the other companies is
    transferred to it then it get's packaged then it's sold to nabis -> retailers"; "not sure I want sales by week to be
    it's own row"). The 25th distro is the Filifera distro license in the 25th building: in 2026 it packed every jar,
    5-pack and pre-roll, pulled every lab sample, and shipped every Nabis pickup and Distru delivery. Grow lanes keep only
    H, drying and T; their strips carry their bulk sales by week ("Bulk: 40 sold", Metrc, by origin license, a hatch past
    Metrc's copy) under a label as wide as the On hand column. Under the grows, framed in navy with 25th's grow
    (`BT2.HUB_ORDER`; `SITE_ORDER` and `sites()` keep theirs): the distro's strip, an In band (one cyan In per lot moved
    in, "[23rd] RM2: 85 lbs in", Metrc's move day, flower of 1 lb or more, a move between our licenses, not a sale; a cyan
    line drops from the lot's trim onto it, behind everything; rows as needed up to 3, or in the strip itself when short
    of height), the work lane (each lot's Test, COA and Jars with its grow's badge; pre-roll units of any grows that start,
    roll or send within 2 days of each other are one run, joined over chains, in it rolls within 2 days one bubble with a
    square per grow and sends within 2 days one Test and one COA), and the out rows:
    To Nabis, one per pickup ("To Nabis: 44 lbs", Metrc, a transfer into Nabis's warehouse, days in a row joined; the
    sheet's planned pickups after Metrc's copy dashed with the purple glow and the lab risk in amber, pickupCoa's rule;
    days after today joined apart from today's, so today's never takes tomorrow's glow or lab check),
    Nabis sold by week ("Nabis: 13 sold", the sales app; scheduled "≈17", glowing), Distru by week (our distro's own
    deliveries; nothing is transferred to Distru, our distro's software). Nabis and Distru fold into one row ("N 13 · D
    11 lbs") when three rows would push tracks under 26 px; then the In band folds into the strip; then, still under 24
    px, only the To Nabis row stays (its card opens Nabis's weeks) (`BT2.hubRows`). To
    Nabis and Nabis sold are never added together; In is never a sale. The In band and the out rows have panels
    (`.b2-ohb`, never `.b2-oh`, so the On hand panels still map one to one to the lanes) with each row's last 4 full
    weeks ("In · 4 wks · 192 lb", "To Nabis · 4 wks · 83 lb"; phones "In 4w 192"), each opening its 2026 by day or by
    week. The On hand column splits by place: each grow's panel lists what is still at that grow (`left_grow_lb`), the
    distro's what is at the distro by source lot (`left_distro_lb`, chips with a two-letter badge; "+N small" and
    "+N more" open only their lots, by grow, with strains, as on the grows). Badges carry each grow's name in its strip colour, so "RM1" is never ambiguous. Hover on a trim, its line
    or its In lights all three; a click opens only the item clicked (an In: its moves, the lot, what it sold in bulk from
    our licenses, what the distro did with it; a pickup: by lot, units of packages wholly one lot's until the job sends
    whole pickups, blends said apart; a run: one section per grow, a grow's own Pre-rolls or send opened from it goes by
    the run's bubble). Only flower moves set an In's days. Imperial's distro (bought-in vapes, two trim pass-throughs) is
    not drawn: trim on a move that doesn't say which distro is never counted in an In (in 2026 every trim move went to
    Imperial's; the In's card says it apart). Our distros' own bulk (Metrc's origin 'DISTRO') is a pill in the 25th
    distro's strip (none while the In bubbles ride it) and a Bulk row on its Distru and Stores week cards. "In" is only a
    move into the 25th distro: Nabis's pickups are "To Nabis" on every card and table. Data: `went.to_distro_by`, `went.nabis_by`, the sales block and the sheet's drops; no SQL
    change. Signed out: the work lane from the sheets only (no In band, no out rows, no lines). Words never cut: each
    bubble is measured on its own classes, a fit check redraws once if short, and a bubble at the On hand column (or a
    strip's label) or the box's right edge shows the longest of its words that fits what is in view.
  - **Flow, Batch V2's second mode (retired 2026-11-17: see One view below; its model, Find, strain names and dark look live on in it)** (beta, view only; Gianni, 2026-11-17: "I want it to be a very intuitive visualizer for
    the pipline of from harvest to retailer", then two pictures of stage-column tools, "I'm picturing something more like
    this", then "Yes, build it" to the mock): Timeline | Flow buttons by the title, drawn by the script (`#b2-mode`,
    `B2.mode`), not a page; the Timeline is untouched and opens first; address `&mode=flow&show=all&sel=<id>`. Columns left
    to right: Harvest (wet lb), Trim (flower lb), Bulk or distro, Test and COA, Pack, Out of the distro, Stores. One row per
    lot (a grow unit: a harvest with its trim), newest on top, so a lot that has only reached Trim stops there. Model:
    `BT2.flowView` / `BT2.flowTrace` (pure, in the BATCH V2 MODEL block); page: `b2fRender`, `b2fDraw`, `b2fSelect`, classes
    `b2f-*`. Nodes carry the Timeline's own ids (h:, the trim's, i:, l:, p:, n:), so its cards open unchanged in the panel
    (`#b2-pop`, docked right on laptops, the bottom sheet on phones); a lot's harvest, trim and move in open the lot's own
    summary (three figures, its steps with days, the trim card's "Where the pounds went"), a shared node its pounds by lot.
    **A click lights the item, what it came from and where it went, never its siblings**; the same click again, Esc, Close
    or a click elsewhere clears it. Curved links are the page's only SVG: faint hairlines at rest; lit, "came from" teal
    (#0F766E, never amber: amber is a warning here), "went to" navy, planned dashed purple, loose ends grey. **A link is
    thick only where the data holds pounds for that pair** (1 px per 6 lb, 1.5 to 16 px) and then carries its number; a
    shared row lit shows its part ("14 of 44"). **Trim's number in Flow is Metrc's flower pounds** so a lot's links add up
    to its node (bulk + into the distro + still at the grow); the trim sheet's pounds stay on the Timeline and in the card.
    A lot's Nabis pounds leave its Jars node only when it had Jars packed by the pickup's day, else its In node. Pre-rolls
    are rolled, then tested: a run sits in Pack with its lab state as a tag only when it needs a look, joined to its lots
    by hairlines (no pounds per lot). **Sales to stores are a card of weeks no link reaches** (known by week for the whole
    company, never by lot). More out than came in is said in words, never drawn. Default "Last 90 days": lots harvested in
    the last 90 days and plans up to 21 days ahead, plus any lot still holding 5 lb or more; "All 2026" has the rest (the
    page says how many it left out). "Worth a look": 5 lb or more still ours, trimmed over 30 days ago, amber. Find a lot
    is typable (`EDIT.pickFrom`). Grow tags are dark so a grow's colour never reads as a step's. Bulk buyers' names show
    (they are bulk buyers, not stores). No new read or poll, no SQL, no job change. Signed out: harvests, trims, sends and
    Jars from the sheets only. Not built yet: fold rows, a phone layout of its own (phones scroll the same columns sideways).
    **Find a lot also takes a strain** (Gianni, 2026-11-17: "Add the strain search to Find a lot"): the same typable box
    lists the lots, then the strains (`F.strains` from `BT2.flowView`: a lot's Metrc strains, its harvest's and its trim
    plan's, else its trim sheet tab's; "A / B" is each; a numbered cut, "Smoothie #6", is under its own name and under
    Smoothie). A strain picked shows a strip under the toolbar (`b2fStrainSync`,
    `B2.fstrain`): a button per lot shown that holds it, with that strain's flower still ours, "+N lots in All 2026" for
    older ones, and Clear; the board's other lots dim until a trace lights. A strain in one lot lights that lot at once.
    Nothing is rebuilt on a pick, and text used by leaving the box waits for the press under way (`B2.fdown`), so that
    press still lands. The strain is kept through redraws and the scope
    buttons, never in the address. This is Flow's Find only: the Week board's removed strain search stays removed.
    **One name per strain in Find** (Gianni, 2026-11-17: "Merge the messy strain names"; `BT2.strainMerge`, Flow's Find
    only: `PIPE.strainKey` and every other page keep the names as written). Two names are one strain when only their
    spaces differ ("Flash Bang", "Flashbang"); when a number after a name is a cut without its # and the name is known
    by itself ("Black Light 27" is "Black Light #27"; "Studio 54", "Magic Mirror 4" stay names); when a cross is written
    short (`FLOW_ABBR`: ZB Zangbanger, DM Dark Matter, LL Limelight, NY New Yorker, BM Black Magic, SM Smoothie, Zang or
    Zan Zangria, each seen on the sheets both ways with the same cut numbers); when PHENOS is added to a name known
    without it; or by `FLOW_SAME` ("Zang Bangers", "Smoothie Zangria"). The spelling most lots use is kept. Not merged,
    not known: W, BB, Wiz OG, and a cross written the other way round. Any way a strain was written still finds it, and
    the strip says "also written ...".
    **Flow has a dark look, and opens in it** (Gianni, 2026-11-17: "Add a dark look", like his pictures): a Light | Dark
    switch at the right of Flow's toolbar, kept in the browser (`pipeline.flow.look`), never in the address. Only Flow:
    `b2fDark()` makes `render()` leave `data-light` off and set `body.b2f-dark`, so the page sits on the app's own dark
    base (as Strains and Supplies do) and every dark rule is scoped `body.b2f-dark ...` at the end of the Batch V2
    styles. The Timeline, the other pages and cards opened outside Flow stay light ("the board reads like the sheet"
    stands). Same meanings in dark: each step's colour as a tint of the light fill, came from teal, went to blue, planned
    dashed purple with the glow, amber for a warning, never red. Text is kept at 4.5:1 or better on its background;
    check a new card or pill in both looks.
  - **One view: the Timeline with Flow's trace** (beta, view only; Gianni, 2026-11-17: "I kind of wanted the flow and
    timeline to be the same thing", a mockup, then "Yes, build it"). Batch V2 is one view again: the Timeline, with no
    Timeline | Flow buttons. **The step columns are retired**: nothing sets `B2.mode = 'flow'` any more (an old
    `&mode=flow` link opens the one view), and their page code (`b2fRender`, `b2fNode`, `b2fDraw`, `b2fStores`,
    `b2fSelect`, `b2fShow`, `b2fReveal`, `b2fSync`, the `.b2f-n` / `.b2f-col` styles) is dead, kept only until Gianni
    confirms the one view; delete it then, do not build on it. What Flow gave the Timeline (page: `b2tModel`,
    `b2tMarks`, `b2tDraw`, `b2tSync`, `b2tDock`, `b2tShow`, `b2tSelect`, `b2tGo`; the model is still `BT2.flowView` over
    every 2026 lot, `BT2.flowTrace`, `BT2.strainMerge`):
    **a click traces**: a bubble, an On hand chip or a lot in a card's list that the model knows lights the item, what
    it came from (teal) and where it went (navy; planned dashed purple, loose ends grey), dims the rest, and draws links
    in `#b2t-svg` (an overlay over the timeline and the rail, clipped at the On hand column) with pounds only where the
    data holds them for that pair (1 px per 6 lb, 1.5 to 16). Onward in time a link leaves a bubble's right end; within
    the same days it drops from one band to the next. The same click again, Esc, Close or a click elsewhere clears it;
    the end of a drag does not, and scrolling no longer closes a card. A week's bubble or a panel's figure opens its
    card and clears the trail. **Every card docks on the right** on laptops (`#b2-pop`, the page makes room:
    `body.b2f-open`; `B2.hold` keeps that room through a redraw, or the fit would loop); phones keep the bottom sheet.
    A lot's harvest, trim and move in open the lot's summary (`b2fLotHTML`), a send, Jars, a run and a pickup the
    Timeline's own cards, a rail line its lots (`b2fEndHTML`). **The rail** (`#b2t-rail`, right of the timeline, not on
    phones, not signed out): "Left, no day known", 2026's pounds by bulk buyer, Distru deliveries, lab samples, written
    off, not accounted for; a line lit shows its part ("48 of 379"). Never what is still ours: the On hand column has
    that, and its chips light with the trail. **Under the sentence** (`#b2t-bar`, one line each, scrolling sideways so
    the timeline keeps its height): Worth a look (hidden on windows under 780px tall, where the On hand column's amber
    chips say it), Find's message, the strain's strip (the newest 8 lots, then "+N older", which shows only those).
    **Find** sits in the top row, by lot or strain. **The dark look is the whole view's**, on by default
    (`b2fDark()`, Light | Dark at the right of the top row); every `.b2-*` dark rule is scoped `body.b2f-dark`, and a
    bubble's colour is its step's `--k` as a tint. The item traced is in the address (`&sel=<id>`); a strain is not.
    **Open items throb** (Gianni: "if tests haven't come back yet or an order transfer hasn't been marked as received
    in METRC it could have like a faint throbbing glow"): `.b2-wait`, a slow glow in the step's own colour, steady
    under prefers-reduced-motion, on a COA still out (and a Test with no COA that someone still waits for), and on a
    move in or a Nabis pickup that Metrc hasn't marked received (`went.open_by` on a lot, `[[day, 'distro' | 'nabis',
    lb]]`, from the flow job; without it nothing throbs for transfers). Never on a plan. The date header already numbers
    every day under its month.
- **COGS page** (beta; Gianni, 2026-11-17: "can we have a page for COGS? Let's start with flower COGS for each facility
  ... track non-packaging costs over the grow cycle up to harvest and divide things like labor, utilities, rent ect over
  the number of rooms", "I want this to be a page on the production pipeline app"). `data-view="cogs"`, hidden until
  `cogs_can_view()` says yes: only the accounts in `cogs_viewers` (Gianni and Victoria, his choice) see the tab or can read
  the numbers. **The one page that shows dollars**; "Labor shows person-hours, never dollars" stands everywhere else.
  Its SQL (`supabase/cogs.sql`) and its job (`~/ar-automation/cogs-sync.mjs` with `lib/cogs-core.mjs`, 20 minutes after
  each financials update) are Gianni's: applied from his computer, owned by postgres, never by the deploy job. Never move
  the viewer list or the data into `pipeline_*` tables, never put a number in the page source, and never cache it in the
  browser. The page only draws the one row (`cogs_snapshot`); the method lives in cogs-core.mjs: each grow's own books
  (Slane = 23rd, Imperial = 15th, Filifera = 25th) plus pay not run through Gusto and Imperial's rent and utilities paid
  outside QuickBooks; left out: royalties, Scott's pay, interest, taxes, the books' tax depreciation, bought flower,
  packaging, testing, Nabis fees and distro pay. Every day a grow's costs are shared among its flower rooms by lights (his choice); a harvest
  carries its room's share from the day after the room's previous Metrc harvest to its own. 25th: power, water,
  cultivation pay and growing supplies count in full, shared costs at 3 rooms of 4, the distro counted as one more room
  (his choice). Rent, power and water, security and insurance are spread evenly at the last 12 closed months' average.
  Licenses and permits (Gianni, same day: "annual licensing fees like dcr and dcc renewal should be divided by 12 and split
  evenly over each harvest"): each payment counts a twelfth a month for the 12 months from its month (one in the books'
  first year also stands for the year before), shared equally by the rooms, not by lights. The three cultivation managers
  ("Raul/Nick/Liz their gusto and non gusto pay should be split up between each company by number of lights"): their pay
  at every grow, Gusto (read per payroll by the job) and not (the cash book), is taken off where it was booked and shared
  among the three grows by lights each month; the page never names them. Equipment and building work on the books (his
  choice, "Spread over useful life"): every addition to a grow's fixed-asset accounts counts a month at a time, equipment
  over 5 years, building work over 10 or to the end of the lease (23rd St: June 2028); packaging tools stay with the
  distro. Trim pay is its own column (his choice), charged to the trims by pounds. Each cost line of a harvest opens the
  accounts behind it and how the harvest's part was worked out (Gianni: "I'd like to be able to click on these rows").
  Corrections found while costing packaging (same day): Norma's crew bills follow where her team worked by the shift app
  from July 2026 (harvest shifts to that grow; packaging, Portal's void pouches and Olympic's harvests to no grow);
  25th's Intercompany Labor Income isn't netted (that crew is paid in Distro Wages, left out); brand ambassadors' Gusto
  pay that QuickBooks booked in Filifera's undepartmented Wages is selling, left out; Nouri's cash rent is the distro's.
  **Packaged tab** (his answers 2026-11-17): each Batch Label Sheet batch of jars (pouches inside), 5-packs and 1g from
  August 2026 carries flower at its source harvest's flower-page cost per pound by Metrc lineage (littles cost the same
  as bigs: "Same $/lb as bigs"; Olympic at the invoice price), the standard BOM at the lot price in use (private
  `~/ar-automation/lib/pack-bom.json`) with Mallen's noted, unbilled freight as its own line ("Count it now"), the crew's
  tracker hours through the run they were packed in at each day's real shift-app wages plus employer taxes, and $399 a
  lab sample. Distro overhead (its one-room-of-four share of 25th's shared costs, the distro departments' Gusto pay less
  the crew already charged, distro staff paid outside Gusto, packaging equipment) is its own line per unit, spread by
  crew hours ("Its own line per unit"). Engine `lib/cogs-pack.mjs` in the same job. No revenue or profit yet. Per pound = (grow + trim) /
  bigs + littles on the trim sheets. Olympic shows what Filifera paid (bought, not grown). "High" (over 1.2 times the
  grow's middle finished harvest per pound) and "Low yield" (under 0.8 times its pounds per light) are amber tags.
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
