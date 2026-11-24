// Checks the Cultivation page (cultivation.html): the page is whole and its script parses, nothing private is in it, every
// pick-list is typable (no <select>), and the pure CULT MODEL gives the right answers on made-up rooms, run under a far-off
// time zone so a date shifted through the local clock shows up.
// Run: node tests/cult-check.mjs   (before every push that touches cultivation.html; any failure means do not push)
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.env.TZ !== 'Pacific/Kiritimati') {   // re-run under UTC+14 so a date pushed through the local clock moves a day
  try { execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, TZ: 'Pacific/Kiritimati' } }); }
  catch { process.exit(1); }
  process.exit(0);
}
const html = readFileSync(new URL('../cultivation.html', import.meta.url), 'utf8');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// ---- the page as a whole
ok(html.length > 30_000 && /<\/html>\s*$/i.test(html), `cultivation.html is complete (${Math.round(html.length / 1024)} KB, ends with </html>)`);
{
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const tmp = path.join(os.tmpdir(), `cult-inline-${process.pid}.js`);
  writeFileSync(tmp, scripts.join('\n;\n'));
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { assert.fail('an inline script does not parse:\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
  finally { rmSync(tmp, { force: true }); }
  n++;
}
const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
ok(!/<select\b/i.test(html), 'no <select>: every pick-list is a typable text box with suggestions');
ok(/list="strain-list"/.test(html) && /function pickFrom\(/.test(html), 'the zone strain box is typable and resolves what was typed with pickFrom');
// nothing private: no email address, no Google file id, no token or key beyond the publishable Supabase key and the Google client id
{
  const emails = (html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).filter(e => !/^(?:supabase-js|supabase)@/i.test(e));
  ok(!emails.length, `no email addresses in the page (${emails.join(', ')})`);
  ok(!/docs\.google\.com|\/d\/[A-Za-z0-9_-]{25,}/.test(html), 'no Google file ids in the page');
  ok(!/CCL\d{2}-\d{7}[^']*'\s*[,}]\s*(?:token|key)/i.test(html) && !/sb_secret_|service_role|eyJhbGci/.test(html), 'no secret keys in the page');
  ok(!/\b(?:2504|2548|5324)\b[^\n]{0,20}(?:Zangbanger|Bluebanger|Tidebanger)/i.test(html), 'strain names come from the database, not the page');
}
// sign-in and reads: Google -> Supabase, then cult_whoami; the page reads the cult_* tables only, writes only through the RPCs
ok(/sb\.rpc\('cult_whoami'\)/.test(html) && /signInWithIdToken/.test(html) && /hd: 'wizardtrees\.com'/.test(html), 'sign-in is the Wizard Trees Google flow and the gate asks cult_whoami');
for (const t of ['cult_rooms', 'cult_zones', 'cult_strain_codes', 'cult_metrc_plants', 'cult_metrc_meta', 'cult_task_done'])
  ok(html.includes(`sb.from('${t}')`), `the page reads ${t}`);
ok(!/\.(?:insert|update|upsert|delete)\(/.test(html), 'the page never writes a table directly');
for (const f of ['cult_task_mark', 'cult_zones_set', 'cult_room_set', 'cult_strain_code_set']) ok(html.includes(`sb.rpc('${f}'`), `the page saves through ${f}`);
ok(/<section id="view-rooms"/.test(markup) && /<section id="view-room"/.test(markup), 'the page has the rooms and the room views');
ok(/\.select\('license,location,strain,state,day,plants'\)/.test(html), 'the Metrc read asks only for the columns it uses (egress)');
ok(/15 \* 60e3/.test(html) && /visibilityState === 'visible'/.test(html), 'the page re-reads at most every 15 minutes, and only while it is on screen');

// ---- the pure model
const src = html.split('/* ===== CULT MODEL START =====')[1].split('/* ===== CULT MODEL END ===== */')[0];
const CM = new Function(`/*${src}; return CM;`)();

// dates stay plain YYYY-MM-DD at UTC+14
assert.equal(CM.addDays('2026-10-29', 62), '2026-12-30'); n++;
assert.equal(CM.addDays('2026-11-30', 1), '2026-12-01'); n++;
assert.equal(CM.diff('2026-10-29', '2026-11-24'), 26); n++;
assert.equal(CM.wday('2026-11-24'), 'Tue 11/24'); n++;
assert.match(CM.todayLA(new Date('2026-11-25T07:30:00Z')), /^2026-11-24$/, 'today is Los Angeles time, not the machine clock'); n++;
assert.equal(CM.todayLA(new Date('2026-11-25T08:30:00Z')), '2026-11-25'); n++;
assert.equal(CM.nice('BLUE BANGER'), 'Blue Banger'); n++;
assert.equal(CM.nice('BB X TB #2'), 'BB x TB #2'); n++;
assert.equal(CM.nice('Silver Tongue'), 'Silver Tongue'); n++;

// strain codes
const codes = { 'CCL25-0000358|2504': { name: 'Zangbanger', source: 'sheet' }, 'CCL25-0000358|2548': { name: 'Bluebanger', source: 'inferred' } };
assert.deepEqual(CM.strainOf('CCL25-0000358', '2504', codes), { name: 'Zangbanger', code: '2504', named: true, sure: true }); n++;
assert.equal(CM.strainOf('CCL25-0000358', '2548', codes).sure, false, 'an inferred name is not settled'); n++;
assert.deepEqual(CM.strainOf('CCL25-0000358', '2999', codes), { name: '#2999', code: '2999', named: false, sure: false }); n++;
assert.equal(CM.strainOf('CCL22-0001216', 'BlueBanger', codes).name, 'BlueBanger', 'a Metrc name is used as it is'); n++;

// a room: 23rd Room 3-like, Metrc moved plants in on two days and one stray plant earlier
const room = { id: 'S3', license: 'CCL25-0000358', metrc_location: 'Room 3', harvest_day: 56, flip_date: '2026-10-14',
  tasks: [{ day: 1, kind: 'ACTION', text: 'FLIP' }, { day: 3, kind: 'SPRAY', text: 'CAL 58' }, { day: 42, kind: 'ACTION', text: 'FINAL LEAF PULL' },
    { day: 56, kind: 'ACTION', text: 'HARVEST' }, { day: 66, kind: 'ACTION', text: 'TRIM' }],
  env: [{ week: 1, temp: '82f - 82f' }, { week: 6, temp: '74f - 70f' }, { week: 7, temp: '72f - 70f' }] };
const rows = [
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2504', state: 'flowering', day: '2026-10-16', plants: 200 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2548', state: 'flowering', day: '2026-10-21', plants: 250 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2999', state: 'flowering', day: '2026-10-14', plants: 1 },
  { license: 'CCL25-0000358', location: 'Room 2', strain: '2504', state: 'flowering', day: '2026-11-03', plants: 99 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2504', state: 'harvested', day: '2026-10-01', plants: 300 },
  { license: 'CCL19-0003836', location: 'Room 3', strain: '2504', state: 'flowering', day: '2026-10-16', plants: 5 },
];
const P = CM.roomPlants(room, rows, codes);
assert.equal(P.total, 451, 'only this license and location count'); n++;
assert.equal(P.first, '2026-10-16', "Metrc's flip is the first day that moved at least 10% of the room, not the stray plant"); n++;
assert.deepEqual(P.strains.map(s => [s.name, s.plants]), [['Bluebanger', 250], ['Zangbanger', 200], ['#2999', 1]]); n++;
assert.deepEqual(P.harvested, [{ day: '2026-10-01', plants: 300, strains: 1 }]); n++;

const today = '2026-11-24';
let C = CM.cycle(room, P, today);
assert.equal(C.flip, '2026-10-14', 'the typed flip wins when it is within 3 weeks of Metrc'); n++;
assert.equal(C.source, 'typed'); n++;
assert.equal(C.day, 42, 'day 1 is the flip day'); n++;
assert.equal(C.week, 6); n++;
assert.equal(C.harvestDate, '2026-12-08', 'harvest = flip + harvest day - 1 (the sheet: 10/14 + 55)'); n++;
assert.equal(C.state, 'flower'); n++;
assert.ok(C.notes.some(x => x.k === 'metrc-day'), "the room says when Metrc moved the plants in"); n++;

// a typed flip from an earlier cycle gives way to Metrc's day
C = CM.cycle({ ...room, flip_date: '2026-08-01' }, P, today);
assert.equal(C.flip, '2026-10-16'); assert.equal(C.source, 'metrc'); assert.ok(C.notes.some(x => x.k === 'old-typed')); n += 3;
// no typed flip: Metrc's
assert.equal(CM.cycle({ ...room, flip_date: null }, P, today).flip, '2026-10-16'); n++;
// flipped in the app, nothing in Metrc yet: the typed flip counts, with a warning
const empty = CM.roomPlants(room, [], codes);
C = CM.cycle({ ...room, flip_date: '2026-11-18' }, empty, today);
assert.equal(C.state, 'flower'); assert.equal(C.day, 7); assert.ok(C.notes.some(x => x.k === 'no-metrc' && x.warn)); n += 3;
// long after a typed flip with no plants: empty
assert.equal(CM.cycle({ ...room, flip_date: '2026-06-01' }, empty, today).state, 'empty'); n++;
// harvested: plants gone from flower, a harvest after the flip
const harv = CM.roomPlants(room, [{ license: 'CCL25-0000358', location: 'Room 3', strain: '2504', state: 'harvested', day: '2026-12-08', plants: 450 }], codes);
C = CM.cycle(room, harv, '2026-12-10');
assert.equal(C.state, 'harvested'); assert.equal(C.lastHarvest.day, '2026-12-08'); n += 2;
// a flip ahead
C = CM.cycle({ ...room, flip_date: '2026-11-30' }, empty, today);
assert.equal(C.state, 'upcoming'); assert.equal(C.day, -5); n += 2;

// tasks: dates from the flip, ticks of this cycle only, late for three days then just past
C = CM.cycle(room, P, today);
const done = [{ room_id: 'S3', cycle: '2026-10-14', task_key: CM.taskKey({ day: 3, text: 'CAL 58' }), done_by: 'someone' },
  { room_id: 'S3', cycle: '2026-08-01', task_key: CM.taskKey({ day: 1, text: 'FLIP' }) }];
let T = CM.tasks(room, C, done, today);
assert.deepEqual(T.map(t => [t.day, t.date, t.status]), [[1, '2026-10-14', 'past'], [3, '2026-10-16', 'done'], [42, '2026-11-24', 'today'],
  [56, '2026-12-08', 'next'], [66, '2026-12-18', 'next']]); n++;
T = CM.tasks(room, C, done, '2026-11-26');
assert.equal(T.find(t => t.day === 42).status, 'late', 'two days after, not ticked: late'); n++;
T = CM.tasks(room, C, done, '2026-11-28');
assert.equal(T.find(t => t.day === 42).status, 'past', 'four days after: just past'); n++;
assert.equal(CM.taskKey({ day: 3, text: '  cal   58 ' }), '3|CAL 58', 'task keys ignore spacing and case'); n++;

// environment weeks
const E = CM.envRows(room, C);
assert.deepEqual(E.map(e => [e.week, e.from, e.to, e.now]), [[1, '2026-10-14', '2026-10-20', false], [6, '2026-11-18', '2026-11-24', true], [7, '2026-11-25', '2026-12-01', false]]); n++;

// zones <-> Metrc: exact, then a unique start; a strain on two zones splits by lights; leftovers are reported
const P2 = { strains: [{ name: 'King Tide', plants: 39, code: null }, { name: 'Riptide', plants: 42 }, { name: 'Riptide x TB', plants: 11 },
  { name: 'Tide', plants: 51 }, { name: 'Cream', plants: 81 }] };
const zones = [{ zone: 1, slot: 1, strain: 'KINGTIDE #3', lights: 4 }, { zone: 2, slot: 1, strain: 'RIPTIDE', lights: 5 },
  { zone: 2, slot: 2, strain: 'RIPTIDE X TB #6 , #1', lights: null }, { zone: 3, slot: 1, strain: 'TIDE', lights: 3 },
  { zone: 4, slot: 1, strain: 'TIDE', lights: 6 }, { zone: 5, slot: 1, strain: 'PHENOS', lights: 2 }];
const pl = CM.place(zones, P2);
assert.deepEqual(pl.slots.map(z => [z.zone, z.name, z.plants]), [[1, 'King Tide', 39], [2, 'Riptide', 42], [2, 'Riptide x TB', 11],
  [3, 'Tide', 17], [4, 'Tide', 34], [5, 'Phenos', 0]]); n++;
assert.deepEqual(pl.unplaced.map(s => s.name), ['Cream']); n++;
assert.deepEqual(pl.missing.map(z => z.name), ['Phenos']); n++;
// a short zone name never grabs a longer strain when two could match
assert.equal(CM.place([{ zone: 1, strain: 'TIDE' }], { strains: [{ name: 'Tidebanger', plants: 5 }, { name: 'Tide X', plants: 2 }] }).slots[0].metrc, null); n++;

// the map: tables split by lights, a dot per plant, lights traced or spread, tall rooms turned on their side
const col = CM.colors(pl);
assert.equal(new Set(Object.values(col)).size, Object.keys(col).length, 'each strain in a room gets its own colour'); n++;
const layout = { w: 20, h: 40, outline: [[0, 0], [20, 0], [20, 40], [0, 40]], doors: [{ x: 10, y: 40, width: 3 }],
  tables: [{ n: 1, x: 2, y: 3, w: 4, h: 30, lights: null, light_spots: [] }, { n: 2, x: 8, y: 3, w: 4, h: 30, light_spots: [[10, 5], [10, 15]], light_kinds: ['V', 'D'] }] };
let M = CM.mapModel(layout, pl, col, { rotate: false });
assert.equal(M.tables.length, 2); n++;
assert.equal(M.tables[0].dots.length, 39, 'zone 1: a dot per Metrc plant'); n++;
assert.equal(M.tables[0].lights.length, 4, 'zone 1: its 4 lights spread along the table'); n++;
assert.equal(M.tables[1].segs.length, 2, 'zone 2 holds two strains'); n++;
// Riptide (5 lights, 42 plants) and Riptide x TB (no lights, 11 plants): the unlit strain takes what its plants need at
// Riptide's plants per light, so the table splits 5 : 5 x 11/42
assert.equal(Math.round(M.tables[1].segs[0].h * 100) / 100, Math.round(30 * 5 / (5 + 5 * 11 / 42) * 100) / 100, 'a strain with no lights still gets its share of the table'); n++;
assert.ok(M.tables[1].segs[1].h > 5, 'Riptide x TB is not squeezed to nothing'); n++;
assert.deepEqual(M.tables[1].lights.map(l => l.kind), ['V', 'D'], 'traced fixtures keep their kind'); n++;
for (const T of M.tables) for (const d of T.dots) ok(d.x >= T.x - 1e-9 && d.x <= T.x + T.w + 1e-9 && d.y >= T.y - 1e-9 && d.y <= T.y + T.h + 1e-9, 'every dot sits on its table');
M = CM.mapModel(layout, pl, col, { rotate: true });
assert.deepEqual([M.w, M.h], [40, 20], 'a tall room turned on its side'); n++;
const t0 = M.tables[0];
assert.deepEqual([t0.x, t0.y, t0.w, t0.h], [40 - 33, 2, 30, 4], 'tables turn with the room'); n++;
for (const T of M.tables) for (const d of T.dots) ok(d.x >= T.x - 1e-9 && d.x <= T.x + T.w + 1e-9 && d.y >= T.y - 1e-9 && d.y <= T.y + T.h + 1e-9, 'every dot sits on its turned table');
assert.equal(CM.mapModel(null, pl, col, {}), null, 'no layout, no map'); n++;

// ---- the review's cases (2026-11-24)
// a harvest never moves the crop's flip: harvested plants come back as 'left' rows by the day they went into flower
const crop = [
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2548', state: 'flowering', day: '2026-10-21', plants: 250 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2504', state: 'harvested', day: '2026-12-10', plants: 200 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2504', state: 'left', day: '2026-10-16', plants: 200 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2504', state: 'left', day: '2026-07-20', plants: 300 },   // an earlier crop
];
const roomM = { ...room, flip_date: null };
let Pc = CM.roomPlants(roomM, crop, codes);
assert.equal(Pc.first, '2026-10-16', 'part of the room harvested: the flip stays the crop\'s first day'); n++;
assert.deepEqual(Pc.cropDays.map(d => d.day), ['2026-10-16', '2026-10-21'], 'an earlier crop is not part of this one'); n++;
Pc = CM.roomPlants(roomM, crop.filter(r => r.state !== 'flowering').concat({ license: 'CCL25-0000358', location: 'Room 3', strain: '2548', state: 'left', day: '2026-10-21', plants: 250 },
  { license: 'CCL25-0000358', location: 'Room 3', strain: '2548', state: 'harvested', day: '2026-12-11', plants: 250 }), codes);
C = CM.cycle(roomM, Pc, '2026-12-12');
assert.equal(C.state, 'harvested', 'all of it harvested: harvested, not empty'); assert.equal(C.flip, '2026-10-16'); n += 2;
assert.ok(CM.tasks(roomM, C, [], '2026-12-12').some(t => t.text === 'TRIM' && t.status === 'next'), 'the trim after harvest is still listed'); n++;
assert.equal(CM.cycle(roomM, Pc, '2027-01-05').state, 'empty', 'three weeks after the harvest the room is empty'); n++;
// a typed flip for the next cycle
C = CM.cycle({ ...room, flip_date: '2026-12-20' }, P, today);
assert.equal(C.flip, '2026-10-16'); assert.ok(C.notes.some(x => x.k === 'next-typed') && !C.notes.some(x => x.k === 'old-typed')); n += 2;
C = CM.cycle({ ...room, flip_date: '2026-12-14' }, Pc, '2026-12-12');
assert.equal(C.flip, '2026-12-14'); assert.equal(C.state, 'upcoming', 'nothing left in flower: the typed next flip counts'); n += 2;
// ticks survive a corrected flip (up to 3 weeks); an untick clears every date the task is ticked under
const done2 = [{ room_id: 'S3', cycle: '2026-10-14', task_key: CM.taskKey({ day: 3, text: 'CAL 58' }) },
  { room_id: 'S3', cycle: '2026-10-16', task_key: CM.taskKey({ day: 3, text: 'CAL 58' }) }];
T = CM.tasks({ ...room, flip_date: '2026-10-15' }, CM.cycle({ ...room, flip_date: '2026-10-15' }, P, today), done2, today);
const cal = T.find(t => t.day === 3);
assert.equal(cal.status, 'done'); assert.deepEqual(cal.cycles.sort(), ['2026-10-14', '2026-10-16']); n += 2;
assert.ok(/data-cycles=/.test(html) && /cb\.dataset\.cycles\.split/.test(html), 'unticking clears the task under every cycle date it is stored under'); n++;
// a strain under its name and its number is one strain; a zone name only extends Metrc's by a number
let pl2 = CM.place([{ zone: 3, strain: 'Riptide', lights: 5 }], { strains: [{ name: 'Riptide', plants: 42 }, { name: 'Riptide', plants: 18, code: '2556' }] });
assert.equal(pl2.slots[0].plants, 60); assert.equal(pl2.unplaced.length, 0); n += 2;
pl2 = CM.place([{ zone: 3, strain: 'TIDE', lights: 3 }, { zone: 4, strain: 'TIDEBANGER', lights: 4 }], { strains: [{ name: 'Tide', plants: 51 }, { name: 'Tidebanger 23', plants: 40 }] });
assert.deepEqual(pl2.slots.map(z => [z.zone, z.name, z.plants]), [[3, 'Tide', 51], [4, 'Tidebanger 23', 40]], 'TIDEBANGER is never Tide (it is Tidebanger 23, its one numbered cut)'); n++;
// whole plants that add up, never below zero
pl2 = CM.place([{ zone: 1, strain: 'Tide', lights: 3 }, { zone: 2, strain: 'Tide', lights: 3 }, { zone: 3, strain: 'Tide', lights: null }], { strains: [{ name: 'Tide', plants: 51 }] });
assert.deepEqual(pl2.slots.map(z => z.plants), [26, 25, 0]); n++;
pl2 = CM.place([1, 2, 3, 4].map(z => ({ zone: z, strain: 'Tide', lights: 1 })), { strains: [{ name: 'Tide', plants: 2 }] });
assert.ok(pl2.slots.every(z => z.plants >= 0) && pl2.slots.reduce((a, z) => a + z.plants, 0) === 2); n++;
// colours stay distinct past 14 strains
const many = CM.colors({ slots: Array.from({ length: 20 }, (v, i) => ({ name: `Strain ${String.fromCharCode(65 + i)}` })), unplaced: [] });
assert.equal(new Set(Object.values(many)).size, 20); n++;
// turned on its side, each strain keeps its end of a north-south table
const tall = { w: 10, h: 40, outline: [[0, 0], [10, 0], [10, 40], [0, 40]], doors: [], tables: [{ n: 1, x: 3, y: 2, w: 4, h: 36 }] };
const plT = CM.place([{ zone: 1, strain: 'North', lights: 6 }, { zone: 1, strain: 'South', lights: 3 }], { strains: [{ name: 'North', plants: 6 }, { name: 'South', plants: 3 }] });
const colT = CM.colors(plT);
const up = CM.mapModel(tall, plT, colT, { rotate: false }), turned = CM.mapModel(tall, plT, colT, { rotate: true });
const northUp = up.tables[0].segs.find(g => g.name === 'North'), northTurned = turned.tables[0].segs.find(g => g.name === 'North');
const southTurned = turned.tables[0].segs.find(g => g.name === 'South');
assert.ok(northUp.y < 10 && northTurned.x > southTurned.x, 'North is at the top upright and at the right (the old top) when turned'); n++;
// a door on a slanted wall runs along that wall
const slant = { w: 48.7, h: 23.8, outline: [[0, 0], [46.0, 0], [42.3, 23.8], [0, 23.8]], doors: [{ x: 44.15, y: 11.9, side: 'e', width: 3 }], tables: [] };
const dm = CM.mapModel(slant, { slots: [] }, {}, { rotate: false }).doors[0];
assert.ok(Math.abs(dm.a[0] / dm.a[1] - (42.3 - 46.0) / 23.8) < 0.01 && dm.nv[0] < 0, 'the gap follows the slanted east wall and swings into the room'); n++;
// a malformed map never throws
assert.doesNotThrow(() => CM.mapModel({ w: 20, h: 10, outline: {}, doors: {}, tables: [null, 7, { n: 1, x: 0, y: 0, w: 4, h: 4, lights: 1e9, light_spots: [null, [1]] }] }, { slots: [] }, {}, {})); n++;
assert.ok(CM.mapModel({ w: 20, h: 10, tables: [{ n: 1, x: 0, y: 0, w: 4, h: 4, lights: 1e9 }] }, { slots: [] }, {}, {}).tables[0].lights.length <= 400); n++;
assert.deepEqual([...CM.tableNs({ tables: [{ n: 1 }, { n: 2 }, null] })], [1, 2]); n++;
// a zone strain recorded in Metrc under another name (25th Room 1: Metrc's Cream is zone 1's Pool Party and King Tide 23)
const plC = CM.place([{ zone: 1, slot: 1, strain: 'Pool Party', lights: 4.5, metrc_strain: 'Cream' }, { zone: 1, slot: 2, strain: 'King Tide 23', lights: 4.5, metrc_strain: 'Cream' },
  { zone: 2, slot: 1, strain: 'Tidebanger', lights: 4 }], { strains: [{ name: 'Cream', plants: 81 }, { name: 'Tidebanger', plants: 42 }] });
assert.deepEqual(plC.slots.map(z => [z.zone, z.name, z.plants, z.metrc && z.metrc.name]), [[1, 'Pool Party', 41, 'Cream'], [1, 'King Tide 23', 40, 'Cream'], [2, 'Tidebanger', 42, 'Tidebanger']],
  "Cream's plants go to zone 1, split by lights, under the zone's own names"); n++;
assert.deepEqual(plC.unplaced, [], 'nothing left over'); assert.deepEqual(plC.missing, []); n += 2;
const colC = CM.colors(plC);
assert.notEqual(colC[CM.key('Pool Party')], colC[CM.key('King Tide 23')], 'each keeps its own colour'); n++;
assert.equal(CM.place([{ zone: 1, strain: 'Pool Party', metrc_strain: 'Cream' }], { strains: [] }).missing.length, 1, 'a Metrc name Metrc does not have here is reported'); n++;
ok(/select\('room_id,zone,slot,strain,lights,pack,metrc_strain'\)/.test(html) && /list="metrc-list"/.test(html), 'the zones read and the editor carry "in Metrc as"');

// Arrange zones: each table holds a zone (default zone n = table n; 0 = none); a zone repeated on a second table is not
// drawn twice
assert.equal(CM.tableZone({ n: 3 }, 0), 3); assert.equal(CM.tableZone({ n: 3, zone: 1 }, 0), 1); assert.equal(CM.tableZone({ zone: 0 }, 4), 0); n += 3;
assert.equal(CM.letter(0), 'A'); assert.equal(CM.letter(3), 'D'); n += 2;
const two = { w: 20, h: 12, outline: [[0, 0], [20, 0], [20, 12], [0, 12]], tables: [{ n: 1, x: 1, y: 1, w: 18, h: 4, zone: 2 }, { n: 2, x: 1, y: 7, w: 18, h: 4, zone: 1 }] };
const plA = CM.place([{ zone: 1, strain: 'Tide', lights: 2 }, { zone: 2, strain: 'Nebula', lights: 2 }], { strains: [{ name: 'Tide', plants: 10 }, { name: 'Nebula', plants: 4 }] });
let MA = CM.mapModel(two, plA, CM.colors(plA), {});
assert.deepEqual(MA.tables.map(t => [t.letter, t.z, t.dots.length]), [['A', 2, 4], ['B', 1, 10]], "zone 1's plants are on table B once it holds zone 1"); n++;
assert.deepEqual([...CM.tableNs(two)].sort(), [1, 2]); n++;
MA = CM.mapModel({ ...two, tables: [{ ...two.tables[0], zone: 1 }, { ...two.tables[1], zone: 1 }] }, plA, CM.colors(plA), {});
assert.deepEqual(MA.tables.map(t => t.z), [1, 0], 'a zone is drawn on one table only'); n++;
assert.deepEqual([...CM.tableNs({ tables: [{ n: 1, zone: 0 }, { n: 2 }] })], [2], 'a table with no zone adds none'); n++;
ok(/id="arrange"/.test(html) && /list="zone-list"/.test(html) && /p_set: \{ layout: L \}/.test(html), 'Arrange zones saves the table-to-zone map through cult_room_set');

// page wiring the review asked for
ok(!/loadAll\(true\);\s*renderRoom\(V\.room\)/.test(html), 'after a save the room is redrawn from the reloaded rooms');
ok(!/\.select\('\*'\)/.test(html), 'every read names its columns (egress)');
ok(/supabase-js@2\.\d+\.\d+\/dist\/umd\/supabase\.js" integrity="sha384-/.test(html), 'the Supabase library is pinned with an integrity hash');
ok(/:root\[data-look="dark"\]\{\s*color-scheme:dark;/.test(html), 'the dark look sets color-scheme for form controls');
ok(/refusedNow/.test(html) && /pointerdown/.test(html), 'Save zones pressed straight from a refused strain box saves nothing');
ok(/timeZone: 'America\/Los_Angeles', month: 'numeric'/.test(html), "a tick's date is the grows' day");

console.log(`cultivation page: ${n} checks passed (TZ ${process.env.TZ})`);
