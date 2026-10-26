/* Labor billing core: what Filifera LLC bills a site's company (Slane Inc. for
   23rd Street, Imperial Project LLC for Imperial, and Rio Verde for the Olympic
   grow) for deleaf and harvest labor done at that site by Filifera's Gusto
   employees.

   Rio Verde (board company Olympic) is billed only for work from 2026-10-24,
   the first day of the pay period Gianni chose on 2026-10-26 ("filifera will
   bill rio verde going forward"). Its Gusto harvest days before that are not
   billed: compute lists them under notBillable and says so in a warning. Rio
   Verde has no QuickBooks company, so its bill is a Filifera invoice only.

   Only Gusto-paid harvest days are billed: rows the Gusto importer wrote, with
   source 'import' and a source_id starting 'gusto-filifera-hv:'. Norma's crew
   is paid outside Filifera's payroll, so their sheet rows are never billed.
   Gusto wins over sheets: when a Gusto employee also has a sign-in sheet
   harvest row at the billed site in the period, it is not billed and a warning
   says to remove the sheet row if Gusto paid that day.

   A bill is wages plus Filifera's employer payroll taxes, per person:
     - Social Security 6.2% + Medicare 1.45% on all wages          = 7.65%
     - FUTA 0.6% + CA SUI 5.2% + CA ETT 0.1% on each person's first
       $7,000 of Filifera wages PAID in the calendar year          = 5.9%
   So a person costs 13.55% while under $7,000 for the year and 7.65% after.
   Tax is worked out on the person's whole Gusto pay for the pay period (every
   site and job on the board), then that blended rate is applied to the wages
   billed to this company. Wages are the exact sum of the billed rows' totals;
   hours keep the board's 3 decimals. Tax cents are rounded once, at the end.

   The $7,000 base counts wages by PAY DATE, as FUTA and CA SUI do. Filifera
   pays 5 days after a pay period ends (Sep 26 to Oct 9, 2026 was paid Oct 14),
   so a period's wages belong to the year of its pay date (period end + 5 days,
   see payDateOf). The 2026-12-19 to 2027-01-01 period is paid 2027-01-06: it
   starts the 2027 base at $0, and the 2027-01-02 period counts it as
   year-to-date. ytdStartOf gives the first period paid in the same year.

   Year-to-date pay comes ONLY from Gusto-paid rows on this board: Gusto
   Deleaf/Harvest imports and Gusto distro days (from gusto_distro_from on), in
   earlier periods paid in the same year. Other Filifera Gusto pay is not on
   the board (trimmer jobs and other jobs, sick or holiday pay, anything before
   the board started in June 2026), so in reality a person may cross $7,000
   earlier than the board shows, and this bill then charges 13.55% where Gusto
   charged 7.65%. The exact per-person figure is on the Gusto paystub.

   Overtime premium is not billed: the board stores straight-time wages. A
   warning names each billed day where the person's Gusto-paid hours (all jobs
   and sites) pass 8, and each Saturday-to-Friday week where they pass 40.

   Classic script, no imports or exports: the page loads it with a <script>
   tag, Node loads it with vm.runInNewContext. Both read globalThis.LaborBilling. */
