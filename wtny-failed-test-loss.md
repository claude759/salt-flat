# Failed lab tests → harvest → loss calculation

**Sources:** Metrc NY LabResultsReport ×4 (all licenses), 1/1/2026 – 7/28/2026 · 8,964 test rows ·
Metrc Packages exports (PackagesInventoryReport ×2 + Packages‑Active for OCM‑MICR‑24‑000155‑P2,
pulled 7/28–7/29) · Kels Meyer crew statement (Slack, 7/29/2026)
**Finding:** 6 packages failed, **every one for _Aspergillus Terreus_**, tested 6/24–6/25/2026 —
and the crew packaged, **un‑packaged, then hand‑cleaned** five flower lots across Rooms 2 and 3:
three labour cycles, zero output. The pack and unpack are corroborated in the Metrc package ledger
below; the cleaning moves no inventory, so timesheets are its only possible proof.

---

## Crew confirmation — the product was packaged, then UN‑packaged (Kels Meyer, Slack, 7/29/2026)

> "For Room 2, the Potion and Blacklight were the only 2 that were packaged and unpackaged due to
> failed test results. From Room 3, we packaged and unpackaged Tea Party, Wizard OG, and New Yorker
> due to poor quality."

> *(12:43 PM, same thread)* "We cleaned all of the jars, so there was a good bit of labor put into
> that as well. Caps we bagged and saved — not sure if we will reuse them or not."

What this adds to the claim:

1. **A second damage category on Room 2 (F2 R1): wasted labor, and it is THREE cycles, not two.**
   The crew ran the full packaging line on Potion and Blacklight jars, the tests came back failed
   (6/24–6/25), the crew ran the line in REVERSE to empty every jar back to bulk — **and then
   hand‑cleaned every jar** so it could be reused. Every unit was handled at least three times to
   produce nothing. Metrc corroborates the pack and the unpack (§ below); the cleaning is
   labor‑only and leaves no Metrc trace, so its evidence must be the timesheets (§ below).
2. **A third damage category entirely: Room 3 (F3 R1, harvested 6/15/26).** Tea Party, Wizard OG
   and New Yorker *passed* lab testing (consistent with the zero F3 failures in the lab data) but
   were packaged and then unpackaged **for poor quality**. Quality degradation in a room whose
   flower/dry window sits inside the power-problem dates is a distinct head of damage: downgrade
   loss (bulk value vs. jarred retail) plus the same double labor.
3. **One discrepancy to resolve with Kelsey:** Metrc also shows a *British Delight 3.5G Jar
   Packaging* job whose product came back to bulk with `TestFailed` (pkg …176, 19.36 lb). Kelsey
   names only Potion and Blacklight for Room 2 — ask whether British Delight's jar run was partial,
   done by a different crew, or simply forgotten. **NEEDS ANSWER.**

---

## The link: failed package → source package → harvest

| Failed package | Source pkg | Harvest | Item | Category | COA |
|---|---|---|---|---|---|
| …0000**044** | …041 | **F1 R1 5/11/26** | Limelight Pre‑Roll Flower 1.0G | Raw Pre‑Roll | AL60617010‑008 |
| …0000**045** | …043 | **F1 R1 5/11/26** | Zangria Pre‑Roll Flower 1.0G | Raw Pre‑Roll | AL60617010‑009 |
| …0000**046** | …042 | **F1 R1 5/11/26** | Limelight Pre‑Roll .7G 5PK | Raw Pre‑Roll | AL60617010‑010 |
| …0000**054** | …047 | **Blacklight F2 R1** | Blacklight Flower 3.5G Jar | Bud/Flower | AL60617010‑001 |
| …0000**055** | …048 | **British Delight F2 R1** | British Delight Flower 3.5G Jar | Bud/Flower | AL60617010‑002 |
| …0000**060** | …053 | **F2 R1 – Potion 6/1/26** | Potion Flower 3.5G Jar | Bud/Flower | AL60617010‑007 |

All six show Metrc lab state **`TestFailed`** and overall passed = **No**.

**Clustering matters:** 3 failures from **F1 R1 (harvested 5/11/26)** and 3 from **F2 R1 (harvested
~6/1/26)** — the facility's first two harvests, both tested the same week. Rooms F3 and F4 (harvested
6/15 and ~7/13–22) show **zero** failures across ~3,500 test rows.

