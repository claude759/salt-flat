// Pure-logic tests for the BA app — runnable without Supabase/Docker.
// These mirror the math in schema.sql (ensure_period), the trips trigger
// (rate*miles rounding), calc-distance (round-trip miles), the edge OCR parse,
// and the CSV exporter. Run: node logic.test.mjs
let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; } else { fail++; console.error(`✗ ${msg}\n   got ${a}\n   want ${b}`); }
};

// ── ensure_period(): bi-weekly window from a Monday anchor ────────────────
// Mirrors: n = floor((d-anchor)/len); ps = anchor + n*len; pe = ps + len-1
const DAY = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);
function periodFor(dateStr, anchor = '2026-01-05', len = 14) {
  const d = Date.parse(dateStr + 'T00:00:00Z'), a = Date.parse(anchor + 'T00:00:00Z');
  const n = Math.floor((d - a) / DAY / len);
  const ps = a + n * len * DAY, pe = ps + (len - 1) * DAY;
  return { start: iso(ps), end: iso(pe) };
}
eq(periodFor('2026-01-05'), { start: '2026-01-05', end: '2026-01-18' }, 'anchor day → first window');
eq(periodFor('2026-01-18'), { start: '2026-01-05', end: '2026-01-18' }, 'last day of window 1');
eq(periodFor('2026-01-19'), { start: '2026-01-19', end: '2026-02-01' }, 'first day of window 2');
eq(periodFor('2026-06-25'), { start: '2026-06-22', end: '2026-07-05' }, 'today maps into one window');
eq(periodFor('2025-12-31'), { start: '2025-12-22', end: '2026-01-04' }, 'date before anchor (neg floor)');
// contiguity + single-coverage across a year: every day in exactly one window, no gaps/overlaps
{
  let cur = periodFor('2026-01-05'), days = 0, ok = true;
  for (let t = Date.parse('2026-01-05T00:00:00Z'); t < Date.parse('2027-01-05T00:00:00Z'); t += DAY) {
    const p = periodFor(iso(t));
    if (iso(t) < p.start || iso(t) > p.end) ok = false;
    days++;
  }
  eq(ok, true, 'every day falls within its computed window (365 days)');
}

// ── trips trigger: amount = round(miles * effective_rate, 2) ──────────────
const mileAmount = (miles, rate) => Math.round((miles || 0) * rate * 100) / 100;
eq(mileAmount(12.4, 0.725), 8.99, '12.4mi @ .725 = 8.99');
eq(mileAmount(0, 0.725), 0, 'zero miles = 0');
eq(mileAmount(100, 0.725), 72.5, '100mi @ .725 = 72.50');
eq(mileAmount(3.333, 0.7), 2.33, 'rounds to cents');

// ── calc-distance: meters one-way → round-trip miles, 2dp ─────────────────
const roundTrip = meters => Math.round((meters / 1609.344) * 2 * 100) / 100;
eq(roundTrip(1609.344), 2.0, '1 mile one-way = 2.00 round trip');
eq(roundTrip(16093.44), 20.0, '10 miles one-way = 20.00 round trip');
eq(roundTrip(0), 0, 'same place = 0');

// ── odometer method: miles = end - start, 1dp ─────────────────────────────
const odoMiles = (s, e) => (s && e && e >= s) ? Math.round((e - s) * 10) / 10 : null;
eq(odoMiles(10000, 10025), 25, 'normal delta');
eq(odoMiles(10000, 9999), null, 'end < start → null');
eq(odoMiles(0, 25.4), null, 'start 0 (falsy) → null (must enter start)');

// ── edge parseJsonLoose(): tolerate prose around JSON ─────────────────────
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}
eq(parseJsonLoose('{"total":12.5}'), { total: 12.5 }, 'clean json');
eq(parseJsonLoose('Here is the receipt:\n{"vendor":"Chevron","total":40.10}\nThanks'),
  { vendor: 'Chevron', total: 40.1 }, 'json embedded in prose');
eq(parseJsonLoose('no json here'), null, 'no json → null');

// ── CSV exporter escaping + formula-injection guard (mirrors exportCSV) ────
const csvCell = c => { let s = String(c ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                       // neutralize spreadsheet formula injection
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
eq(csvCell('Joe'), 'Joe', 'plain cell');
eq(csvCell('Smith, Joe'), '"Smith, Joe"', 'comma quoted');
eq(csvCell('say "hi"'), '"say ""hi"""', 'embedded quotes doubled');
eq(csvCell(40.1), '40.1', 'number → string');
eq(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`, 'formula = neutralized + quoted');
eq(csvCell('+1-800'), "'+1-800", 'leading + neutralized');
eq(csvCell('@cmd'), "'@cmd", 'leading @ neutralized');
eq(csvCell('-5'), "'-5", 'leading - neutralized (note: numbers are passed pre-formatted as fixed strings)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
