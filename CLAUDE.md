# Working in this repo

Read this before changing anything. It is loaded by every Claude session opened in this folder.

This repo hosts several Wizard Trees web apps on GitHub Pages. More than one person's Claude
changes it, and every change goes straight to `main` with no branches and no pull requests. The
person asking for a change should never have to touch git. These rules keep that safe.

## Every change, every time

1. **Pull first.** Run `git pull --rebase origin main` before reading or editing anything. Someone
   else may have pushed since your last change, and editing a stale copy is how work gets lost.
2. **Make only the requested change.** Edit only the files the request needs.
3. **Check it.** For the NY Packaging app run `node tests/ny-check.mjs`. If anything fails, fix it
   before pushing. Never push a failing check.
4. **Commit only your files, by name.** `git add <file> <file>`, never `git add -A` or `git add .`:
   this folder holds other people's unfinished work that must not ride along. Write the commit
   message as one plain sentence about what changed for the user.
5. **Push.** `git push origin main`. If it is rejected because someone pushed first, run
   `git pull --rebase origin main`, run the check again, and push again. Never force-push. Never
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