That pattern — contamination confined to the two earliest rooms, then clean — is consistent with an
environmental problem that was later corrected. It's a genuine lead, **not proof**: Aspergillus also
tracks with airflow, sanitation, drying/curing conditions and room commissioning. What makes it a
*power* claim is environmental logs from those rooms in that window (§ below).

---

## Price basis — from WT‑NY's own 2026 invoices (realized wholesale, not a list price)

| Unit | Price | Confidence |
|---|--:|---|
| **3.5G Jar** | **$31.00** | Strong — identical across 12 strains (Nebula, Tide, Black Magic, Limelight, Zangria, …) |
| **.7G 5PK Pre‑Roll** | **$30.00** | Strong — identical across 4 strains |
| **1g Pre‑Roll** | **$24.00 or $12.00** | ⚠️ Two tiers in the book (New Yorker $24; Black Magic/Tide $12) — must confirm which applies to Limelight/Zangria |

---

## The calculation

```
per package:   quantity (units)  ×  realized $/unit  =  gross loss
claim value:   Σ gross loss  −  costs avoided (packaging/testing/distribution not incurred)
```

| Failed package | Item | $/unit | Qty | Gross loss | Pack + unpack + **clean** labour |
|---|---|--:|--:|--:|--:|
| …044 | Limelight Pre‑Roll 1.0G | $24 or $12 | **NEEDED** | — | **NEEDS DOC** |
| …045 | Zangria Pre‑Roll 1.0G | $24 or $12 | **NEEDED** | — | **NEEDS DOC** |
| …046 | Limelight Pre‑Roll .7G 5PK | $30.00 | **NEEDED** | — | **NEEDS DOC** |
| …054 | Blacklight Flower 3.5G Jar | $31.00 | ~1,919 jar‑eq* | see §Metrc | **NEEDS DOC** |
| …055 | British Delight Flower 3.5G Jar | $31.00 | ~2,509 jar‑eq* | see §Metrc | **NEEDS DOC** |
| …060 | Potion Flower 3.5G Jar | $31.00 | ~1,530 jar‑eq* | see §Metrc | **NEEDS DOC** |

\* jar‑equivalents derived from the un‑packaged bulk weight now sitting in the Vault (§Metrc below),
at 3.5 g/jar — the whole lot, not just the lab‑sample package.

### Wasted labour — the three cycles, and where the hours come from

Kelsey confirms all three happened; only the HOURS still need a source. Per unpacked lot the
recoverable labour is:

| # | Cycle | What it is | Metrc trace? |
|---|---|---|---|
| 1 | **Package** | fill + cap + label the jars | yes — the *…Jar Packaging* processing job |
| 2 | **Un‑package** | empty every jar back to bulk | yes — the bulk pkg that job produced |
| 3 | **Clean** | wash/de‑label every jar so it can be reused | **no — timesheets only** |

Cycle 3 is the one Kelsey added on 7/29 and it is **invisible in Metrc by nature** — cleaning moves
no inventory, so nothing in the state system will ever show it. That makes the labour record the
sole proof, and it is why the sourcing below matters more than it looks.

**Sources for the hours, best first:**
1. **The NY Labor Tracker task log** — currently a dead end: it has **no "unpack" and no "clean"
   task type**, so none of this was ever logged (checked 7/29: zero matching rows). Fixing that is
   the housekeeping item at the end of this section.
2. **The daily Temp Crew sign‑in sheets** — the real vehicle. These are being uploaded to the NY
   tracker now; the first (7/29/2026) carries **8 temps at ~7.3 h each ≈ 57 person‑hours in one
   day**. If a day's crew was on jar cleaning, that single sheet is the exhibit. **ASK KELSEY to
   mark on each sheet WHAT the crew worked on** — without that the sheet proves hours but not
   purpose, and purpose is what ties the hours to Con Ed.
3. **Gusto hours** for the six‑person packaging crew on the run dates.
4. **Throughput cross‑check:** the tracker measured ≈58 jars per person‑hour on the jar line
   (7/28), so a ~1,900‑jar pack run ≈ 33 person‑hours. Pack + unpack + clean across the five
   confirmed lots plausibly lands in the **low five figures** — but that is an estimate and stays
   OUT of the claim until dates × crew × hours are documented.

