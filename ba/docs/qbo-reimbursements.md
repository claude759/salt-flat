# Book in QuickBooks (BA app reimbursements)

Gianni asked (2026-11-21): "only for my sign in, I want an export reimbursements to qbo option when reviewing their
reimbursements submissions". This is the agreement between the page (`ba/index.html`), the database
(`supabase/ba-qbo-bookings.sql`) and the job on Gianni's Mac (`~/bookkeeping-automation/qbo/ba-reimb-worker.mjs`).
QuickBooks sign-in stays on the Mac: two token holders brick a realm (`qbo/auth.mjs`), so the page never talks to
QuickBooks. The page asks, the Mac books, the page shows the result.

## What a booking is (Gianni's own JE shape, read from his JEs since June 2026)

- One journal entry per person, in the company whose Gusto pays them (not the app region):
  Filifera LLC (Cesar, Makenna, Jesse, Joanna, Amanda, Nouri), Waf & Gus LLC (Keelin, Leti, Drew), WTNY (Chandler,
  Jackie, Maddy, Rachel, Terrance). The Mac finds the company from Gusto (below).
- Dated the check date of the Gusto payroll that pays it (see "The date").
- DocNumber: the company's running number + space + the app first name (first word of profiles.full_name):
  "123138 Cesar", "2342352 Chandler", "35238 Keelin". The number is the highest `^\d+ ` DocNumber among that
  company's JEs that credit its Reimbursements account, plus one, taken by the Mac at booking time. Never QuickBooks'
  prefill ("PF-A95129A...E" trips the paid-for guard, paid-for-book.mjs, and the event sync can't read a name from it).
- Credit: the company's Reimbursements account for the total. No class, no description, no Name.
- Debits: one line per (account, event) with the person's class; description empty, or "Event: <expenses.event_name>"
  for event-tagged expenses (tagged amounts are their own line). Mileage (all trips) goes to the mileage account.
  Untagged lines on an event account become "Which event?" questions in the Bank Board's event sync, which is how
  untagged event costs get tagged today.
- No memo (a memo tag would also land on the credit line, which the event sync would count negative).
- Attachments: the app's reimbursement CSV for the person and period (same columns as the page's exportCSV,
  file `reimbursement_<Full_Name>_<period start>.csv`), plus receipts named like "Download all attachments"
  (`<date>_receipt_<vendor>_<amount>.<ext>`, HEIC/WEBP converted to JPG). A booking that takes all of the person's
  approved reimbursable items in the period attaches the receipt of every approved expense in the period, company-paid
  ones included (Gianni's habit); a later, partial booking attaches only its own items' receipts. Only files the app
  stored (`<uuid>/<file>` in the receipts bucket) are ever fetched.
- What is booked: approved trips, and approved expenses paid by the person (payment 'reimbursement'), never
  company-paid ones ('company', 'company_bank') and never rows the event sync wrote (source 'books').
  Amounts come from the items, never from submissions.totals (it can be stale).

### Default accounts (history 6/1 to 11/21/2026; the Mac checks each id exists and is active)

| App category | Filifera | WTNY | Waf & Gus |
|---|---|---|---|
| Credit: Reimbursements | 201 | 1150040023 | 102 |
| Mileage (trips) | 181 COGS:Mileage Reimbursement | 1150040091 BA Mileage Reimbursement | 114 Mileage Reimbursements |
| Travel/Parking/Tolls | 123 Vehicle expenses:Parking & tolls | 143 Vehicle expenses:Parking & tolls | 21 Travel |
| Food for retailer, Meals | 45 Meals | 56 Meals | 13 Meals & Entertainment |
| Supplies | 46 Office expenses | 1150040120 BA Supplies | 99 Shipping, Mailing, & Postage |
| Events | 1150040036 Events | 1150040089 Advertising & marketing:Events | 1150040053 Promotional Events |
| Displays | 1150040037 Displays | 1150040118 Advertising & marketing:Displays | (pick) |
| Lodging | 1150040026 Travel:Lodgings | (pick) | (pick) |
| Quality Control | 1150040031 Quality Control | (pick) | (pick) |
| Flights, Other, anything else | (pick) | (pick) | (pick) |

"(pick)": the item has no default; Gianni picks the account on the card before Book is allowed. Any line's account
can be changed on the card (typable picker over the company's active Expense, Other Expense and Cost of Goods Sold
accounts).

### Class

From the person's Gusto department, read at refresh: Filifera "BA Hourly" -> BA (1000000001), "Sales" -> Sales
(666946); WTNY "BA Hourly" or "BA Salary" -> BA (1000000004); Waf & Gus by the person's app region (region, else
home_region): CA -> its CA class (1000000007), FL -> its Florida class (1000000001). Anything else: no default, Gianni
picks on the card (Filifera's Admin and Distribution are picked by purpose for staff who aren't BAs).

