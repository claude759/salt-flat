# pipeline-sheet-write: how the Production Pipeline page edits Victoria's sheet

Gianni's Claude owns this folder (`supabase/functions/pipeline-sheet-write/`). Victoria's Claude
does not change it: the safety rules below live here so that no change to the page can get past
them. The page (`pipeline.html`) builds the edit; this program checks it against the sheet as it
is right now, writes it, logs it, and can undo it.

Release 1a rewrites the text of cells that already hold something, or sets a supply count. It
never creates cells, never changes colors, merges or row layout.

Release 1b also adds a one-line item to a day on DISTRO PIPELINE: it goes in the first row under
that day's last line, across the day's two columns, with the look (fill, font, colors, borders,
colored words) of a named line of the same kind, so it looks as if Victoria typed it. It merges the
pair, may clear an empty leftover merge in that row, and never inserts, deletes, hides or unhides
rows. A day with no empty row left under its last line is refused.

## The pieces

- `index.ts`: the Supabase Edge Function. Sign-in check, settings, Google token, read, check,
  write, re-read, log.
- `rules.js`: the pure rules (no network), shared by `index.ts` and `tests/pipeline-write-check.mjs`.
- `supabase/pipeline-edits.sql`: editors, settings, the edit log, cell locks, and the RPCs the
  page calls.
- Google account: a dedicated service account (`pipeline-writer`) with no roles and no domain-wide
  delegation, added by name as an Editor on the workbook (and on the test copy). Its key is the
  Supabase secret `PIPELINE_WRITER_KEY` (the whole JSON key). Never the bookkeeping service
  account: that one can read every mailbox.

## Request (POST, the user's Supabase access token in `Authorization: Bearer ...`)

```json
{
  "action": "write" | "dry" | "undo",
  "intent": "VOODOO 1g pre-rolls 600 to 450, every day of the run",
  "ops": [Op, ...],
  "undo": 123
}
```

`dry` does every check and returns what would be written without writing. `undo` takes only
`undo` (an edit id) and restores that edit's cells.

### Op: one cell

```json
{
  "tab": "DISTRO PIPELINE" | "DISTRO SUPPLY" | "ACCESSORY SUPPLY",
  "r": 649, "c": 1,
  "expect": "1G PREROLL- 600",
  "text": "1G PREROLL- 450",
  "find": { "week": "NOVEMBER, MONDAY 9TH", "day": 0, "owner": "VOODOO" },
  "number": false
}
```

- `r`, `c`: 0-based row and column as the page read them from the CSV export (hidden rows
  included). This is the same grid the Sheets API uses. `r` 649, `c` 1 is cell B650.
- `expect`: the cell's whole text as the page saw it. `text`: the cell's whole new text. Both are
  compared and written with line endings normalized (`\r\n` and `\r` read as `\n`; a cell stored
  with `\r\n` keeps `\r\n`).
- `find`: how to find the cell again when rows have moved since the page read the sheet.
  - DISTRO PIPELINE: `week` = the band's header text in column A, exactly as the CSV shows it, and
    `day` = 0 (Monday) to 6 (Sunday); `c` must be one of that day's two columns (`2*day`, `2*day+1`).
    The cell is looked for only inside that band and that day's two columns.
  - DISTRO PIPELINE, `owner` (send it for every cell in a day's right column): the text of the task
    cell the line belongs to, the way the page's parser groups them: the nearest non-empty cell in
    the day's left column at or above it inside the band (a merged cell counts on every row it
    covers). For a pre-roll size line "1G PREROLL- 600" it is the strain, "VOODOO"; for a trim's
    "ROOM 2 @ 23RD" it is "TRIM -LORENZO". Lines like "1G PREROLL- 600" appear 13 times a day, so
    without `owner` they can never be told apart. A cell in the left column is its own owner (send
    nothing, or its own text). Compared with spaces collapsed and case ignored.
  - Supply tabs: `item` = the item name (column A of its row), `category` = its ITEM category text,
    `header` = the column header (for example `23RD`, `STATUS`, `PAR`, `NOTES`). Compared with spaces
    collapsed and case ignored; the category also as the page's SUPPLY PARSER spells it (LIDS = LID).
- `number`: `true` for the site counts (23RD, 25TH, PORTAL, VOID or MYLARS) and PAR, which are
  written as numbers so the sheet's TOTAL QTY sum keeps counting them; `text` is digits with an
  optional decimal and commas ("1,500"), or empty to empty the count. `false` for STATUS, NOTES and
  every DISTRO PIPELINE cell, which are written as plain text (never parsed as a date or formula).

### Op: add a line (release 1b)