**Temp rate: $25/hr — confirmed by Gianni 7/29/2026.** The sign‑in‑sheet crew (Jim Huang, Amy,
Jackie, Jackie Ou, Nancy, Fengliu, Cumming Peng, Lina Li) are not on `ny_roster` (that's the six
Gusto packaging techs at $23), and the tracker now defaults every uploaded off‑roster row to
**$25/hr** automatically. The 7/29 sheet alone ≈ 57 person‑hours ≈ **~$1,430/day** of temp labour.
Still worth collecting: **the agency's invoices** — a third‑party invoice beats an internal
timesheet as claim evidence, and it captures any markup the $25 doesn't.

**ASK KELSEY: the dates each strain was packaged, un‑packaged and cleaned, and the crew size on
each.**

### Materials — what was saved, what was lost

> "Caps we bagged and saved — not sure if we will reuse them or not."

| Item | Status | Effect on the claim |
|---|---|---|
| **Jars** | washed and retained | salvaged — cost recovered, but only by paying cycle 3 |
| **Caps** | bagged and saved, reuse undecided | salvage **pending** — if unusable they become a materials loss |
| **Labels** | **NOT mentioned — ASK** | likely a total loss: a label peeled off a jar is scrap, and the tracker treats "jar packed" and "jar labeled" as separate operations, so labelled lots were labelled twice |

**This is mitigation, and mitigation helps.** A claimant has a duty to reduce its losses, and
washing jars and bagging caps instead of binning them is exactly that. It does two things for the
claim: it removes the "they could have salvaged this" defence, and **the cost of mitigating is
itself recoverable** — so the cleaning labour is claimable *because* the jars were saved, not
despite it. Say so explicitly when this is written up.

**Decide the caps.** If they are reused, log the saving. If they are scrapped, price them and add
them as a materials line. Leaving it undecided leaves money on the table either way.

### Package quantities — partially answered by the 7/28–7/29 Metrc Packages exports
The failed F2 jar lots came back to bulk, and those bulk weights ARE the lot quantities (see
§Metrc). Still genuinely missing: the three F1 pre‑roll packages (…044/045/046) — they are **not in
active inventory** (F1's Limelight/Zangria bulk flower shows 0 lb; only trim remains), so their
quantities and disposition need the **Packages ▸ Inactive** export or the package history screen.

**Scale check so nobody is surprised:** the F2 flower lots alone are ~5,958 jar‑equivalents
(≈$185k gross ceiling at $31 — see §Metrc for why the real claim number is smaller). The F1
pre‑roll packages are probably hundreds of units, not thousands. The bigger money, if it exists,
is still in §3 of the main pack (cycles never run).

---

## Metrc corroboration — the unpack is IN the ledger (Packages exports, pulled 7/28–7/29/2026)

The active‑packages export for license **OCM‑MICR‑24‑000155‑P2** carries a *Source Processing Job*
column, and it reads like a confession: each of these bulk packages was **produced by a jar/flower
packaging job** — bulk product that exits a *packaging* job as bulk again is product that was
packed and then emptied back out. All of it sits in the **Vault** today.

### Room 2 — F2 R1 (harvested ~6/1/26) · failed _Aspergillus_ 6/24–6/25 · `TestFailed`

| Bulk pkg (active) | Source processing job | Now itemised as | Weight | Jar‑eq @3.5g | Ceiling @$31 |
|---|---|---|--:|--:|--:|
| …000177 | **Blacklight 3.5G Jar Packaging** | Gelonade – Bulk Flower | 14.81 lb | ~1,919 | $59,489 |
| …000182 | **Potion 3.5G Jar Packaging** | Zoap – Bulk Flower | 11.81 lb | ~1,530 | $47,430 |
| …000176 | **British Delight 3.5G Jar Packaging** | Biscotti – Bulk Flower | 19.36 lb | ~2,509 | $77,779 |

**This also answers Disposition (question 1 below) for the F2 lots:** the failed product was NOT
destroyed — it was un‑jarred, re‑itemised under new strain names (Blacklight→Gelonade,
Potion→Zoap, British Delight→Biscotti) and is held in the Vault, still `TestFailed`. So the loss
today is **not** the full $185k ceiling: it is (jarred retail value) − (whatever the re‑itemised
bulk actually recovers via remediation/extraction/re‑test), **plus** the double labor. Pin down
the plan for these three packages — remediate, extract, destroy, or re‑test — and the delta
becomes computable. **NEEDS ANSWER.**

### Room 3 — F3 R1 (harvested 6/15/26) · tests PASSED · pulled for poor quality

Kelsey's three strains all link to Metrc cleanly — including New Yorker, whose harvest name is the
generic "F3 Round 1" but whose *Source Processing Job* names the strain:

| Bulk pkg (active) | Source processing job | Harvest (Metrc) | Now itemised as | Weight | Jar‑eq @3.5g | Ceiling @$31 |
|---|---|---|---|--:|--:|--:|
| …000174 | **Tea Party Flower Packaging** | Tea Party – F3 R1 – 6/15/26 | Tea Time – Bulk Flower | 13.82 lb | ~1,791 | $55,521 |
| …000180 | **Wizard OG Flower Packaging** | Wiz OG – F3 R1 – 6/15/26 | O.G. – Bulk Flower | 20.02 lb | ~2,594 | $80,414 |
| …000179 | **New Yorker Flower Packaging** | F3 Round 1 6/15/26 | Sour Diesel – Bulk Flower | 29.58 lb | ~3,834 | $118,823 |

All three are `TestPassed` — exactly matching Kelsey's "poor quality, not failed tests." Combined:
**63.42 lb ≈ 8,220 jar‑equivalents, ~$255k gross ceiling.**

**What Room 3 is and is not:** the product is sellable (it passed), so the ceiling is NOT the
claim. The claim components are (a) the **downgrade delta** — jarred retail (~$31 × jar‑eq) minus
what the renamed bulk actually fetches, (b) the **double labor**, and (c) whatever re‑packaging
cost recovery entails. To make it a *power* claim it also needs (d) **why the quality was poor** —
Kelsey/cultivation describing the defect (mold pressure? poor cure? larf?) and whether it traces
to the same environmental window as the F2 failures. F3's flower/dry window (roughly May → 6/15 +
dry/cure into July) overlaps the documented June–July power problems. **ASK KELSEY: what
specifically was wrong with the Room 3 flower, and who made the pull call. NEEDS DOC.**

