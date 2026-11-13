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

Release 1c sets five cells of a batch's row on the BATCH LABEL SHEET tab (STATUS, PCKG DATE, NABIS P/U DATE, TOTAL
UNITS, BUDTENDER UNITS), found by the batch's METRC UID, never by row number. Blank cells may be filled. The only
format it ever writes is a date's number format, and only into a cell that has none (see "Release 1c" below).

## The pieces

- `index.ts`: the Supabase Edge Function. Sign-in check, settings, Google token, read, check,
  write, re-read, log.
- `rules.js`: the pure rules (no network), shared by `index.ts` and `tests/pipeline-write-check.mjs`.
- `supabase/pipeline-edits.sql`: editors, settings, the edit log, cell locks, and the RPCs the
  page calls.
- Google account: a dedicated service account (`pipeline-writer`) with no roles and no domain-wide
  delegation. It is an Editor on the test copy by name. On the live workbook it is not listed by
  name: it gets in through the workbook's "anyone with the link: editor" sharing. If that sharing
  is ever tightened, share the workbook with `pipeline-writer` by name as an Editor first;
  otherwise every save fails safely (nothing written, "The app's Google account cannot open the
  sheet"). Its key is the Supabase secret `PIPELINE_WRITER_KEY` (the whole JSON key). Never the
  bookkeeping service account: that one can read every mailbox.

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
  "tab": "DISTRO PIPELINE" | "DISTRO SUPPLY" | "ACCESSORY SUPPLY" | "BATCH LABEL SHEET",
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
- BATCH LABEL SHEET cells have their own `find` and a `date` flag: see "Release 1c" below.

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
   (`plan` for DISTRO PIPELINE and BATCH LABEL SHEET, `supply` for the two supply tabs).
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
   - A DISTRO PIPELINE rewrite never makes a line that says exactly what another line on that day
     says (in the day's two columns, with the same owner for a right-column line), counting the
     other cells of the same save as they will read after it: "That day already has a line that
     says exactly that." The board could not tell the two apart.
   - A supply count or PAR written into a cell whose number format is a date or time is refused
     (a number there would show as a date, 120 as 4/29): set the cell to Automatic in the sheet.
     A hidden row on a supply tab (by a filter or by hand) is refused with its own message.
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
   checks 4 to 6 are run again under the lock. The save's log row is written right after locking
   (status `failed`, "Started saving but did not finish", until the end), before the re-check, so
   the write follows the re-check as closely as it can. The second save is a conflict that names who is
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
   - Google writes by row number and has no "only if the sheet still reads like this". A row
     inserted or deleted above in the second between the re-check and the write lands the write
     one row off, and the written cells alone read back fine. So the read-back also reads the
     cells around each written one (the day's two columns in its week, or the supply row) and
     compares their text with the re-check, leaving out the written cells and formulas. Any
     difference: the save is still logged as written, the reply has `checked: false` and the
     message "Saved, but the sheet changed next to it while it was saving...", and the log's
     message names the cells.
   - The batchUpdate is sent once. Google's rate limit (429) is not applied and is not resent
     after a wait (rows may move meanwhile): nothing is written, and trying again checks afresh.

## Release 1c: Batch Label Sheet cells

The Batches page sets five cells of a batch's row on the BATCH LABEL SHEET tab. The tab ships switched off: it is
written only once an admin ticks it in `tabs_on` on the Admin page (a `dry` run works before that). Editing it needs
the `plan` right (`can_plan`); there is no separate scope yet. A batch cell is a one-cell op, so it is the kind
`rewrite` in `kinds_on`, and it may share a save with other one-cell ops (at most 20 cells).

### Op: one batch cell

```json
{
  "tab": "BATCH LABEL SHEET",
  "r": 16, "c": 23,
  "expect": "",
  "text": "2026-11-20",
  "find": { "uid": "1A4000000000000000000101", "header": "NABIS P/U DATE" },
  "number": false,
  "date": true
}
```

- `find.uid`: the batch's METRC UID as the page read it; `find.header`: the column's header in row 1, one of
  `STATUS`, `PCKG DATE`, `NABIS P/U DATE`, `TOTAL UNITS`, `BUDTENDER UNITS`. Both compared with spaces collapsed and
  case ignored. Nothing else in `find` is passed on, and the page never sends `prev`.
- `r`, `c`: the 0-based row and column the page read the cell at (the CSV export's grid). Information only: the cell
  is the one at that UID's row and that header's column, wherever they are now.
- `expect`: the cell's whole text as the page read it, which may be `""` (a blank cell can be filled). A date reads as
  the sheet shows it ("11/18/26", "11/20/2026"), never as a day number.
- `text`, by column:
  - `STATUS`: the new status, written as plain text. Not empty, and exactly (spelling, case and spaces) the STATUS of
    another row of the tab that has a METRC UID (hidden finished rows count). The app never invents a status.
  - `PCKG DATE`, `NABIS P/U DATE`: `date: true`, `text` the day as `YYYY-MM-DD`, a real day from 2024-01-01 to 400
    days after today (UTC). Written as the sheet's day number (days since 1899-12-30), so it sorts and filters as a
    date. A cell already formatted as a date keeps its format (only the value is sent). A cell with no number format
    (Automatic, like most blank NABIS P/U DATE cells) also gets `m/d/yyyy`, the format Sheets gives a date typed there
    and the one the COA watcher writes (fields `userEnteredValue,userEnteredFormat.numberFormat`). Fill, font, borders
    and every other part of the look are never sent.
  - `TOTAL UNITS`, `BUDTENDER UNITS`: `number: true`, `text` a whole number of 0 or more (commas allowed, "1,200"),
    written as a number so CASES keeps working.
- A date or count cannot be emptied from the app, and a status cannot be blanked.

### Checks on top of the ones above

- The header row (row 1) must name `METRC UID` and `STATUS` once each, or nothing is written (conflict `layout`). The
  header must be in row 1 once (else `column`). Exactly one row below it must hold the UID: none is `item-gone`, two or
  more is `item-twice`. The cell must still hold `expect` (else `changed`, with `found`).
- Refused (`reason` `refused`, nothing written), with these messages:
  - another column: "From the app, only STATUS, PCKG DATE, NABIS P/U DATE, TOTAL UNITS and BUDTENDER UNITS of a batch
    can be changed. Change the rest in the sheet." (CASES, STRAIN and the rest);
  - the COA watcher's columns (THC, CBD, TOTAL CANNA, COA LINK, TEST DATE, COA RETURN DATE): "THC, CBD, TOTAL CANNA,
    COA LINK, TEST DATE and COA RETURN DATE are filled in from the lab's COA, so the app does not change them. Change
    them in the sheet.";
  - a hidden row: "That batch's row is hidden in the sheet, so the app does not change it. Show the row in the sheet,
    then try again." (the CSV export carries no hidden flags, so only the program can tell);
  - a formula (the CASES formulas, a formula left in a finished row): the usual formula message;
  - any merged cell, top-left included: "That cell is merged with other cells in the sheet, so the app does not change
    it. Make that change in the sheet.";
  - a count into a cell formatted as a date or time: the usual `countFormat` message;
  - a date into a cell with a number format that is not a date (a number, text, percent): "That date cell is set to
    show something other than a date in the sheet, so a date there would read as a number. In the sheet, set the
    cell to Format, Number, Date (or Automatic), then try again.";
  - a value of the wrong kind for its column (a date without `date`, a count without `number`, a flag on STATUS):
    "The app sent that batch change the wrong way (a date, a number or a status in the wrong column). Reload the page
    and try again.";
  - a bad date: "Dates must be a real day, from January 1, 2024 to about a year from now (YYYY-MM-DD). Check the year.";
  - a bad count: "Units must be a whole number of 0 or more, like 1200.";
  - an empty date or count: "The app cannot empty a date or a unit count on the BATCH LABEL SHEET tab. Make that
    change in the sheet.";
  - an empty status: "Pick a status. The app cannot empty a batch's STATUS; make that change in the sheet.";
  - a status no other batch has: "That status is not used on any other batch in the sheet, so the app does not add it.
    Pick one the sheet already uses, or type the new one in the sheet.";
  - `date: true` on any other tab, `date` and `number` both true, or a `find` without `uid` and `header`: the usual
    "could not read" message. (The program passes a `date` flag on for every tab when the page sends one, so a page
    bug that sends it for DISTRO PIPELINE or a supply tab is refused, never saved as plain text. An op without it is
    passed on exactly as before release 1c.)
- Conflict messages for this tab: `item-gone` "That batch's METRC UID is no longer on the BATCH LABEL SHEET tab, so
  nothing was saved. Reload the page."; `item-twice` "That batch's METRC UID is on the BATCH LABEL SHEET tab more than
  once, so the app cannot tell which row you mean. Make that change in the sheet."; `layout` and `column` "The BATCH
  LABEL SHEET tab's columns changed since you opened this, so nothing was saved. Reload the page."; `changed` as on
  the other tabs.
- A workbook with no BATCH LABEL SHEET tab (an older test copy): `reason` `error`, "The sheet the app saves to has no
  BATCH LABEL SHEET tab, so nothing was saved. Tell Gianni."

### Reply and log

- A cell's `after` is the text the cell shows (a date as the sheet shows it, never the day number). The log's `before`
  and `after` also keep the cell's number format (`format`, null for Automatic) and `after.setFormat` (true when the
  save gave a blank Automatic cell `m/d/yyyy`). The log's `find` is `{uid, header}`.
- Rows or columns moved during the write: the read-back reads the whole BATCH LABEL SHEET tab again (with each cell's
  number format). Google writes by row and column number, so a row or column inserted or deleted in the second between
  the re-check and the write puts the value in another cell. The program reads what the written cell is now: the METRC
  UID on its row and the header over its column. If either is no longer the batch's, the save is logged as written but
  gets no `edit` (no Undo), `checked` is false, and the reply has `hit: [{tab, a1, uid, strain, header, wrote, before,
  rows, cols}]`, one per cell that landed wrong:
  - `uid`, `strain`: the batch whose row it landed on (`uid` "" for a row with no METRC UID, such as a drop's name);
  - `header`: what that cell's column is called now (the header the page sent when only rows moved);
  - `wrote`: what the save wrote there; `before`: what that cell held at the re-check, so a person can put it back
    (null only when it cannot be told). For a row with no METRC UID it is the row as far from that cell as the batch
    moved (found by its METRC UID), checked to read the same apart from the written cell; a row inserted there was
    blank; failing both, the nearest one row that reads the same. With columns moved, the column with the same header;
  - `rows`, `cols`: true for what moved under that cell;
  - `layout: true` (with `before` null) when the header row read back no longer names METRC UID and STATUS once each,
    or the write landed in the METRC UID column: nothing about where it landed can be told.
  The message names each cell, for example: "Saved, but rows were added or removed in the BATCH LABEL SHEET while it
  was saving, so the change landed in the wrong row: a row with no METRC UID now has STATUS "PACKAGING" in A16; it said
  "DEC DROP 3" before. Put "DEC DROP 3" back there. Then make your change again. This save cannot be undone from the
  app." With columns moved it says "columns were added or removed" and "the wrong column" (both: "rows and columns",
  "the wrong place"), and names the column by its header now ("batch 1A40... (STRAIN) now has HRVST DATE "11/20/26" in
  G16; it said "10/29/26" before."). With `layout`: "Saved, but the BATCH LABEL SHEET's columns changed while it was
  saving, so the app cannot tell where the change landed. Check G16 and the batch's row in the sheet, and fix it there:
  this save cannot be undone from the app."
- Columns moved during the write, but the save still landed in its batch's cell (no `hit`): no `edit` (no Undo),
  `checked` false, and "Saved in the right cell, but columns were added or removed in the BATCH LABEL SHEET while it
  was saving. Check that batch's row in the sheet: this save cannot be undone from the app."

### Undo of a batch cell

Found again by `{uid, header}` (rows may have moved), and only while the cell still shows what the save wrote. It puts
back the old value: the old text, the old number or day number, or a blank, whatever the value rules above say (a
blank cell, a status no batch uses any more and a blank date are all put back). When the save gave the cell `m/d/yyyy`,
the undo also puts back the old number format (none, Automatic), fields `userEnteredValue,textFormatRuns,
userEnteredFormat.numberFormat`, and only while the cell still has `m/d/yyyy` (a format changed by hand since is a
conflict, so it is never wiped). A hidden row is refused as above. For each of the five:
- STATUS: the old status text, or blank.
- PCKG DATE: the old day number (the cell keeps its own m/d/yy), or blank.
- NABIS P/U DATE: the old day number, or blank; plus the format back to Automatic when the save set `m/d/yyyy`.
- TOTAL UNITS, BUDTENDER UNITS: the old number, or blank.

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
- `edit`: the `pipeline_edits` row (also for a dry run). A write whose log row could not be
  finished has no `edit` (so no Undo is offered) and a message saying it cannot be undone here. `requests`: the planned batchUpdate, only
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

Since 2026-11-12 every edit also logs `find.prev`: the nearest text above the written cell in its
own column inside the week (the header row counts; blank rows are skipped; other cells of the same
save as they read after it). An undo then takes only a cell with the edit's words that still sits
under that same text, in the same column. So a line someone typed elsewhere that day with the same
words is never taken for it (its own cell was retyped: a conflict), and its own cell is found even
when a twin is on that day. Edits logged without `find.prev` are found by their words alone, as
before (a twin is a conflict `twice`). The page never sends `prev`.

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
  under the line it was added under (`find.prev`; without it, the only line with that text: two
  is a conflict `twice`);
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
  target, tabs_on, kinds_on}`: show Edit only when `can_plan` / `can_supply` is true for that tab
  (`can_plan` for BATCH LABEL SHEET too).
  Show Add only when `kinds_on` includes `add` (an older database without `kinds_on` means rewrites
  only), only for today or a later day, and never while the page is on the backup feed.
- `pipeline_edits` (select, same people as `pipeline_can_view()`) has who changed what and when,
  for "Changed in the app by ...", and the `id` to undo.

## Settings (`pipeline_write_settings`, one row, changed by a pipeline admin on the Admin page)

- `enabled` (default false): the master switch.
- `test_mode` (default true): check and plan, never write.
- `target`: `test` (the private copy, `test_workbook`) or `live` (the workbook the page reads, from
  `schedule_board`).
- `tabs_on`: the tabs writing is allowed on: DISTRO PIPELINE, DISTRO SUPPLY, ACCESSORY SUPPLY and BATCH LABEL SHEET
  (release 1c; off until an admin ticks it).
- `kinds_on` (default `{rewrite}`): the kinds of edit that may be written: `rewrite` (one-cell ops,
  release 1a) and `add` (adding a line, release 1b). Victoria approves each kind on the test copy
  before it is switched on. Until this column is applied, the program treats it as `{rewrite}`.