(function () {
  'use strict';

  const TAX = Object.freeze({
    socialSecurity: 0.062,
    medicare: 0.0145,
    futa: 0.006,
    caSui: 0.052,
    caEtt: 0.001,
    allWagesRate: 0.0765,  // Social Security + Medicare, on every dollar
    underBaseRate: 0.059,  // FUTA + CA SUI + CA ETT, on the first wageBase dollars paid in the year
    wageBase: 7000,
  });

  // Keyed by the board's company name. billedFrom: the first work date billed (no billedFrom = every date).
  // noMirrorBill: the company has no QuickBooks, so Filifera's invoice is the only document.
  const SITES = Object.freeze({
    Slane: Object.freeze({ customer: 'Slane Inc (Customer)', label: '23rd Street', legal: 'Slane Inc.', key: 'slane' }),
    Imperial: Object.freeze({ customer: 'Imperial Project LLC (Customer)', label: 'Imperial', legal: 'Imperial Project LLC', key: 'imperial' }),
    Olympic: Object.freeze({ customer: 'Rio Verde (Olympic) (Customer)', label: 'Rio Verde (Olympic)', legal: 'Rio Verde', key: 'rioverde',
      billedFrom: '2026-10-24', noMirrorBill: true }),
  });
  const BILLED = Object.keys(SITES);

  const GUSTO_HV_PREFIX = 'gusto-filifera-hv:';
  const PERIOD_ANCHOR = '2026-07-04';   // a Saturday: pay periods and Gusto weeks start on Saturdays
  const PERIOD_LEN = 14;
  const PAY_LAG_DAYS = 5;               // payday is 5 days after the period's last day
  const DAY_HOURS = 8, WEEK_HOURS = 40;
  const DAY_MS = 86400000;

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  // Whole units of 1/scale, rounded half away from zero; the tiny nudge absorbs float noise such as
  // 2.675 * 100 = 267.4999... ('|| 0' turns -0 into 0).
  const units = (v, scale) => { const n = num(v); return (Math.sign(n) * Math.round(Math.abs(n) * scale + 1e-6)) || 0; };
  const cents = v => units(v, 100);
  const milli = v => units(v, 1000);
  const round2 = v => cents(v) / 100;
  const dateOf = row => String((row && row.work_date) || '').slice(0, 10);
  const rowHours = r => num(r.hours) * (num(r.people) || 1);

  // 'YYYY-MM-DD' <-> whole UTC days. No local-time Date objects, so no timezone can move a day.
  function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const n = ms / DAY_MS;
    return isoOf(n) === m[0] ? n : null;   // rejects 2026-02-30 and the like
  }
  const isoOf = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
  const addDays = (iso, days) => { const n = dayNumber(iso); return n == null ? null : isoOf(n + days); };

  // Start of the aligned block of `len` days that holds iso, counted from PERIOD_ANCHOR.
  function blockStart(iso, len) {
    const n = dayNumber(iso);
    if (n == null) return null;
    const anchor = dayNumber(PERIOD_ANCHOR);
    return isoOf(anchor + Math.floor((n - anchor) / len) * len);
  }
  const periodStartOf = iso => blockStart(iso, PERIOD_LEN);
  const periodEnd = startIso => addDays(startIso, PERIOD_LEN - 1);
  const weekStartOf = iso => blockStart(iso, 7);   // Gusto's Saturday-to-Friday week

  // Payday of the pay period holding iso (any date in the period works).
  function payDateOf(iso) {
    const s = periodStartOf(iso);
    return s ? addDays(periodEnd(s), PAY_LAG_DAYS) : null;
  }
  // Calendar year whose $7,000 base the period's wages count toward: the year they are paid in.
  function taxYearOf(iso) {
    const p = payDateOf(iso);
    return p ? p.slice(0, 4) : null;
  }
  // First pay period paid in the same year as the period holding iso. A period is paid in year Y
  // when its last day is on or after Dec 27 of Y-1 (Dec 27 + 5 days = Jan 1), so it is the period
  // that holds Jan 1 minus PAY_LAG_DAYS.
  function ytdStartOf(iso) {
    const y = taxYearOf(iso);
    return y ? periodStartOf(addDays(y + '-01-01', -PAY_LAG_DAYS)) : null;
  }

  // Employer tax on P dollars of period wages for someone with Y dollars paid earlier in the year.
  function employerTax(periodWages, ytdBefore) {
    const P = num(periodWages), Y = num(ytdBefore);
    const underBase = Math.max(0, Math.min(P, TAX.wageBase - Y));
    return round2(TAX.allWagesRate * P + TAX.underBaseRate * underBase);
  }

  const isGustoHarvest = row => !!row && row.category === 'harvest' && row.source === 'import'
    && String(row.source_id || '').startsWith(GUSTO_HV_PREFIX);

  // Same rule as isGustoDistro in labor-calculator.html, plus Gusto harvest rows.
  // The roster person is found by roster_id only.
  function gustoPaidBy(row, personFor) {
    if (isGustoHarvest(row)) return true;
    if (/^gusto-/.test(row.source_id || '')) return true;   // any Gusto import (packager, hand import) is Gusto-paid
    if ((row.category || 'distro') !== 'distro') return false;
    const emp = row.roster_id ? personFor(row.roster_id) : null;
    if (!emp || !emp.gusto_distro) return false;
    return !emp.gusto_distro_from || dateOf(row) >= emp.gusto_distro_from;
  }
  const isGustoPaid = (row, roster) => !!row && gustoPaidBy(row, id => (roster || []).find(p => p && p.id === id));

  const nameOf = p => [p && p.first, p && p.last].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  const lc = s => String(s || '').trim().toLowerCase();
  const nameKey = row => lc(row && row.last) + '|' + lc(row && row.first);
  const personKey = row => row.roster_id ? 'id:' + row.roster_id : 'name:' + nameKey(row);
  const fmt = n => round2(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const usd = n => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Roster person for a row with no roster_id, by name, the way rosterMatch in labor-calculator.html does it.
  function rosterByName(roster, last, first) {
    const l = lc(last), f = lc(first);
    if (!l && !f) return null;
    const aliasHit = p => (p.aliases || []).some(a => {
      const k = lc(a);
      if (l && f) return k === l || k === l + ' ' + f || k === f + ' ' + l || (k === f && lc(p.last) === l);
      return k === (f || l);
    });
    return roster.find(p => lc(p.last) === l && lc(p.first) === f)
      || roster.find(aliasHit)
      || roster.find(p => !l && lc(p.first) === f) || null;
  }

  function compute(opts) {
    const company = opts && opts.company;
    const rows = (opts && opts.rows) || [];
    const roster = ((opts && opts.roster) || []).filter(Boolean);
    const warnings = [];
    const asked = String((opts && opts.periodStart) || '').slice(0, 10);
    const periodStart = periodStartOf(asked);
    if (!periodStart) throw new Error('compute: periodStart must be a YYYY-MM-DD date');
    const site = hasOwn(SITES, company) ? SITES[company] : null;
    if (!site) {
      throw new Error(`compute: company must be ${BILLED.slice(0, -1).join(', ')} or ${BILLED[BILLED.length - 1]}, the board companies Filifera bills for labor (got "${company == null ? '' : String(company)}")`);
    }
    if (periodStart !== asked) warnings.push(`${asked} is not the first day of a pay period; using the period that starts ${periodStart}.`);
    const end = periodEnd(periodStart);
    const payDate = payDateOf(periodStart);
    const taxYear = payDate.slice(0, 4);
    const ytdStart = ytdStartOf(periodStart);   // year-to-date = Gusto-paid rows worked from here up to periodStart

    const byId = new Map(roster.map(p => [p.id, p]));
    const personFor = id => byId.get(id);

    // Drop repeated row ids (a paged fetch can return a row twice).
    const seen = new Set(), unique = [];
    let dupes = 0;
    for (const r of rows) {
      if (!r) continue;
      if (r.id != null) { if (seen.has(r.id)) { dupes++; continue; } seen.add(r.id); }
      unique.push(r);
    }
    if (dupes) warnings.push(`Skipped ${dupes} repeated row${dupes === 1 ? '' : 's'}.`);

    // Billable: Gusto harvest rows at this company, worked inside the period (work_date, not pay_period),
    // on or after the company's billedFrom date. Earlier ones are listed as not billable.
    const billedFrom = site.billedFrom || null;
    const groups = new Map();
    const early = [];
    for (const r of unique) {
      const d = dateOf(r);
      if (!isGustoHarvest(r) || r.company !== company || d < periodStart || d > end) continue;
      if (billedFrom && d < billedFrom) { early.push(r); continue; }
      const k = personKey(r);
      if (!groups.has(k)) groups.set(k, { key: k, rosterId: r.roster_id || null, rows: [], ytdC: 0, periodC: 0, basis: [], day: new Map(), week: new Map() });
      groups.get(k).rows.push(r);
    }

    // Each billed person's Gusto pay at any site, in any category: earlier periods paid in the same
    // year (year-to-date), and inside this period. Hours per day and per week feed the overtime check.
    for (const r of unique) {
      const g = groups.get(personKey(r));
      if (!g || !gustoPaidBy(r, personFor)) continue;
      const d = dateOf(r);
      const inYtd = d >= ytdStart && d < periodStart;
      const inPeriod = d >= periodStart && d <= end;
      if (!inYtd && !inPeriod) continue;
      if (inYtd) g.ytdC += cents(r.total);
      else {
        g.periodC += cents(r.total);
        const h = milli(rowHours(r)), w = weekStartOf(d);
        g.day.set(d, (g.day.get(d) || 0) + h);
        g.week.set(w, (g.week.get(w) || 0) + h);
      }
      g.basis.push({ id: r.id == null ? null : r.id, work_date: d, category: r.category || 'distro', company: r.company || null,
        hours: milli(rowHours(r)) / 1000, total: round2(r.total), inYtd });
    }

    const people = [];
    const unlinked = [];
    for (const g of groups.values()) {
      const emp = g.rosterId ? personFor(g.rosterId) : null;
      const name = nameOf(emp) || nameOf(g.rows[0]) || '(no name)';
      if (!g.rosterId) unlinked.push(name);
      g.rows.sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || String(a.clock_in || '').localeCompare(String(b.clock_in || '')));
      g.basis.sort((a, b) => a.work_date.localeCompare(b.work_date) || String(a.id).localeCompare(String(b.id)));

      const wagesC = g.rows.reduce((s, r) => s + cents(r.total), 0);
      const wages = wagesC / 100;
      const hours = g.rows.reduce((s, r) => s + milli(rowHours(r)), 0) / 1000;
      const ytdBefore = g.ytdC / 100;
      const periodGustoWages = g.periodC / 100;
      const personTax = employerTax(periodGustoWages, ytdBefore);
      const taxRate = periodGustoWages > 0 ? personTax / periodGustoWages : 0;
      const taxC = cents(wages * taxRate);

      // Overtime: Gusto pays a premium past 8 hours a day and 40 a week, across every job and site.
      // Only days and weeks that hold a billed row are named.
      const billedDays = [...new Set(g.rows.map(dateOf))].sort();
      for (const d of billedDays) {
        const h = g.day.get(d) || 0;
        if (h > DAY_HOURS * 1000) {
          warnings.push(`${name} worked ${fmt(h / 1000)} Gusto-paid hours on ${d} (all jobs and sites). Gusto pays overtime past ${DAY_HOURS} hours a day; only straight-time wages are billed.`);
        }
      }
      for (const w of [...new Set(billedDays.map(weekStartOf))].sort()) {
        const h = g.week.get(w) || 0;
        if (h > WEEK_HOURS * 1000) {
          warnings.push(`${name} worked ${fmt(h / 1000)} Gusto-paid hours in the week ${w} to ${addDays(w, 6)} (Saturday to Friday, all jobs and sites). Gusto pays overtime past ${WEEK_HOURS} hours a week; only straight-time wages are billed.`);
        }
      }
      if (periodGustoWages <= 0) warnings.push(`${name} has no Gusto wages on the board this pay period, so no payroll tax is billed for them.`);

      people.push({ rosterId: g.rosterId, name, rows: g.rows, hours, wages, ytdBefore, periodGustoWages, taxRate,
        tax: taxC / 100, total: (wagesC + taxC) / 100, basisRows: g.basis });
    }
    people.sort((a, b) => a.name.localeCompare(b.name));

    if (unlinked.length) {
      warnings.push(`Not linked to a roster person, so grouped by name: ${unlinked.join(', ')}. Their year-to-date pay may be incomplete.`);
    }

    // Gusto harvest days at this site before billedFrom: worked and paid by Gusto, but not billed.
    // Grouped per person like people[], so the page can list them; rows are the board rows themselves.
    const byTime = (a, b) => dateOf(a).localeCompare(dateOf(b)) || String(a.clock_in || '').localeCompare(String(b.clock_in || ''));
    const earlyGroups = new Map();
    for (const r of early) {
      const k = personKey(r);
      if (!earlyGroups.has(k)) earlyGroups.set(k, { rosterId: r.roster_id || null, rows: [] });
      earlyGroups.get(k).rows.push(r);
    }
    const earlyPeople = [...earlyGroups.values()].map(g => {
      g.rows.sort(byTime);
      return { rosterId: g.rosterId, name: nameOf(g.rosterId ? personFor(g.rosterId) : null) || nameOf(g.rows[0]) || '(no name)', rows: g.rows,
        hours: g.rows.reduce((s, r) => s + milli(rowHours(r)), 0) / 1000, wages: g.rows.reduce((s, r) => s + cents(r.total), 0) / 100 };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const notBillable = {
      from: billedFrom,
      people: earlyPeople,
      days: early.length,
      hours: early.reduce((s, r) => s + milli(rowHours(r)), 0) / 1000,
      wages: early.reduce((s, r) => s + cents(r.total), 0) / 100,
    };
    if (early.length) {
      const n = early.length, one = n === 1;
      warnings.push(`${site.legal} is billed only for work from ${billedFrom} on. ${n} Gusto deleaf/harvest day${one ? '' : 's'} at ${site.label} in this pay period ${one ? 'is' : 'are'} before that (${fmt(notBillable.hours)} h, ${usd(notBillable.wages)} of wages), so ${one ? 'it is' : 'they are'} not billable.`);
    }

    // Gusto wins over sheets: a Gusto employee's sign-in sheet harvest row at this site in the period
    // is paid with Norma's crew and not billed. A Gusto employee is a roster person on Gusto for distro
    // on that date, or anyone with a Gusto Deleaf/Harvest row from the year-to-date start to the period
    // end. The page passes every row on the board and the script reads only up to the period end, so a
    // Gusto row outside that window must not count, or the two would warn differently.
    const hvIds = new Set(), hvNames = new Set();
    for (const r of unique) {
      const d = dateOf(r);
      if (!isGustoHarvest(r) || d < ytdStart || d > end) continue;   // the rows both the page and the script hold
      if (r.roster_id) hvIds.add(r.roster_id); else hvNames.add(nameKey(r));
    }
    const sheet = new Map();
    for (const r of unique) {
      const d = dateOf(r);
      if (r.category !== 'harvest' || isGustoHarvest(r) || r.company !== company || d < periodStart || d > end) continue;
      const emp = r.roster_id ? (personFor(r.roster_id) || null) : rosterByName(roster, r.last, r.first);
      const onGusto = (emp && ((emp.gusto_distro && (!emp.gusto_distro_from || d >= emp.gusto_distro_from)) || hvIds.has(emp.id)))
        || hvNames.has(nameKey(r)) || (emp && hvNames.has(nameKey(emp)));
      if (!onGusto) continue;
      const k = emp ? 'id:' + emp.id : 'name:' + nameKey(r);
      if (!sheet.has(k)) sheet.set(k, { name: nameOf(emp) || nameOf(r) || '(no name)', rows: [] });
      sheet.get(k).rows.push(r);
    }
    for (const s of [...sheet.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const list = s.rows.slice().sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || String(a.clock_in || '').localeCompare(String(b.clock_in || '')))
        .map(r => `${dateOf(r)} (${fmt(rowHours(r))} h${r.team ? ', team ' + String(r.team).trim() : ''})`);
      warnings.push(`${s.name} is on Gusto but has harvest hours at ${site.label} on ${list.join(', ')}: entered from the sheet, paid in Norma's Team, not billed. If Gusto paid it, remove the sheet row.`);
    }

    if (people.length) {
      if (ytdStart === periodStart) {
        warnings.push(`This pay period is paid on ${payDate}, the first payday of ${taxYear}, so the $7,000 unemployment-tax base starts over: no earlier wages count toward it.`);
      } else if (addDays(periodStart, -PERIOD_LEN) === ytdStart) {
        warnings.push(`Year-to-date counts Gusto wages paid in ${taxYear}, which starts with the ${ytdStart} to ${periodEnd(ytdStart)} pay period (paid ${payDateOf(ytdStart)}).`);
      }
      if (payDate.slice(5) === '01-01') {
        warnings.push(`This pay period's payday works out to ${payDate}, a bank holiday. If Gusto paid on ${addDays(payDate, -1)} instead, these wages count toward the ${+taxYear - 1} base, not ${taxYear}; check the Gusto payroll.`);
      }
      warnings.push(`Year-to-date pay counts only Gusto-paid rows on this board (Deleaf/Harvest imports and Gusto distro days) paid in ${taxYear}. Other Filifera Gusto pay, such as trimmer jobs, is not on the board, so a person may have passed $7,000 earlier than shown and been taxed 7.65%, not 13.55%. Check the Gusto paystub for anyone billed above 7.65%.`);
    }

    const sumC = key => people.reduce((s, p) => s + cents(p[key]), 0);
    const wagesC = sumC('wages'), taxC = sumC('tax');
    const totals = { hours: people.reduce((s, p) => s + milli(p.hours), 0) / 1000, wages: wagesC / 100, tax: taxC / 100, total: (wagesC + taxC) / 100 };

    return { company, site, periodStart, periodEnd: end, payDate, taxYear, ytdStart, billedFrom, people, totals, notBillable, warnings };
  }

  globalThis.LaborBilling = Object.freeze({
    TAX, SITES, GUSTO_HV_PREFIX, PAY_LAG_DAYS,
    isGustoHarvest, isGustoPaid, periodStartOf, periodEnd, payDateOf, taxYearOf, ytdStartOf, employerTax, compute,
  });
})();
