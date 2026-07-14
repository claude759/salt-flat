# Distro Hours — employee timesheet web app

> **RETIRED 2026-07-14.** Timesheets moved into the Labor / Unit Tracker
> (`labor-calculator.html`, Timesheets tab) on Supabase — same Google sign-in, same photos,
> plus live updates. All 169 rows and the 10 timesheet photos were migrated. The deployed
> Apps Script now serves only a "moved" redirect page (Version 43); the files below are the
> final working source, kept for reference. The old "Distro Hours — app data" Google Sheet
> remains as a read-only archive.

Drag-and-drop a photo of a paper **Employee Time Sheet**, Claude Vision reads the rows, you
review/fix them, and they save into a shared **Google Sheet** (the digital "Distro Hours" log).

**One Google Apps Script does everything** — it serves the app *and* stores the data. Access is gated
by the deployment setting: **"Anyone within Wizard Trees"**, so only `@wizardtrees.com` accounts can
open it, everyone who's in has full access, and there's no separate login, no client ID, no keys in
the browser. This is the same family as the AR-reports tool, just self-hosted by the script.

- **App + backend:** `apps-script-hours.gs` (Code.gs) + `index.html` (an HTML file named `index`).
- **Data:** a Google Sheet the script creates ("Distro Hours — app data").
- **OCR:** the script calls the Anthropic API (key in Script Properties).
- **Auth/identity:** `Session.getActiveUser()` (the deployment already guarantees the domain).

---

## What it does

- **📸 Drop a timesheet photo** → the script runs Claude Vision → company + one row per employee. A
  **Review** grid opens; names auto-match the roster (fuzzy, so "Andvade"→Andrade), rates/teams
  auto-fill, hours+total compute live. Fix anything, uncheck rows to skip, **Save**.
- **Entry Log** — every row, grouped by date with subtotals, filter by week/company/employee/date,
  inline-edit any cell, add rows, delete. Everything writes to the Google Sheet.
- **Roster** — manage employees + default rate/team/company + OCR aliases.
- **Export** — CSV or Excel (`.xlsx`) in the workbook's column order.

---

## Setup (one Apps Script project, ~5 min)

1. <https://script.google.com> → **New project**.
2. Paste **`apps-script-hours.gs`** into `Code.gs` (replace the sample).
3. **File → New → HTML file**, name it exactly **`index`**, and paste all of **`index.html`** into it.
4. **Project Settings → Script properties**, add:
   - `ANTHROPIC_API_KEY` = `sk-ant-…` (you can reuse the BA app's key)
   - `OCR_MODEL` = `claude-opus-4-8` (optional; strong at handwriting)
5. Run the **`setup`** function once (Run ▶ with `setup` selected; authorize when prompted). It creates
   the **"Distro Hours — app data"** spreadsheet, seeds the 14-person roster, and logs the spreadsheet
   URL (View → Logs) — open it any time to view/hand-edit the data.
6. **Deploy → New deployment → Web app:**
   - **Execute as:** Me
   - **Who has access:** Anyone within Wizard Trees
7. Open the **`/exec` URL** — that's the app. Bookmark it / share it with the team.

**To update later:** re-paste changed code, then **Deploy → Manage deployments → ✎ Edit → Version:
New version → Deploy** (keeps the same `/exec` URL).

> The source of truth for both files lives in this repo (`hours/apps-script-hours.gs` +
> `hours/index.html`); the Apps Script project is where you paste them to deploy — same as your
> collections + AR-reports scripts.

---

## How it works (reference)
- The page is served by `doGet()` (HtmlService) at the `/exec` URL.
- The browser calls the server with **`google.script.run`** (same-origin RPC — no CORS, no tokens):
  `apiLoad`, `apiSave`, `apiDelete`, `apiRoster`, `apiRosterDelete`, `apiOcr`.
- Every server call starts with `requireUser_()` = `Session.getActiveUser().getEmail()`, re-checked
  for `@wizardtrees.com`. `hours`/`total` are recomputed server-side (`saveEntries_`), and
  `break_minutes`/`rate` are clamped, so the numbers can't be desynced from the browser.

## Local preview (no backend)
Open `index.html?demo=1` on `localhost` (VS Code "Hours Preview" → port 8790, then
`http://localhost:8790/?demo=1`). Demo mode seeds sample data + a canned OCR result so you can click
the whole UI — drop any image to see the Review flow — without deploying.

## Tests
```bash
node tests/logic.test.mjs   # hours/break/total math, fuzzy match, CSV/XLSX injection guard, demo host
```

## Deferred (data model already supports)
By-employee / payroll-summary / rec-vs-void views; storing the photo to Drive; importing historical
`.xlsx` workbooks.