```json
{
  "kind": "add",
  "tab": "DISTRO PIPELINE",
  "r": 681, "c": 6,
  "expect": "",
  "text": "DEC DROP 1 - STAGE FOR NABIS PICKUP",
  "find": { "week": "NOVEMBER, MONDAY 16TH", "day": 3,
            "after": "TBD - TESTING SCHEDULED FOR DEC PREROLL DROP ", "afterOwner": "" },
  "like": { "week": "NOVEMBER, MONDAY 16TH", "day": 4, "text": "DEC DROP 1 - STAGE FOR NABIS PICKUP" },
  "number": false
}
```

- `kind`: `"add"`. A one-cell op sends no `kind`; any other kind is refused.
- `tab` is DISTRO PIPELINE only, `c` is `2*day` (the day's left column), `expect` is `""` and
  `number` is `false`.
- `text`: the new line's whole text, not empty, at most 2,000 characters. Written raw, as typed.
- `find.week`, `find.day`: the band and the day, as for one cell.
- `find.after`: what the day ends with, as the page reads the CSV. Take the last row inside the
  band where either of the day's two cells holds text. If the left cell holds text, `after` is that
  text (exactly, trailing spaces included). Otherwise `after` is the right cell's text and
  `afterOwner` is its owner (the owner rule above). `after` is `""` for a day with nothing on it.
  The program writes only while the day still ends with exactly that line, so a line Victoria added
  since is never written over or jumped.
- `r`: the page's guess at the row the line lands in (the row under `after`). Information only, as
  for one cell: the program works out the row, and the reply's `a1` and `range` say where it went.
- `like`: the line whose look the new one takes: its `week`, `day` (0 to 6) and exact `text`. It must
  be the only cell with that text in that day's left column of that band, in this week or a later
  visible week.

## What the program checks, in order (any failure writes nothing)

1. Signed in with a confirmed @wizardtrees.com email, and `pipeline_can_edit(scope)` is true
   (`plan` for DISTRO PIPELINE, `supply` for the two supply tabs).
2. Writing is switched on (`pipeline_write_settings.enabled`), the tab is in `tabs_on`, and for a
   `write` the kind of edit is in `kinds_on` (`rewrite` for one-cell ops, `add` for adds), unless
   the action is `dry`. In test mode (`test_mode`), `write` behaves like `dry`.
3. At most 20 cells, every op on an allowed tab, DISTRO PIPELINE ops only in columns A to N. A
   one-cell op counts 1; an add counts 2 (its pair), plus any cells it frees by clearing an empty
   merge. Adds are on DISTRO PIPELINE only, at most one per week and day in a save, and never in
   the same save as one-cell ops.
4. The sheet is read fresh. The cell is always found by `find` and `expect`, never by `r`,`c`
   alone (rows move, and a look-alike line can slide into the old row): on DISTRO PIPELINE, the one
   cell in that band and day whose text is exactly `expect` (and whose owner is `owner`, when sent);
   on a supply tab, the one cell at that item's row and that header's column, which must hold
   `expect`. The week is read whole: one that runs past the rows read (rows were inserted between the
   program's two reads) is a conflict, never a shorter week. `r`,`c` only tells whether it moved. None, or two or more, is a conflict: nothing is
   written and the reply shows what the sheet holds now where it can tell.
   - An add finds its band the same way, read whole. Adding stops at the next week's header; the
     last week, which has none under it, ends after its last row holding text in A to N, so the
     blank rows below it are never written. The day must still end with `after` (and its owner
     must be `afterOwner` when the last line is in the right column); otherwise it is a conflict
     (`why` `changed`, `role` `after`, `found` what the day ends with now). The line goes in the
     first row under that last line and under any merge on that row. When that row is at or past
     where adding stops, it is a conflict `full` (`role` `slot`): the day has no empty row left.
     In any week but the last, a row added at the bottom of that week in the sheet makes room,
     and the message says so. In the last week a blank row never makes room (the week ends at its
     last row holding text), so the message says it is the last week in the sheet and to add the
     line in the sheet, and never suggests adding a row.
   - The `like` line is found the same way in its own band and day (left column only). Gone, or
     on its day twice, is a conflict (`role` `like`).
5. The target cell must not be: the title row (or a supply tab's header row), a week header row, a
   hidden row, a formula, or a cell covered by a merge that starts elsewhere. On a supply tab only
   the site counts, STATUS, PAR and NOTES may change. Release 1a also refuses an op whose `expect`
   is empty (it only rewrites cells that hold something), or whose `text` is empty, except a supply
   count or PAR. Two ops on one cell, a `text` over 2,000 characters, or a save that changes
   nothing are refused too.
   - The row an add writes must not be the title row, a header or hidden. Both of its cells must
     be blank: no text, no value (even one that shows as nothing), no formula, no colored words.
     The day must not already have a line with exactly that text in its left column. Merges in
     that row: none (the pair is merged), exactly the day's two cells merged (kept), or an empty
     merge that starts in that row, stays inside the day's two columns and above where adding
     stops, covers no hidden or header row and is blank in every cell (it is unmerged first, then
     the pair is merged). Anything else is refused.
   - The `like` line must be the top-left of exactly a one-row merge across its day's two columns,
     not row 1 or a header, not in a hidden row or week, not a formula, not marked urgent (red
     fill `#FF0000`) and not crossed out (in its look or any of its colored words).
   - The look: the new line's left cell gets the `like` cell's whole look (`userEnteredFormat`:
     fill, font and text colors, alignment, wrap, borders). A border side the `like` cell lacks
     (its neighbor draws that line) is filled with a copy of its own solid black side, or solid
     black width 1. The right cell gets the `like` line's right cell's look exactly (usually none,
     which clears whatever was there). A `like` text stored with `\r\n` makes the new text use
     `\r\n` too. Row height, notes and data validation are never touched.
6. Colored words: when a cell has several text formats (some words red or pink), the new text
   must differ from the old in one stretch that does not cross a color change. Formats before the
   stretch stay, formats after it shift. Otherwise the op is refused with "make that change in the
   sheet". An added line takes the `like` line's colored words, carried from the `like` text to
   the new text the same way; when they cannot be carried, the save is refused ("add it as it is,
   then change the wording").
7. The cells are locked (for at most 3 minutes; a save still checking 90 seconds after locking gives up) for the length of the save, so two saves on one cell cannot both run, and
   checks 4 to 6 are run again under the lock. The second save is a conflict that names who is
   saving. An add locks its two cells, any cells it frees, and the day's last line (`after`, only
   read), so an add and a rewrite of that line take turns. A row that moved between the two checks
   changes the locked cells, and the save stops as a conflict ("the sheet changed while saving").
8. One `spreadsheets.batchUpdate` (all or nothing): one `updateCells` per one-cell op. An add sends
   `unmergeCells` for a merge it clears, then one `updateCells` over the pair (value, look and
   colored words, fields `userEnteredValue,userEnteredFormat,textFormatRuns`), then `mergeCells`
   (`MERGE_ALL`) over the pair unless it is already merged that way. Then the cells are read again
   to confirm (an add: its pair and any cleared merge, with looks and merges; the left cell must
   hold the text and colored words, the right cell must be blank, the pair merged), and the edit is
   logged. Looks are logged as read back (both cells', and each cell a cleared merge freed), not
   compared yet; an undo compares them. Google refuses a merge that runs into cells someone
   merged by hand since the check; then nothing is written and the reply is a conflict with no
   cells.

## Reply

```json
{ "ok": true, "mode": "live" | "test" | "dry", "target": "test" | "live", "wrote": true, "edit": 123,
  "checked": true, "requests": [...],
  "cells": [{ "tab": "...", "a1": "B650", "r": 649, "c": 1, "before": "...", "after": "...", "moved": true }] }
{ "ok": false, "reason": "conflict", "message": "...",
  "cells": [{ "tab": "...", "a1": "B650", "r": 649, "c": 1, "expect": "...", "found": "...", "why": "changed" }] }
{ "ok": false, "reason": "refused" | "off" | "not-editor" | "signed-out" | "error", "message": "..." }
```

An added line's cell in a reply also has `"kind": "add"`, `"range": "G682:H682"` (the pair),
`"like": "I679"` (the cell its look came from), `"merged"` (true when a new merge was made, false
when an empty one was kept) and `"cleared"` (the empty merges it cleared, like `["E743:E744"]`). Its
`a1` is the left cell, `before` is `""` and `after` is the text. An undo of an add has `"kind":
"unadd"`, its `range`, and in `cleared` the merges it put back.

- `mode`: `dry` for the action `dry`; `test` when test mode is on or the target is the test copy;
  `live` only when the workbook the page reads was written. `wrote` says whether anything was sent
  to Google; `target` names the workbook it was checked against.
- `edit`: the `pipeline_edits` row (also for a dry run). `requests`: the planned batchUpdate, only
  when nothing was written. `checked`: false when the cells read back differently from what was
  sent (the reply then has a `message`). An undo's reply also has `undo_of`.
- `found` is empty when the sheet no longer has a cell the program can point to.
- `why` says what kind of conflict it is: `changed` (the cell no longer holds `expect`), `item-gone`, `week-gone`
  (the sheet changed under the draft), `full` (an add: the day has no empty row left under its last line; trying
  again helps only after a row is added at the bottom of that week in the sheet, and never in the last week of the
  sheet, where the line has to be added in the sheet), or `twice`, `week-twice`, `item-twice`, `layout`, `column`
  (the sheet is laid out so the program cannot tell which cell is meant; trying again will not help). A conflict
  with no cells (someone else is saving the same cell, or the sheet changed while saving) has no `why`. In a
  conflict, `r` and `c` are the op's own.
- An add's conflict cell also has `role`: `after` (the day no longer ends with `after`; `expect` is `after` and
  `found` is what the day ends with now), `slot` (with `why` `full`), or `like` (the line it copies the look
  from; `expect` is `like.text`). An undo of an add has `role` `line` (the added line, or a cell its cleared merge
  freed, changed since, or a line was typed under it; see Undo).
- Every reply is HTTP 200 with this JSON (calls from `supabase.functions.invoke` read it as data).

Messages are plain English for the person who pressed Save.

## Undo

`{ "action": "undo", "undo": 123 }` restores the text and text formats each cell had before edit
123, but only if every cell still holds what that edit wrote. Otherwise it is a conflict, and
nothing is written. An undo is itself logged, and the original edit is marked undone. The colored words must also be as that edit left them (someone recoloring a word since is a
conflict, so undo never wipes their change). Only an edit
with action `write` and status `written` that is not undone yet can be undone; it is undone on the
workbook it was written to, by any editor of its tabs, and the switches apply as for a write
(`enabled` and `tabs_on`, but not `kinds_on`: switching adds off never leaves a line the app added
that cannot be taken out).

Undoing an add takes the line out: its text is cleared, both cells get back the looks they had
before, the pair is unmerged only if the add made that merge, and a merge the add cleared is put
back. The line is found again by its text in its day's left column, so rows that moved since are
followed.

Undo the newest change first, and for an add the program enforces it: the undo is refused
(`reason` `refused`, "A newer change on that day was made from the app. Undo that one first.",
nothing written and nothing logged) while a later edit written from the app on the same workbook,
tab, week and day is not undone. That covers another add on that day and a rewording of any line
there. The added line is found only by its words, so without this a newer line with the same words
(the same line copied to that day again after hers was reworded in the sheet) could be taken out in
its place. Edits on other days or the other workbook, undos, dry runs, and edits that were refused,
conflicted or failed do not count.

The line is then taken out only if it is exactly as the add left it:
- the same text and colored words, and the only line with that text in its day's left column
  (two is a conflict `twice`);
- both cells' looks unchanged (someone marking it urgent or recoloring it stops the undo, so their
  change is never wiped), the right cell still blank, and the pair still merged;
- nothing typed in the day's right column under it since that belongs to it the way the page reads
  the tab (a detail line such as "1G PREROLL- 300" right under it, before the next line in the left
  column). Taking the line out would hand that detail line to the item above, so the message says
  lines were added under it in the sheet;
- any cells a cleared merge freed still blank, unmerged, visible, inside the week, and with the
  look each had right after the add (the log keeps that look from the read-back after the add).
  This keeps a fill or border put on a freed cell by hand since, and it stops the undo when a row
  was inserted or deleted between the line and a freed cell: the freed cell then no longer sits
  where the line's move says, and the cell found there has another look in practice (a row
  inserted from the Sheets menu copies the line's look). An add logged without that look is not
  undone.

Otherwise it is a conflict (`role` `line`) and nothing is written. A line whose row is hidden in
the sheet now (its week was hidden since) is refused instead (`reason` `refused`, with the message
"That row is hidden in the sheet (a past week), so the app does not change it.", no `role`): the
app never changes a hidden row, and unhiding it lets the undo go ahead. The row is left empty; if
lines were added below it since, that day keeps a blank row, which the page reads fine.

## For the page

- `pipeline_edit_status()` (RPC, signed in) returns `{can_plan, can_supply, enabled, test_mode,
  target, tabs_on, kinds_on}`: show Edit only when `can_plan` / `can_supply` is true for that tab.
  Show Add only when `kinds_on` includes `add` (an older database without `kinds_on` means rewrites
  only), only for today or a later day, and never while the page is on the backup feed.
- `pipeline_edits` (select, same people as `pipeline_can_view()`) has who changed what and when,
  for "Changed in the app by ...", and the `id` to undo.

## Settings (`pipeline_write_settings`, one row, changed only from Gianni's computer)

- `enabled` (default false): the master switch.
- `test_mode` (default true): check and plan, never write.
- `target`: `test` (the private copy, `test_workbook`) or `live` (the workbook the page reads, from
  `schedule_board`).
- `tabs_on`: the tabs writing is allowed on.
- `kinds_on` (default `{rewrite}`): the kinds of edit that may be written: `rewrite` (one-cell ops,
  release 1a) and `add` (adding a line, release 1b). Victoria approves each kind on the test copy
  before it is switched on. Until this column is applied, the program treats it as `{rewrite}`.