**Housekeeping worth doing regardless of the claim:** the Labor Tracker has no **"Unpacking"** and
no **"Jar cleaning"** task type, so none of this labour was captured — and cleaning has no Metrc
shadow, so if the tracker doesn't hold it, nothing does. Add both task types (and have the temp
sign‑in sheets note the day's job) and the next incident documents itself instead of being
reconstructed from memory months later.

---

## What converts this from "a lead" into "a claim"

1. **Disposition** — ~~were the failed packages destroyed, remediated, or re‑tested?~~
   **ANSWERED for the F2 flower lots (7/29, Metrc Packages export):** un‑jarred back to bulk,
   re‑itemised under new names, held in the Vault, still `TestFailed` — see §Metrc corroboration.
   Still open: what happens NEXT to those three bulk packages (remediation/extraction/destruction
   decides the recovery value), and the disposition of the three F1 pre‑roll packages, which are
   not in active inventory at all.
2. **Environmental logs** — temp/RH for F1 and F2 across flower + dry/cure. **This is the causal
   bridge.** Without it, Aspergillus is just as easily blamed on sanitation or airflow.
3. **Timing overlay** — do the F1/F2 flower and dry windows sit inside the power‑problem dates? F1
   was harvested 5/11/26, so its flower window is roughly **mid‑Feb → 5/11**; F2's runs to ~6/1.
4. **An expert opinion** tying degraded HVAC/dehumidification to the Aspergillus result. A
   cultivation director's declaration plus the logs is the minimum; an outside agronomist is better.
5. **Why F3/F4 were clean** — *revised 7/29:* F3 was clean **on lab tests only**. Kelsey's
   statement shows three F3 strains were still pulled for poor quality, so the damage window
   extends into F3 and the true "clean" room is F4. That REFRAMES the timeline: F1/F2 =
   contamination failures, F3 = quality degradation, F4 = clean. A progressive recovery
   (fail → degraded → clean) fits an environmental problem being fixed mid‑stream even better
   than a hard cutoff — pin down what changed before F4 (power remediation? generator?
   new HVAC?) and WHEN. If nothing changed, it weakens the causation story.
