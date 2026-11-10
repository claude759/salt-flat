# pipeline-sheet-write: how the Production Pipeline page edits Victoria's sheet

Gianni's Claude owns this folder (`supabase/functions/pipeline-sheet-write/`). Victoria's Claude
does not change it: the safety rules below live here so that no change to the page can get past
them. The page (`pipeline.html`) builds the edit; this program checks it against the sheet as it
is right now, writes it, logs it, and can undo it.

Release 1a (this version) only rewrites the text of cells that already hold something, or sets a
supply count. It never creates cells, never changes colors, merges or row layout.

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

## What the program checks, in order (any failure writes nothing)

1. Signed in with a confirmed @wizardtrees.com email, and `pipeline_can_edit(scope)` is true
   (`plan` for DISTRO PIPELINE, `supply` for the two supply tabs).
2. Writing is switched on (`pipeline_write_settings.enabled`) and the tab is in `tabs_on`, unless
   the action is `dry`. In test mode (`test_mode`), `write` behaves like `dry`.
3. At most 20 ops, every op on an allowed tab, DISTRO PIPELINE ops only in columns A to N.
4. The sheet is read fresh. The cell is always found by `find` and `expect`, never by `r`,`c`
   alone (rows move, and a look-alike line can slide into the old row): on DISTRO PIPELINE, the one
   cell in that band and day whose text is exactly `expect` (and whose owner is `owner`, when sent);
   on a supply tab, the one cell at that item's row and that header's column, which must hold
   `expect`. The week is read whole: one that runs past the rows read (rows were inserted between the
   program's two reads) is a conflict, never a shorter week. `r`,`c` only tells whether it moved. None, or two or more, is a conflict: nothing is
   written and the reply shows what the sheet holds now where it can tell.
5. The target cell must not be: the title row (or a supply tab's header row), a week header row, a
   hidden row, a formula, or a cell covered by a merge that starts elsewhere. On a supply tab only
   the site counts, STATUS, PAR and NOTES may change. Release 1a also refuses an op whose `expect`
   is empty (it only rewrites cells that hold something), or whose `text` is empty, except a supply
   count or PAR. Two ops on one cell, a `text` over 2,000 characters, or a save that changes
   nothing are refused too.
6. Colored words: when a cell has several text formats (some words red or pink), the new text
   must differ from the old in one stretch that does not cross a color change. Formats before the
   stretch stay, formats after it shift. Otherwise the op is refused with "make that change in the
   sheet".
7. The cells are locked (for at most 3 minutes; a save still checking 90 seconds after locking gives up) for the length of the save, so two saves on one cell cannot both run, and
   checks 4 to 6 are run again under the lock. The second save is a conflict that names who is
   saving.
8. One `spreadsheets.batchUpdate` with one `updateCells` per op (all or nothing), then the cells are
   read again to confirm, and the edit is logged.

## Reply

```json
{ "ok": true, "mode": "live" | "test" | "dry", "target": "test" | "live", "wrote": true, "edit": 123,
  "checked": true, "requests": [...],
  "cells": [{ "tab": "...", "a1": "B650", "r": 649, "c": 1, "before": "...", "after": "...", "moved": true }] }
{ "ok": false, "reason": "conflict", "message": "...",
  "cells": [{ "tab": "...", "a1": "B650", "r": 649, "c": 1, "expect": "...", "found": "...", "why": "changed" }] }
{ "ok": false, "reason": "refused" | "off" | "not-editor" | "signed-out" | "error", "message": "..." }
```

- `mode`: `dry` for the action `dry`; `test` when test mode is on or the target is the test copy;
  `live` only when the workbook the page reads was written. `wrote` says whether anything was sent
  to Google; `target` names the workbook it was checked against.
- `edit`: the `pipeline_edits` row (also for a dry run). `requests`: the planned batchUpdate, only
  when nothing was written. `checked`: false when the cells read back differently from what was
  sent (the reply then has a `message`). An undo's reply also has `undo_of`.
- `found` is empty when the sheet no longer has a cell the program can point to.
- `why` says what kind of conflict it is: `changed` (the cell no longer holds `expect`), `item-gone`, `week-gone`
  (the sheet changed under the draft), or `twice`, `week-twice`, `item-twice`, `layout`, `column` (the sheet is
  laid out so the program cannot tell which cell is meant; trying again will not help). A conflict with no cells
  (someone else is saving the same cell) has no `why`. In a conflict, `r` and `c` are the op's own.
- Every reply is HTTP 200 with this JSON (calls from `supabase.functions.invoke` read it as data).

Messages are plain English for the person who pressed Save.

## Undo

`{ "action": "undo", "undo": 123 }` restores the text and text formats each cell had before edit
123, but only if every cell still holds what that edit wrote. Otherwise it is a conflict, and
nothing is written. An undo is itself logged, and the original edit is marked undone. The colored words must also be as that edit left them (someone recoloring a word since is a
conflict, so undo never wipes their change). Only an edit
with action `write` and status `written` that is not undone yet can be undone; it is undone on the
workbook it was written to, by any editor of its tabs, and the switches apply as for a write.

## For the page

- `pipeline_edit_status()` (RPC, signed in) returns `{can_plan, can_supply, enabled, test_mode,
  target, tabs_on}`: show Edit only when `can_plan` / `can_supply` is true for that tab.
- `pipeline_edits` (select, same people as `pipeline_can_view()`) has who changed what and when,
  for "Changed in the app by ...", and the `id` to undo.

## Settings (`pipeline_write_settings`, one row, changed only from Gianni's computer)

- `enabled` (default false): the master switch.
- `test_mode` (default true): check and plan, never write.
- `target`: `test` (the private copy, `test_workbook`) or `live` (the workbook the page reads, from
  `schedule_board`).
- `tabs_on`: the tabs writing is allowed on.