### The date

The Mac keeps each company's regular biweekly payrolls from Gusto in `ba_qbo_paydays` (every BA app period is exactly
one Gusto pay period in all three companies). Default on the card, in this order:
1. The period's payroll isn't processed yet: its check date ("Payday M/D, from Gusto"). The normal case: Gianni
   books right after approving, days before payroll runs.
2. A processed payroll on or after the period's own payday paid it: one of its reimbursement lines for the person,
   or their total, equals the amount being booked, or their total minus their JEs already dated that check date does
   (a claim Gusto paid together with another period), or their total equals the amount plus their adjustments on that
   payday, or that payday carries an adjustment for this claim as a late claim (see "Payroll list and the after-submit
   check"): that check date ("Gusto paid this on M/D").
3. Otherwise (processed, not paid): the payday it was added to as a late claim, else the next unprocessed payday of that
   company ("Late: next payday M/D").
4. No payday data: period end + 5 days, moved back to the business day before a US bank holiday ("estimated").
The date stays editable on the card. Book all ready only takes people whose date came from rule 1 or 2; anyone else
needs the card, where Gusto's paid amount shows.

### Which person, and what is already in QuickBooks

- The company and class come from Gusto: a profile is linked by its pinned Name in Gusto (Settings), or by Gianni
  picking "Who is this in Gusto?" on the card. Never by the app name, which people can edit (the nine exact app-name
  matches of 11/21 were kept as picked links).
- Name keys: a name with accents and anything but letters removed, lowercased (alias: Makkena is Makenna). A JE's key
  is the last word of its DocNumber. A person's keys are their app first name, the last word of every DocNumber any
  booking of theirs carries, and the first word of their Name in Gusto, so renaming yourself in the app can't hide an
  old JE. No key at all, or a first name with no letters: the person can't be booked. The DocNumber uses the app first name as shown.
- "JEs to check": JEs of that company for the person's key, dated after the period ends and within 120 days, that no
  live booking holds. The card lists them and asks "Book anyway?"; the plan then carries their ids (checked_jes). The
  Mac refuses a booking when QuickBooks has such a JE that isn't in checked_jes. A period that ended more than 400 days
  ago can't be booked from the app (the JE list covers 400 days).
- Late items in a booked period: every admin gets "Approve late items" on the person's sheet (the booked items stay
  locked, the new ones are approved and go on their own JE). The person can still re-submit their own approved period
  with a forgotten item.

## The parts

### Database (`supabase/ba-qbo-bookings.sql`, safe to re-run; applied from Gianni's Mac)

- `ba_qbo_bookers(user_id)`: who may book. Seeded outside the repo (no emails in this public repo).
  `ba_qbo_can_book()` (security definer): is the signed-in user in it. Every table below is readable only when it
  says yes; nothing is writable from the page except through the RPCs.
