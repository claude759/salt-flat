// When the Crew hours reminders go out (crew-hours-notify/index.ts), as plain JavaScript so
// tests/crew-hours-check.mjs can run it under node. Gianni 2026-11-28: the Friday the pay period ends, from 6:30 pm,
// "submit all hours by Saturday 11 am"; then Saturday and Sunday, from 11 am, if they still aren't submitted.
const TZ = 'America/Los_Angeles';
const ANCHOR = '2026-07-04'; // the CA tracker's pay periods: 14 days from this Saturday (labor-billing-core.js)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// wall-clock date and minutes since midnight in Los Angeles (DST-correct)
export function laNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, mins: hour * 60 + Number(p.minute) };
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
}
export function periodStart(iso) {
  return addDays(ANCHOR, Math.floor(daysBetween(ANCHOR, iso) / 14) * 14);
}
// which reminder is due on this Los Angeles day and minute, if any: { kind, period } (the period's first day)
export function dueReminder(date, mins) {
  const start = periodStart(date);
  const day = daysBetween(start, date); // 0..13 within its period; 13 is its last Friday
  if (day === 13 && mins >= 18 * 60 + 30) return { kind: 'friday', period: start };
  const prev = addDays(start, -14);
  if (day === 0 && mins >= 11 * 60) return { kind: 'saturday', period: prev };
  if (day === 1 && mins >= 11 * 60) return { kind: 'sunday', period: prev };
  return null;
}
function short(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MON[m - 1]} ${d}`;
}
export function periodLabel(start) {
  return `${short(start)} - ${short(addDays(start, 13))}`;
}