- Kept by the Mac: `ba_qbo_setup` (per company: realm, credit and mileage accounts, category defaults, pickable
  accounts, classes, next number), `ba_qbo_people` (per profile: company, Gusto uuid and department, class, doc name,
  how it was matched, problem), `ba_qbo_gusto_people` (Gusto employees of the three companies, for the "Who is this in
  Gusto?" picker), `ba_qbo_paydays` (company, period, check date, processed, per-person reimbursements paid),
  `ba_qbo_jes` (QuickBooks JEs that credit a Reimbursements account, last 400 days), `ba_qbo_worker` (heartbeat,
  last refresh, refresh requested).
- `ba_qbo_bookings`: one row per request. `source` 'app' (booked by the Mac) or 'hand' (a JE Gianni booked himself,
  linked to its items by the Mac). Status: queued -> working -> booked | failed; queued -> cancelled | expired (not
  picked up in 15 minutes); booked -> undo_queued -> undoing -> undone | undo_failed. Holds the plan the page showed,
  the JE id, number, SyncToken, attachments and a plain-English detail.
- `ba_qbo_booking_items`: the trips and expenses in a booking. An item can be in only one live booking (unique while
  live); items are released when a booking fails, is cancelled, expires or is undone.
- RPCs, each refusing anyone `ba_qbo_can_book()` refuses: `ba_qbo_request(p jsonb)` (checks the items are this
  person's, in this period, approved, reimbursable, at the amounts shown, not already booked, and that the total adds
  up; queues it), `ba_qbo_cancel(id)` (queued only), `ba_qbo_undo(id)` (booked 'app' only), `ba_qbo_unlink(id)`
  ('hand' only: "not these items", QuickBooks untouched), `ba_qbo_link_person(profile, company, gusto_uuid)`,
  `ba_qbo_refresh()` (asks the Mac to refresh now).
- A guard on trips and expenses: while an item is in a live booking, it can't be deleted and its amount, status,
  person, period, date, payment or category can't change. Notes, receipts and event names can still change. The words
  say what holds it and what the person asking can do ("Undo the booking first", "Ask Gianni", or for a JE booked by
  hand "it can't change here"). An approved period with items in QuickBooks can't be unapproved, except by its own
  person re-submitting it.

### The Mac (`~/bookkeeping-automation/qbo/ba-reimb-worker.mjs`, LaunchAgent `com.wizardtrees.ba-qbo-worker`, every 60 s)

Each run: heartbeat; expire stale requests; book or undo what is queued (one at a time, oldest first); refresh the
kept tables hourly, when the page asks, and the JE list after each booking. Reads and writes the database through the
Management API with the PAT (no sign-in per run). Before booking it checks everything again (requester, items,
amounts, accounts, class, total, receipts are files the app stored for this person and period, no JE to check that
Gianni didn't confirm, the period isn't older than 400 days) and refuses with a plain reason. If QuickBooks doesn't
answer while it books, the booking stays "working" with its number held (the page shows the Mac's note), and after
15 minutes the Mac settles it from QuickBooks, attaching the files if the JE turns out to be there. It creates the JE with QuickBooks' requestid set to the booking id (a retry
can't double-book), saves the JE id at once, attaches files one by one saving each attachment id, then marks it
booked. Undo re-reads the JE and refuses if it was changed in QuickBooks since; otherwise it deletes the JE, then each
attachment it made (full record to attachable?operation=delete). Hand JEs: after each JE refresh it links Gianni's own
reimbursement JEs to the items they paid (same company and name, a period whose payday is on or before the JE date,
an exact-cents match, also allowing one earlier period's late items on the same JE) and records them as 'hand' bookings, so the page never offers to book them again.
`--once`, `--refresh`, `--dry` (no QuickBooks writes) for runs by hand.

### The page (`ba/index.html`, only when `ba_qbo_can_book()` says yes)

- The person's review sheet (adminBaDetail) gets a QuickBooks section: bookings for this period (app ones with Undo,
  hand ones with "Not these items"), anything in flight, the last failure, JEs QuickBooks has for this person that
  the Mac couldn't match ("check before booking"), items not approved yet, and "Ready to book: $X (N items)" with
  Book in QuickBooks.
- The Book card: company and class, date (with where it came from), the number ("set when it's booked"), the credit
  and debit lines with typable account pickers (any "(pick)" item must be resolved), event descriptions,
  attachments, the total and Gusto's paid amount when known. Book queues it and the card follows it until the Mac
  answers (Booked: number, with Undo; or the reason it didn't).
- The period's Review list: a tag per person (Waiting for the Mac, In QuickBooks, Part in QuickBooks, Check
  QuickBooks, Link to Gusto, Ready to book, Needs a look) and "Book all ready", which queues every person whose card
  needs nothing picked, has a payday or paid date, and has no JE to check; everyone else is listed with the reason.
- How old the Mac's data is, and a Refresh. When the Mac hasn't checked in for 5 minutes the page says bookings wait
  until it does.

## Payroll list and the after-submit check (2026-11-24)

Why: one company's payroll went out paying each of its BAs their previous period's claim a second time, instead of the
claim for the period that check paid. The amounts were read off the app while its one shared period picker was still on
the earlier period, and nothing compared Gusto with the app after the submit. Gianni asked for two safeguards (a list
per check date in the app, and a check right after each payroll is submitted) and decided that each person's difference
is added to or taken off their next reimbursement. Database: `supabase/ba-payroll-checks.sql` (applied from Gianni's Mac). Everything
here is for bookers only (`ba_qbo_can_book()`), like the rest of this page.

### The Payroll tab

- A tab after Review. It never uses the shared pay period picker: it keeps its own check date.
- The check date is a typable picker over every check date of the three companies' regular paydays (`ba_qbo_paydays`)
  and any payroll the Mac checked (`ba_payroll_checks`, the other payrolls too). Each choice says the period it pays and
  whether Gusto ran it ("Wed Dec 9 · pays Nov 21 to Dec 4 · not run yet"), by company when they differ, and "the check
  found problems" when the Mac's check of a payroll that day did. It opens on a check date whose payroll the check found
  problems in while it can still be cancelled in Gusto (the soonest deadline first), else on the first check date on or
  after today that some company hasn't run, else the latest.
- One section per company with a payday that day (Wizard Trees NY, Filifera LLC, Waf & Gus LLC; a company without one
  says so in a line, and where its payday for the same period is when Gusto moved it): the period it pays in full, the
  check date, and Gusto's side: not run yet, or run (when, when the Mac checked it, what the check found, and until when
  it can still be cancelled in Gusto, in Pacific time).
- A row for everyone `ba_qbo_people` links to that company who is active or has a claim, a late claim, an adjustment or
  a Gusto payment that payday: the period (on every row), the claim's state in words (Approved; Waiting for approval,
  with what was submitted shown but not counted; Not submitted; Sent back), the approved amount, each adjustment with its
  reason, and **Type in Gusto** = the approved claim + that payday's adjustments, with Copy. Someone with nothing at all
  is one quiet line, after the others.
- The approved claim is the database's own formula, for the period the check pays: approved trips, plus approved
  expenses the person paid (never company-paid ones, never the rows the books sync wrote). It counts only once the claim
  itself is approved, the way the Mac's check counts it: approved items under a claim that is waiting, sent back or not
  submitted (an Undo approval of one item sends the claim back to waiting) are shown on the row, not counted.
- A late claim: an earlier approved claim whose own payday paid less than it (plus that payday's adjustments), that no
  later payroll paid, within 120 days (the Mac's own rule, with one more: an adjustment added for that claim on a later
  payday settles that much of it). It shows on every later payday's row as "Still owed", and while that payday hasn't run,
  "Add $X to this payday" saves it as an adjustment (its reason says which claim; `source_check_date` is the payday that
  didn't pay it), so Type in Gusto, the Mac's check and the Book card all count it. Type in Gusto never adds it by itself.
- Once Gusto ran the payroll, what it paid each person: from the Mac's check of that payroll when there is one, else
  from the hourly copy of the processed payroll. While the Mac's check expected what the app says now, the row follows
  its verdict (a warning line is a warning, a note or an all-clear a check mark, with its words). Otherwise (no check,
  or the app changed since) the page compares: a check mark when it equals Type in Gusto, or Type in Gusto plus a late
  claim still owed; a warning with how far off it is when not. The section's "doesn't match" count is those warnings.
  Payments to people the app doesn't know are listed as "Paid in Gusto, not in the app", and any other payroll the Mac
  checked that day ("Another payroll that day": an off-cycle one, or a regular one on another schedule, such as a crew
  payroll) with what it paid.
- Totals per company: approved (what counts), adjustments, Type in Gusto, and Gusto paid once it ran.
- People with a claim in that period whom the Mac hasn't linked to Gusto are listed last, since no company's list holds
  them; link them from their sheet in Review ("Who is this in Gusto?").
- "Adjustments not on any list", at the top whichever date is picked: any live adjustment no section shows, because no
  payday the app has takes its day or its person isn't linked to that company in Gusto any more, with Cancel when the
  database allows it.

### Adjustments (`ba_reimb_adjustments`)

- An amount added to or taken off one person's reimbursement on one payday, with a reason in a few words (Gianni tells
  the person what it is). "Add or take off" on a row, while that payday hasn't run: Add or Take off, the amount, the
  reason, and the payday (a typable picker over the company's paydays Gusto hasn't run, this one by default). It is
  saved through `ba_reimb_adjust_add`, in whole cents.
- Rows are never edited or deleted: a change is a Cancel plus a new adjustment. Cancel asks first and goes through
  `ba_reimb_adjust_cancel`, which also cancels the other half of a carry and anything carried on from it. It is refused
  once Gusto ran any payday it touches: what was paid stays as paid, so add a new adjustment instead.
- Below zero: Gusto can't take a reimbursement back, so the row says "Type $0.00. $X doesn't fit this payday." and offers
  "Carry $X to" the next payday Gusto hasn't run (`ba_reimb_adjust_carry`): one row takes it off this payday and one adds
  it to the later one, under one carry group, so a person's rows always add up to the whole settlement. It carries from
  the oldest adjustment on this payday that still holds all of it; when none does, as much as the one that holds the
  most, and then the rest. While the person's claim for the period can still grow (not approved yet, or items waiting),
  the row says it may still fit.
- Once a payday has run, its adjustments are read only.
- An adjustment belongs to a payday by its day, the Mac's rule (`qboAdjHome`): the payday's check date, or a day after
  the payday before it that no payday has any more. Gusto can move a late payroll's check date after an adjustment was
  added for it, and the booking worker then writes the new day into `ba_qbo_paydays`; the adjustment still counts on
  that payday, on the page, on the Book card and in the Mac's check, and its row says it was added for the old day. The
  database's cancel and carry look for a payday on the adjustment's own day, so they refuse one whose payday moved; the
  row says so, and to undo it, add the opposite amount there.
- The adjustments for the payroll that paid the earlier claims again were entered from Gianni's decision on the next
  payday not run yet. They live in the database, never in this repo.

### The after-submit check (Gianni's Mac)

`~/bookkeeping-automation/qbo/ba-payroll-watch.mjs` runs every 10 minutes. Right after a payroll of the three companies
is submitted in Gusto (regular or off-cycle), it compares every reimbursement on it with the approved claim for that
payroll's own period plus that payday's adjustments, writes what it found to `ba_payroll_checks` (one row per payroll;
the SQL file's comment gives each line's shape and kinds), and emails Gianni while the payroll can still be cancelled in
Gusto. It only reads Gusto and never writes Gusto or QuickBooks, and it keeps reimbursement amounts only, never wages,
net pay or taxes. The Payroll tab shows its findings beside each row.

### Elsewhere in the app

- A booker sees one line under the shared period picker on the Dashboard when Gusto already paid the period picked:
  "Gusto already paid this period on Wed Oct 14. To type amounts into a payroll, use the Payroll tab." (the companies
  are named when their days differ). On a person's sheet the line is about them: "The Wed Nov 25 payroll, which pays
  this period, paid them $X." (or no reimbursement), once their company's payroll ran. One or two small reads; nobody
  else sees it.
- Review says "Approved" where it said "Approved & reimbursed": approval doesn't mean Gusto paid it.
- Book in QuickBooks counts adjustments: the date's rule 2 (above) and the card's Gusto line take a payroll that paid
  the claim plus the person's adjustments on that payday as paying it (no line from Gusto counts as $0.00, when the
  adjustments took all of it off). A late claim added to a later payday as an adjustment is dated on that payday (rule 3
  while it hasn't run, "Late: added to the M/D payday"; rule 2 once it paid it). Without adjustments nothing changes.
