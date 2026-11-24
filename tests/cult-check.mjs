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

// step 1 of parity with Cultivation Command: lights per table, coming up, needs attention, the door sheet
const capL = { tables: [{ n: 1, x: 0, y: 0, w: 4, h: 30, light_spots: [[1, 1], [1, 5], [1, 9]] }, { n: 2, x: 6, y: 0, w: 4, h: 30, lights: 8, zone: 1 }, { n: 3, x: 12, y: 0, w: 4, h: 30 }] };
const capZ = CM.place([{ zone: 1, strain: 'A', lights: 9 }, { zone: 2, strain: 'B', lights: 2 }], { strains: [] });
const cap = CM.capacity(capL, capZ);
assert.deepEqual(cap.map(c => [c.letter, c.zone, c.has, c.used, c.over]), [['A', 1, 3, 9, true], ['B', 0, 8, 0, false], ['C', 3, null, 0, false]],
  'traced fixtures, else typed lights; zone 1 sits on its first table (A), as the map draws it; over when given more than it has'); n++;
const Cn = CM.cycle(room, P, today), Tn = CM.tasks(room, Cn, [], today);
assert.deepEqual(CM.comingUp(Cn, Tn, today, 30).map(x => [x.date, x.text]), [['2026-11-24', 'FINAL LEAF PULL'], ['2026-12-08', 'HARVEST'], ['2026-12-18', 'TRIM']].filter(x => x[0] <= CM.addDays(today, 30))); n++;
assert.deepEqual(CM.comingUp(Cn, Tn, today, 0).map(x => x.text), ['FINAL LEAF PULL'], 'Today: only today'); n++;
const att = CM.attention(Cn, CM.tasks(room, Cn, [], '2026-11-27'), '2026-11-27', cap, ['a warning']);
assert.deepEqual(att.map(a => a.k), ['missed', 'over', 'warn'], 'a task not ticked in the last 7 days, an over-full table, the warnings'); n++;
const harvestedC = CM.cycle(roomM, Pc, '2026-12-14');
assert.ok(CM.attention(harvestedC, [], '2026-12-14', [], []).some(a => a.k === 'empty' && /3 days ago/.test(a.text)), 'days since the harvest with no next flip'); n++;
ok(/function buildPrint\(/.test(html) && /Runoff log · week/.test(html) && /&#9744;/.test(html) && /@page\{size:letter portrait/.test(html), 'the door sheet and the weekly runoff log pages print');
ok(/data-range="\$\{d\}"/.test(html) && /cult\.range/.test(html), 'Coming up has Today / 7 days / 30 days, remembered on the device');
ok(/\[#&\]zone=/.test(html), 'a zone in the address opens its card');

// step 2: tasks done, skipped or moved, with notes; one-off tasks; the runoff log
const done3 = [{ room_id: 'S3', cycle: '2026-10-14', task_key: CM.taskKey({ day: 3, text: 'CAL 58' }), status: 'skipped', note: 'rain' },
  { room_id: 'S3', cycle: '2026-10-14', task_key: CM.taskKey({ day: 42, text: 'FINAL LEAF PULL' }), status: 'open', moved_to: '2026-11-26' }];
const one = [{ id: 7, room_id: 'S3', due: '2026-11-25', kind: 'IPM', text: 'Mites on zone 4', status: 'open', created_by: 'a@wizardtrees.com' },
  { id: 8, room_id: 'S3', due: '2026-01-01', kind: 'NOTE', text: 'Old and done', status: 'done' }, { id: 9, room_id: 'S1', due: '2026-11-25', text: 'Another room' }];
const T3 = CM.tasks(room, CM.cycle(room, P, today), done3, today, one);
const cal3 = T3.find(t => t.day === 3), leaf = T3.find(t => t.text === 'FINAL LEAF PULL'), mites = T3.find(t => t.src === 'one');
assert.equal(cal3.status, 'skipped'); assert.equal(cal3.note, 'rain'); n += 2;
assert.deepEqual([leaf.date, leaf.planned, leaf.moved, leaf.status], ['2026-11-26', '2026-11-24', true, 'next'], 'a moved task sits on its new day, still open'); n++;
assert.deepEqual([mites.date, mites.kind, mites.day, mites.status], ['2026-11-25', 'IPM', 43, 'next'], "a one-off task joins the room's list on its due day"); n++;
assert.equal(T3.filter(t => t.src === 'one').length, 1, "an old closed one-off and another room's are left out"); n++;
assert.deepEqual(T3.map(t => t.date), [...T3.map(t => t.date)].sort(), 'tasks run by date'); n++;
assert.ok(!CM.comingUp(CM.cycle(room, P, today), T3, '2026-10-15', 7).some(t => t.text === 'CAL 58'), 'a skipped task is not coming up'); n++;
assert.ok(!CM.attention(CM.cycle(room, P, today), T3, '2026-10-17', [], []).some(a => /CAL 58/.test(a.text)), 'nor missed'); n++;
assert.equal(CM.runoffPct({ cup_ml: 500, tray_ml: 100 }), 20); assert.equal(CM.runoffPct({ cup_ml: 0, tray_ml: 5 }), null); n += 2;
assert.deepEqual(CM.latestRunoff([{ zone: 2, day: '2026-11-24' }, { zone: 1, day: '2026-11-24' }, { zone: 2, day: '2026-11-20' }]).map(r => [r.zone, r.day]), [[1, '2026-11-24'], [2, '2026-11-24']]); n++;
for (const f of ['cult_task_set', 'cult_room_task_add', 'cult_room_task_set', 'cult_runoff_add', 'cult_runoff_delete'])
  ok(html.includes(`sb.rpc('${f}'`), `the page uses ${f}`);
ok(/canWork = !!\(S\.me && \(S\.me\.work \|\| S\.me\.edit\)\)/.test(html), 'the crew (work) can tick, the editors too');
ok(/list="kind-list"/.test(html) && /list="ro-zones"/.test(html), 'the new pick-lists are typable');
// no roles yet (Gianni 2026-11-24: "My app doesn't really need login stuff yet"): one sign-in, then everyone can do everything
ok(!/access-btn|accessPop|cult_crew_/.test(html), 'no Access list or crew on the page');
{
  const sql = readFileSync(new URL('../supabase/cultivation.sql', import.meta.url), 'utf8');
  const body = f => (sql.match(new RegExp(`function public\\.${f}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`)) || [])[1] || '';
  ok(/^\s*select public\.cult_can_view\(\);\s*$/.test(body('cult_can_edit')) && /^\s*select public\.cult_can_view\(\);\s*$/.test(body('cult_can_work')), 'editing and ticking are open to whoever can open the page');
  ok(/drop function if exists public\.cult_crew_list\(\)/.test(sql) && !/create or replace function public\.cult_crew_list/.test(sql), 'the list of Wizard Trees accounts is no longer handed out');
}

// ---- step 3: harvests and trims, crop by crop (made-up rooms and weights; grams in, pounds out)
{
  const codes = { 'L1|2504': { name: 'Zangbanger', source: 'sheet' }, 'L1|2912': { name: 'Voodoo', source: 'sheet' }, 'L1|2559': { name: 'King Tide 23', source: 'sheet' } };
  const hv = (name, day, code, plants, wet, packaged, extra) => ({ name, day, code, strain: null, plants, wet_g: wet, packaged_g: packaged || 0, finished: null, dry_room: 'Dry Room', ...(extra || {}) });
  const tl = (tab, start, end, lights, strain, code, b, l, t, line, room) => ({ file: 'GROW 2026.xlsx', tab, block: 0, line: line || 0, room: room || '1', start, end, lights, strain, code, bigs_g: b, littles_g: l, trim_g: t });
  const H = {
    trims_from: '2026-01-16',
    harvests: [
      hv('F1-ZB-12012025', '2025-12-01', 'ZB', 25, 25000, 4000),
      hv('F1-Zoza-04062026', '2026-04-06', 'Zoza', 10, 5000, 4000),
      hv('F1-2504-04202026', '2026-04-20', '2504', 20, 20000, 3000), hv('F1-2912-04202026', '2026-04-20', '2912', 15, 15000, 2000),
      hv('F1-Cream-04202026', '2026-04-20', 'Cream', 5, 4000, 500), hv('F1-Void-04202026', '2026-04-20', 'Void', 9, 0, 0),
      hv('F1-2504-06222026', '2026-06-22', '2504', 30, 30000, 0), hv('F1-SmoZang-06222026', '2026-06-22', 'SmoZang', 8, 8000, 0),
      hv('F1-2559-11102026', '2026-11-10', '2559', 12, 12000, 0),
    ],
    trims: [
      tl('Jan 20', '2026-01-20', '2026-01-20', 0, 'Wizzy', null, 2000, 300, 500),
      tl('April 16', '2026-04-16', '2026-04-16', 20, 'Zoza', null, 3000, 500, 1500),
      tl('April 30', '2026-04-30', '2026-05-01', 20, 'Zoza', null, 0, 0, 1500, 0), tl('April 30', '2026-04-30', '2026-05-01', 20, 'Zangbanger', '2504', 9000, 1000, 3000, 1),
      tl('April 30', '2026-04-30', '2026-05-01', 20, 'M8', '2912', 6000, 1500, 2500, 2), tl('April 30', '2026-04-30', '2026-05-01', 20, 'Phenos', null, 1000, 200, 300, 3),
      tl('April 30', '2026-04-30', '2026-05-01', 20, 'Floorbuds', null, 0, 100, 0, 4),
      tl('June 30 (early)', '2026-06-30', '2026-06-30', 20, 'Smoothie x Zang #5', null, 1500, 400, 600),
      tl('July 2', '2026-07-02', '2026-07-03', 20, 'Zangbanger', '2504', 12000, 2000, 4000, 0), tl('July 2', '2026-07-02', '2026-07-03', 20, 'Smoothie x Zang #6', null, 2000, 500, 700, 1),
      tl('July 2', '2026-07-02', '2026-07-03', 20, 'Smoothie x Zang #5', null, 1500, 400, 600, 2),
    ],
  };
  const O = { license: 'L1', codes, today: '2026-11-20', room: '1', site: 'F' };
  const R = CM.history(H, O);
  const by = (R0, d) => R0.crops.find(c => c.days.includes(d));
  const A = by(R, '2026-04-20'), B = by(R, '2026-06-22'), Cc = by(R, '2026-11-10'), D = by(R, '2025-12-01'), Lz = R.crops.find(c => c.noHarvest);
  assert.deepEqual(R.crops.map(c => c.days.join('+') || 'none'), ['2025-12-01', 'none', '2026-04-06+2026-04-20', '2026-06-22', '2026-11-10'], 'crops are the harvest days cut at 3 weeks, a trim with no harvest is its own, oldest first'); n++;
  assert.ok(!R.harvests.some(h => h.name === 'F1-Void-04202026'), 'a harvest with no wet weight is left out'); n++;
  assert.deepEqual(A.tabs.map(T => T.tab), ['April 16', 'April 30'], 'each tab goes to the latest harvest day 3 to 30 days before it'); n++;
  assert.deepEqual([A.tabs[0].partial, A.state, A.mainTab.tab], [true, 'trimmed', 'April 30'], 'a crop is trimmed by the full tab after its last harvest, not by a small early one'); n++;
  assert.equal(A.tabs[1].lines.find(x => x.strain === 'Zoza').counted, false, "a no-bigs line repeating an earlier tab's trim counts once"); n++;
  assert.deepEqual([A.bigs, A.littles, A.trim, A.flower, A.plants, A.lights], [19000, 3300, 7300, 22300, 50, 20], "the crop's grams, plants and lights"); n++;
  assert.equal(+A.lbPerLight.toFixed(4), +(22300 / CM.LB / 20).toFixed(4), 'lb per light = (bigs + littles) in pounds / lights'); n++;
  assert.equal(+A.bigsPct.toFixed(2), +(19000 / 22300 * 100).toFixed(2), 'bigs % of the flower'); n++;
  assert.equal(+A.gPerPlant.toFixed(2), +(22300 / 50).toFixed(2), 'g per plant over all its Metrc plants'); n++;
  assert.deepEqual(A.wetSuspect, ['F1-Zoza-04062026'], 'a harvest that packaged more than half its wet weight is flagged'); n++;
  const st = Object.fromEntries(A.strains.map(x => [x.name, x]));
  assert.deepEqual([st.Zoza.plants, st.Zangbanger.plants, st.Voodoo.plants], [10, 20, 15], 'sheet lines meet their Metrc harvests by strain number, else by name; M8 2912 is Voodoo'); n++;
  assert.ok(st.Phenos.room && st.Floorbuds.room && st.Phenos.plants == null && A.strains[A.strains.length - 1].room, "Phenos and Floorbuds are the room's, last"); n++;
  assert.deepEqual([A.metrcOnly.map(x => x.label), A.sheetOnly], [['Cream'], []], 'a Metrc harvest no line names is listed'); n++;
  const copy = R.tabs.find(T => T.tab === 'June 30 (early)');
  assert.ok(copy.repeatOf === 'July 2' && !B.tabs.includes(copy) && B.flower === 12000 + 2000 + 2000 + 500 + 1500 + 400, 'a tab shown again, the same, on a later tab within 3 weeks is a copy and counts once'); n++;
  const s5 = B.strains.find(x => x.name === 'Smoothie x Zang #5'), s6 = B.strains.find(x => x.name === 'Smoothie x Zang #6');
  assert.ok(s5.shared && s6.shared && s5.plants == null && B.metrcOnly.length === 0, 'two lines sharing one Metrc harvest get no plants, and the harvest is not missing'); n++;
  assert.equal(+B.vsLast.lbPerLight.toFixed(2), +((B.lbPerLight - A.lbPerLight) / A.lbPerLight * 100).toFixed(2), 'against the crop before'); n++;
  assert.deepEqual([Cc.state, Cc.dryDay, D.state, Lz.state, Lz.full], ['drying', 11, 'before', 'trimmed', false], 'drying (day 11), trimmed before the trim sheets, a trim with no harvest'); n++;
  const w = CM.trimWait(CM.history(H, { ...O, today: '2026-12-05' }).crops, '2026-12-05');
  assert.ok(w.length === 1 && /25 days ago/.test(w[0].text) && /not on the trim sheets yet/.test(w[0].text) && CM.trimWait(R.crops, '2026-11-20').length === 0, 'harvested 15 to 45 days ago with no trim: needs attention (drying is not)'); n++;
  assert.equal(CM.trimWait(CM.history(H, { ...O, today: '2027-02-01' }).crops, '2027-02-01').length, 0, 'not after 45 days'); n++;
  // the estimate: the room's rate x the lights it was counted on; the zones' lights only beside it
  const e1 = CM.estimate(R.crops, 30);
  assert.deepEqual([+e1.rate.toFixed(4), e1.lights, e1.zoneLights, +e1.lb.toFixed(2)], [+((A.lbPerLight + B.lbPerLight) / 2).toFixed(4), 20, 30, +(e1.rate * 20).toFixed(2)], "the estimate: the last 3 trimmed crops' rate x their trim sheet's lights"); n++;
  assert.equal(CM.estimate([{ full: true, lbPerLight: 0.5, lights: 20 }, { full: true, lbPerLight: 3, lights: 20 }], 10).rate, 3, 'a crop under 1.2 lb per light is left out'); n++;
  assert.ok(CM.estimate([], 30) === null && CM.history({}, {}).crops.length === 0, 'no history, no crops, no estimate'); n++;
  // a small early tab: the crop is drying, partly on the sheets, with no numbers until its last harvest's trim lands
  const Hp = { ...H, trims: H.trims.filter(t => t.tab === 'April 16') };
  const Ap = by(CM.history(Hp, { ...O, today: '2026-04-27' }), '2026-04-20');
  assert.deepEqual([Ap.state, Ap.partly, Ap.lbPerLight, Ap.gPerPlant, Ap.soFar], ['drying', true, null, null, 3500], 'an early partial tab leaves the crop drying, with what is on the sheets so far'); n++;
  assert.ok(/only partly on the trim sheets/.test(CM.trimWait(CM.history(Hp, { ...O, today: '2026-05-10' }).crops, '2026-05-10')[0].text), 'and waiting says "only partly"'); n++;
  // a tab 0 to 2 days after a harvest is its trim; two full tabs for one harvest are a mix-up with no numbers
  const H2 = { harvests: [hv('F2-2504-10052026', '2026-10-05', '2504', 40, 40000)], trims: [tl('Oct 6', '2026-10-06', '2026-10-06', 20, 'Zangbanger', '2504', 20000, 2000, 5000)] };
  const R2 = CM.history(H2, { ...O, today: '2026-11-20' });
  assert.deepEqual([R2.crops.length, R2.crops[0].state], [1, 'trimmed'], 'a tab the day after a harvest is its trim'); n++;
  const H3 = { harvests: [hv('F1-2504-09282026', '2026-09-28', '2504', 40, 40000)], trims: [tl('Oct 8', '2026-10-08', '2026-10-08', 20, 'Zangbanger', '2504', 20000, 2000, 5000), tl('Oct 20', '2026-10-20', '2026-10-20', 20, 'Zangbanger', '2504', 21000, 2500, 5000)] };
  const C3 = CM.history(H3, { ...O, today: '2026-11-20' }).crops[0];
  assert.deepEqual([C3.state, C3.double, C3.lbPerLight], ['check', ['Oct 8', 'Oct 20'], null], 'two full tabs for one harvest: check the sheets, no numbers'); n++;
  // per strain: the packages' names only when nothing else matched; plants that don't fit the pounds are not shown
  const H4 = { harvests: [hv('F1-2504-08242026', '2026-08-24', '2504', 50, 60000), hv('F1-Wizzy X Tide-08242026', '2026-08-24', 'Wizzy X Tide', 10, 9000, 0, { strain: 'King Tide' }),
    hv('F1-Cream-08242026', '2026-08-24', 'Cream', 4, 5000, 0, { strain: 'Zangbanger' })],
    trims: [tl('Sep 3', '2026-09-03', '2026-09-04', 20, 'Zangbanger', '2504', 6000, 1000, 2000, 0), tl('Sep 3', '2026-09-03', '2026-09-04', 20, 'KINGTIDE', '2559', 1000, 100, 300, 1),
      tl('Sep 3', '2026-09-03', '2026-09-04', 20, 'Floorbuds', null, 0, 50, 0, 2)] };
  const C4 = CM.history(H4, { ...O, today: '2026-11-20' }).crops[0], s4 = Object.fromEntries(C4.strains.map(x => [x.name, x]));
  assert.deepEqual([s4['King Tide 23'].plants, s4['King Tide 23'].byVote, C4.metrcOnly.map(x => x.label)], [10, true, ['Cream']], "a line nothing names takes a harvest no line took whose packages carry its name, said as such"); n++;
  const H5 = { harvests: [hv('B-2546-03172026', '2026-03-17', '2546', 87, 90000), hv('B-BlueMagXZB-03172026', '2026-03-17', 'BlueMagXZB', 5, 3000, 0, { strain: 'Jungle Juice' })],
    trims: [tl('March 27', '2026-03-27', '2026-03-28', 30, 'Antidote', null, 40000, 5000, 9000, 0), tl('March 27', '2026-03-27', '2026-03-28', 30, 'Blue', null, 300, 50, 80, 1)] };
  const s5b = CM.history(H5, { ...O, today: '2026-11-20' }).crops[0].strains.find(x => x.name === 'Antidote');
  assert.deepEqual([s5b.plants, s5b.gPerPlant, s5b.doubt], [null, null, true], "plants that make a strain's g per plant over 3 times the crop's are not shown"); n++;
  assert.ok(CM.skey('Smoothie x Zan #5') === CM.skey('Smoothie X Zangria') && CM.skey('Zang Banger') === 'ZANGBANGER' && CM.skey('ZB') === 'ZANGBANGER', 'Zan and Zang are Zangria in a cross; Zang Banger and ZB are Zangbanger'); n++;
  assert.ok(CM.skey('Black Light #27') === CM.skey('BL') && CM.skey('M8') === CM.skey('Medusa') && CM.skey('Phenos (Room C)') === 'PHENOS', 'BL, M8 and Medusa, and a room named on a line'); n++;
  // Olympic: its sheets number the trims, not the rooms, so a tab goes to the room whose harvest has its strain numbers
  const hvO = (name, day, code, plants) => hv(name, day, code, plants, plants * 1000);
  const HO = { harvests: [hvO('F2-07232026', '2026-07-23', '2507, 2509, 2510, 2513, 2522, 2697', 485), hvO('F2-2502-09282026', '2026-09-28', '2502', 69)],
    site_harvests: [['1', '2026-07-29', '2501'], ['1', '2026-07-29', '2502'], ['1', '2026-07-29', '2508'], ['1', '2026-10-10', '2554'], ['1', '2026-10-10', '2550']],
    trims: [tl('Aug 2', '2026-08-02', '2026-08-02', 54, 'Dark Matter', '2507', 20000, 3000, 6000, 0, '1'), tl('Aug 2', '2026-08-02', '2026-08-02', 54, 'Tea Party', '2509', 20000, 3000, 6000, 1, '1'),
      tl('Aug 2', '2026-08-02', '2026-08-02', 54, 'British Delight', '2510', 10000, 1000, 3000, 2, '1'), tl('Aug 2', '2026-08-02', '2026-08-02', 54, 'Black Light', '2513', 9000, 1000, 2000, 3, '1'),
      tl('Aug 2', '2026-08-02', '2026-08-02', 54, 'Black Magic', '2502', 2000, 300, 600, 4, '1'),
      tl('Aug 8-9', '2026-08-08', '2026-08-09', 54, 'Bruce Banner', '2501', 30000, 4000, 9000, 0, '1'), tl('Aug 8-9', '2026-08-08', '2026-08-09', 54, 'Black Magic', '2502', 25000, 3000, 8000, 1, '1'),
      tl('Oct 8-9', '2026-10-08', '2026-10-09', 54, 'Black Magic', '2502', 30000, 4000, 9000, 0, '2'),
      tl('Oct 20-21', '2026-10-20', '2026-10-21', 54, 'Antidote', '2554', 30000, 4000, 9000, 0, '2'), tl('Oct 20-21', '2026-10-20', '2026-10-21', 54, 'Nebula', '2550', 20000, 3000, 6000, 1, '2')] };
  const RO = CM.history(HO, { license: 'L9', codes: {}, today: '2026-11-24', room: '2', site: 'O' });
  assert.deepEqual(RO.crops.map(c => [c.first, c.tabs.map(T => T.tab + (T.movedFrom ? ' from ' + T.movedFrom : ''))]), [['2026-07-23', ['Aug 2 from 1']], ['2026-09-28', ['Oct 8-9']]], "Olympic: Aug 2 (filed under 1) is room 2's; Oct 20-21 (filed under 2) is room 1's"); n++;
  assert.deepEqual(RO.harvests[0].codes, ['2507', '2509', '2510', '2513', '2522', '2697'], 'a harvest of several strains keeps every strain number'); n++;
  const RF = CM.history({ ...HO, harvests: [hvO('F2-2502-09282026', '2026-09-28', '2502', 69)] }, { license: 'L9', codes: {}, today: '2026-11-24', room: '2', site: 'F' });
  assert.deepEqual([RF.crops.map(c => c.tabs.map(T => T.tab)), RF.crops[0].state], [[['Oct 8-9', 'Oct 20-21']], 'trimmed'], "elsewhere a tab stays in the sheet's room (two that share no strain are one trim, added up)"); n++;
  // a tie between two rooms stays in the sheet's room, the same from every room's page
  const tie = { harvests: [hvO('F2-2502-09282026', '2026-09-28', '2502', 69)], site_harvests: [['1', '2026-10-10', '2550']],
    trims: [tl('Oct 23 cont.', '2026-10-23', '2026-10-23', 54, 'Black Magic', '2502', 5000, 500, 900, 0, '3'), tl('Oct 23 cont.', '2026-10-23', '2026-10-23', 54, 'Nebula', '2550', 4000, 500, 900, 1, '3')] };
  const t2 = CM.history(tie, { license: 'L9', codes: {}, today: '2026-11-24', room: '2', site: 'O' });
  assert.equal(t2.tabs.length, 0, "Olympic: a tab two rooms tie for stays in the sheet's room (3), so neither room counts it"); n++;
  // a line that names another room goes there when that room had a harvest 3 to 30 days before (its lights stay behind)
  const HI = (room, hvs, others) => ({ harvests: hvs, site_harvests: others, trims: [tl('June 16-18', '2026-06-16', '2026-06-18', 40, 'Zangbanger', '2504', 40000, 5000, 9000, 0, 'A'),
    tl('June 16-18', '2026-06-16', '2026-06-18', 40, 'Phenos (Room C)', null, 4300, 0, 1000, 1, 'A'), tl('March 27-28', '2026-03-27', '2026-03-28', 33, 'Room C Phenos', null, 0, 0, 3000, 0, 'B')] });
  const RC = CM.history(HI('C', [hv('FC-06062026', '2026-06-06', '2424', 124, 90000)], [['A', '2026-06-06', '2504'], ['B', '2026-03-17', '2546']]), { license: 'L1', codes, today: '2026-11-24', room: 'C', site: 'I' });
  assert.deepEqual([RC.crops.length, RC.crops[0].flower, RC.crops[0].lights, RC.crops[0].strains[0].movedIn], [1, 4300, null, 'A'], "Room C's line in Room A's tab is Room C's, without A's lights"); n++;
  const RA = CM.history(HI('A', [hv('FA-2504-06062026', '2026-06-06', '2504', 300, 300000)], [['C', '2026-06-06', '2424'], ['B', '2026-03-17', '2546']]), { license: 'L1', codes, today: '2026-11-24', room: 'A', site: 'I' });
  assert.equal(RA.crops[0].flower, 45000, "and leaves Room A's crop"); n++;
  const RB = CM.history(HI('B', [hv('FB-2546-03172026', '2026-03-17', '2546', 80, 80000)], [['C', '2026-06-06', '2424'], ['A', '2026-06-06', '2504']]), { license: 'L1', codes, today: '2026-11-24', room: 'B', site: 'I' });
  assert.equal(RB.crops[0].trim, 3000, "a line naming a room with no harvest then stays where the sheet put it"); n++;
  // trimmed by what is on the sheets: a poor crop under 1.2 lb per light counts once no tab has come for 3 weeks; a
  // harvest trimmed over two tabs that split its strains adds up; a few plants cut late don't hold the crop back
  const Hpoor = { harvests: [hv('F1-2504-10292026', '2026-10-29', '2504', 300, 300000)], trims: [tl('Nov 6', '2026-11-06', '2026-11-07', 37, 'Zangbanger', '2504', 15000, 3000, 6000)] };
  assert.deepEqual(['2026-11-12', '2026-11-30'].map(d => CM.history(Hpoor, { ...O, today: d }).crops[0].state), ['drying', 'trimmed'], 'a poor crop (under 1.2 lb per light) counts as trimmed once no tab has come for 3 weeks'); n++;
  const Hsplit = { harvests: [hv('F1-2504-10292026', '2026-10-29', '2504', 150, 150000), hv('F1-2548-10292026', '2026-10-29', '2548', 150, 150000)],
    trims: [tl('Nov 6', '2026-11-06', '2026-11-06', 37, 'Zangbanger', '2504', 15000, 2000, 6000, 0), tl('Nov 7', '2026-11-07', '2026-11-07', 37, 'Bluebanger', '2548', 14000, 2000, 6000, 0)] };
  const Cs = CM.history(Hsplit, { ...O, today: '2026-11-12' }).crops[0];
  assert.deepEqual([Cs.state, Cs.flower, Cs.double], ['trimmed', 33000, null], 'two tabs that split one harvest between them, each under 1.2 lb per light, add up to the trim'); n++;
  const Hlate = { harvests: [hv('F1-2504-10292026', '2026-10-29', '2504', 300, 300000), hv('F1-2504-11092026', '2026-11-09', '2504', 4, 4000)],
    trims: [tl('Nov 6-7', '2026-11-06', '2026-11-07', 37, 'Zangbanger', '2504', 45000, 5000, 15000)] };
  assert.equal(CM.history(Hlate, { ...O, today: '2026-11-24' }).crops[0].state, 'trimmed', 'a few plants cut after the trim began (under a tenth) leave the crop trimmed'); n++;
  // a tab with no lights is of unknown size: never one of "two full trims"
  const Hnl = { harvests: [hv('FC-2424-06062026', '2026-06-06', '2424', 124, 90000)], site_harvests: [['A', '2026-06-06', '2504']],
    trims: [tl('June 16-18', '2026-06-16', '2026-06-18', 40, 'Phenos (Room C)', null, 4300, 0, 1000, 1, 'A'), tl('June 19 (6L)', '2026-06-19', '2026-06-19', 6, 'Phenos', null, 5000, 400, 900, 0, 'C')] };
  assert.equal(CM.history(Hnl, { license: 'L1', codes, today: '2026-11-24', room: 'C', site: 'I' }).crops[0].state, 'trimmed', 'a moved line with no lights does not make two full trims'); n++;
  // a doubted strain's harvest is listed as not matched; a line naming another room that stays keeps its name
  const C5 = CM.history(H5, { ...O, today: '2026-11-20' }).crops[0];
  assert.ok(C5.metrcOnly.some(x => x.name === 'B-BlueMagXZB-03172026'), "a doubted strain's harvest shows as not matched"); n++;
  const RB2 = CM.history(HI('B', [hv('FB-2546-03172026', '2026-03-17', '2546', 80, 80000)], [['C', '2026-06-06', '2424']]), { license: 'L1', codes, today: '2026-11-24', room: 'B', site: 'I' });
  assert.deepEqual(RB2.crops[0].strains.map(x => x.name), ['Room C Phenos'], 'a line naming another room that stays keeps its name'); n++;
  // a partly trimmed crop lists what is still to trim
  assert.deepEqual(Ap.toTrim.map(x => x.label).sort(), ['Cream', 'Voodoo', 'Zangbanger'], 'a partly trimmed crop lists the harvests still to trim'); n++;
  // the database side
  const sql = readFileSync(new URL('../supabase/cultivation.sql', import.meta.url), 'utf8');
  const fn = (sql.match(/create or replace function public\.cult_room_history\(p_room text\)[\s\S]*?end \$\$;/) || [''])[0];
  ok(/security definer set search_path = public/.test(fn) && /if not public\.cult_can_view\(\) then raise exception 'not allowed'/.test(fn), 'the history is read only by whoever can open the page');
  ok(/revoke all on function public\.cult_room_history\(text\) from public, anon;/.test(sql) && /grant execute on function public\.cult_room_history\(text\) to authenticated;/.test(sql), 'not by anon');
  ok(/archived_date is null/.test(fn) && /coalesce\(h\.wet_weight, 0\) > 0/.test(fn) && /'\^F\(\[0-9A-Z\]\)\$'/.test(fn), "voided and weightless harvests are left out; 'F1-' and 'FA-' are rooms 1 and A");
  ok(/r\.site = 'O'/.test(fn) && /\\mroom\\s\*' \|\| rk/.test(fn) && /'site_harvests'/.test(fn) && /'room', upper\(btrim\(t\.room\)\)/.test(fn), "Olympic's lines, lines naming the room, and the other rooms' harvest days go to the page");
  ok(!/dollar|price|cost|went|buyer|package_count/i.test(fn.replace(/^--.*$/gm, '')), 'pounds only: no money, buyers or packages');
  // the page side
  ok(html.includes("sb.rpc('cult_room_history', { p_room: id })") && /id="hv-panel"/.test(html) && /id="hv-body"/.test(html), 'the room page reads and shows its harvests');
  ok(/CM\.trimWait\(HV\.R\.crops, today\)/.test(html) && /CM\.estimate\(HV\.R\.crops, V\.lights\)/.test(html) && /id="hv-est"/.test(html), 'the wait goes to Needs attention, the estimate to the Harvest tile');
  ok(/loadHistory\(S\.room, true\)/.test(html) && /HIST_TTL = 60 \* 60e3/.test(html) && /e\.busy/.test(html), 'read on open, after an hour, and on Refresh; one read at a time');
  const lh = (html.match(/async function loadHistory[\s\S]*?\n\}/) || [''])[0];
  ok(/if \(room\) paintHv\(room\);/.test(lh) && !/renderRoom/.test(lh), 'a late answer repaints only the parts it feeds, never the whole page');
  ok(/pollTimer = setInterval\(async \(\) => \{ if \(document\.visibilityState === 'visible' && !formOpen\(\)\)/.test(html) && /S\.room && !formOpen\(\)\) renderRoom/.test(html), 'the poll and a resize wait while a form is open');
  ok(/<button type="button" class="hvr"/.test(html) && /\.hvl \.hc3,\.hvl \.hc6,\.hvd \.hcb,\.hvd \.hct\{display:none\}/.test(html) && /table\.t th\.n\{text-align:right\}/.test(html), 'crops are buttons; a phone hides two columns of the list and two of the strain table; number headers sit over their numbers');
  ok(/cult_room_history: a =>/.test(html), 'the local preview answers it too');
  ok(/class="ph"/.test(html) && /\.hvl \.ph\{display:inline\}/.test(html) && html.indexOf('.hvl .ph{display:none}') < html.indexOf('.hvl .ph{display:inline}') && /aria-label="\$\{esc\(said \+ '\. Its trim report\.'\)\}"/.test(html), "on a phone a crop's state shows in the list; each crop says what its numbers are");
  ok(/if \(window\.innerWidth === w\) return;/.test(html), 'a resize that only changes the height (a phone\'s address bar) redraws nothing');
  ok(/if \(!focusKey && a && b\.contains\(a\) && a\.dataset && a\.dataset\.crop\) focusKey = a\.dataset\.crop;/.test(html) && /const r = b\.querySelectorAll\('button\.hvr'\)\[n\]; if \(r\) r\.focus\(\);/.test(html), 'focus stays on its crop through a repaint, and Show older moves it to the first crop shown');
  ok(/The harvest history isn't on the server yet\. Ask Gianni\./.test(html) && /Couldn't read them again: showing the copy from/.test(html), 'a failed read says what can help, and a failed re-read says the copy is the last one');
  ok(/if \(c\.double\) \{\s*h \+= '<div class="wrapx"><table class="t"><thead><tr><th>Tab on the trim sheets<\/th>/.test(html), "a crop to check shows each tab's pounds, never the two added up");
  ok(/Still to trim: /.test(html) && /if \(c\.full\) \{\s*const nm = \[\];/.test(html), "a partly trimmed crop lists what is still to trim; 'not matched' is said only of a trimmed crop");
  ok(/S\.attBase = \(S\.attBase \|\| \[\]\)\.filter\(x => x\.k !== 'trim'\)/.test(html) && /S\.attBase\.concat\(glAtt\(glCompute\(room\)\)\)/.test(html), "a late history answer redraws Needs attention with Growlink's items, as glRefresh does");
}

// page wiring the review asked for
ok(!/loadAll\(true\);\s*renderRoom\(V\.room\)/.test(html), 'after a save the room is redrawn from the reloaded rooms');
ok(!/\.select\('\*'\)/.test(html), 'every read names its columns (egress)');
ok(/supabase-js@2\.\d+\.\d+\/dist\/umd\/supabase\.js" integrity="sha384-/.test(html), 'the Supabase library is pinned with an integrity hash');
ok(/:root\[data-look="dark"\]\{\s*color-scheme:dark;/.test(html), 'the dark look sets color-scheme for form controls');
ok(/refusedNow/.test(html) && /pointerdown/.test(html), 'Save zones pressed straight from a refused strain box saves nothing');
ok(/timeZone: 'America\/Los_Angeles', month: 'numeric'/.test(html), "a tick's date is the grows' day");

// ---- Growlink: live readings beside the week's plan (the job only reads Growlink; the page only reads the copy)
{
  const at = x => Date.parse(x), iso = t => new Date(t).toISOString();
  assert.deepEqual(CM.glPlan({ week: 9, temp: '68f - 66f', hum: '47% - 45%', vpd: 1.4, co2: 'n/CO2' }),
    { temp: { day: 68, night: 66 }, hum: { day: 47, night: 45 }, vpd: { day: 1.4, night: 1.4 }, co2: null }, 'the plan: DAY/NIGHT TEMP and HUM, VPD, no CO2'); n++;
  assert.deepEqual(CM.glPlan({ temp: '82f', hum: '70%', vpd: null, co2: 1000 }),
    { temp: { day: 82, night: 82 }, hum: { day: 70, night: 70 }, vpd: null, co2: { day: 1000, night: null } }, 'one number is day and night; CO2 is lights-on only'); n++;
  // Growlink's light schedule on the room's clock (this check runs at UTC+14; Los Angeles is UTC-8 in late November)
  const L = { on: '13:00', off: '01:00', tz: 'America/Los_Angeles' };
  assert.deepEqual(CM.glLights(L, at('2026-11-24T20:26:00Z')), { on: false, since: 686 }, '12:26 PM: off since 1 AM'); n++;
  assert.deepEqual(CM.glLights(L, at('2026-11-24T21:10:00Z')), { on: true, since: 10 }, '1:10 PM: on 10 minutes'); n++;
  assert.deepEqual(CM.glLights(L, at('2026-11-25T08:30:00Z')), { on: true, since: 690 }, '12:30 AM: still on, across midnight'); n++;
  assert.deepEqual(CM.glLights({ on: '08:00', off: '16:00', tz: 'America/Los_Angeles' }, at('2026-11-24T15:59:00Z')), { on: false, since: 959 }, '7:59 AM: off'); n++;
  assert.equal(CM.glLights({ on: '08:00', off: '08:00' }, at('2026-11-24T15:59:00Z')), null); assert.equal(CM.glLights(null, 0), null); n += 2;
  assert.deepEqual(CM.glLights({ ...L, tz: 'Not/AZone' }, at('2026-11-24T21:10:00Z')), { on: true, since: 10 }, 'a zone the browser does not know falls back to Los Angeles'); n++;
  const plan = CM.glPlan({ temp: '70f - 68f', hum: '55% - 48%', vpd: 1.3, co2: 1500 });
  assert.deepEqual([CM.glJudge('temp', 72, plan, true).state, CM.glJudge('temp', 72.1, plan, true).state, CM.glJudge('temp', 65.9, plan, false).state], ['ok', 'high', 'low'], 'within 2°F of the plan is on it'); n++;
  assert.equal(CM.glJudge('co2', 400, plan, false), null, 'CO2 is not judged with the lights off'); assert.equal(CM.glJudge('co2', 1200, plan, true).state, 'low'); n += 2;
  assert.equal(CM.glJudge('temp', 90, plan, null), null, 'no schedule: nothing judged'); assert.equal(CM.glJudge('light', 0, plan, true), null); assert.equal(CM.glJudge('temp', 90, null, true), null); n += 3;
  assert.equal(CM.glLightOdd(0, 'lux', { on: true, since: 20 }), null, 'the lights settle for 30 minutes after a switch'); n++;
  assert.deepEqual([CM.glLightOdd(0, 'lux', { on: true, since: 45 }), CM.glLightOdd(52000, 'lux', { on: false, since: 45 }), CM.glLightOdd(52000, 'lux', { on: true, since: 45 }), CM.glLightOdd(5, 'PPFD', { on: true, since: 45 })],
    ['dark', 'lit', null, null], 'a light level at odds with the schedule (lux sensors only)'); n++;
  // a room as the job saves it: week 2 of a cycle that flipped 11/14 (night: 78°F, 68%), read at 12:29 PM with the lights off
  const room = { env: [{ week: 1, temp: '82f - 82f', hum: '70%', vpd: 1.0, co2: 1000 }, { week: 2, temp: '80f - 78f', hum: '68%', vpd: 1.1, co2: 1300 }] };
  const E = CM.envRows(room, { flip: '2026-11-14', week: 2 });
  const NOW = at('2026-11-24T20:30:00Z'), r1 = iso(NOW - 6e4);
  const G = { growlink: '25th Room 1', reading_at: r1, lights: L, setpoints: { temp: { day: 70, night: 70 }, hum: { day: 55, night: 48 }, co2: { day: 1500, night: null }, use_vpd: false },
    sensors: [
      { m: 'temp', name: 'Room Temp Average', module: 'Climate Sensor Average', v: 82.4, unit: '°F', at: r1,
        parts: [{ name: 'Room Temp', module: 'Climate Sensor 1', v: 82, at: r1 }, { name: 'Room Temp', module: 'Climate Sensor 2', v: 82.8, at: r1 }] },
      { m: 'hum', name: 'Room Humidity Average', module: '', v: 66, unit: '%', at: r1, parts: [{ name: 'Room Humidity', module: 'Climate Sensor 1', v: 66, at: r1 }] },
      { m: 'co2', name: 'Room CO2', module: 'Climate Sensor 1', v: 450, unit: 'ppm', at: r1 },
      { m: 'light', name: 'Room Light Level', module: 'Climate Sensor 1', v: 52000, unit: 'lux', at: r1 },
      { m: 'vwc', name: 'Substrate Moisture 1', module: 'PIC', v: 20, unit: '%', at: r1 },
      { m: 'vwc', name: 'Substrate Moisture 2', module: 'PIC', v: 30, unit: '%', at: iso(NOW - 3 * 3600e3) },
      { m: 'pH', name: 'Tank pH', v: 6 },
    ], alerts: [{ sensor: 'Substrate Moisture 3', dir: 'below', limit: 22 }, { dir: 'above' }] };
  // the log every 5 minutes: temp over the night plan from 11:40 AM, the light on in the dark period from 11:50 AM
  const log = [];
  for (let t = NOW - 3 * 3600e3; t <= NOW - 6e4; t += 5 * 6e4) log.push({ at: iso(t), temp: t >= at('2026-11-24T19:40:00Z') ? 82 : 77, hum: 66, light: t >= at('2026-11-24T19:50:00Z') ? 50000 : 0 });
  const V = CM.glView(G, log, E, NOW, 'flower');
  assert.deepEqual(V.tiles.map(t => t.m), ['temp', 'hum', 'co2', 'light', 'vwc'], "one tile per kind of reading, in order; Growlink's other sensors are left out"); n++;
  const [tT, tH, tC, tL, tW] = V.tiles;
  assert.deepEqual([tT.v, tT.plan, tT.when, tT.set, tT.state, tT.since, tT.open, tT.n, tT.sensors.length], [82.4, 78, 'night', 70, 'high', at('2026-11-24T19:40:00Z'), false, 2, 2],
    "temp: Growlink's average, the night plan, its set point, above the plan since 11:40 AM"); n++;
  assert.deepEqual([tH.state, tH.plan, tC.state, tC.plan, tC.set], ['ok', 68, null, null, null], 'humidity on plan; CO2 not judged or set at night'); n++;
  assert.deepEqual([tL.odd, tL.since], ['lit', at('2026-11-24T19:50:00Z')], 'light in the dark period since 11:50 AM'); n++;
  assert.deepEqual([tW.v, tW.n, tW.sensors.length, tW.stale], [20, 1, 2, false], 'a probe that stopped is listed but not averaged'); n++;
  assert.deepEqual([V.stale, V.lights.on, V.hasPlan, V.alerts.length], [false, false, true, 1], 'fresh, lights off, a plan, the one named Growlink alert'); n++;
  assert.deepEqual([tT.lo, tT.hi], [77, 82], "the last day's range"); n++;
  const A = CM.glAttention(V, NOW);
  assert.deepEqual(A, ["Temp 82.4°F is above this week's night plan of 78°F since 11:40 AM", "Light reads 52,000 lux but Growlink's schedule has the lights off since 11:50 AM"],
    'Needs attention: 30 minutes or more off the plan or at odds with the schedule'); n++;
  assert.equal(CM.glAttention(CM.glView(G, log, E, at('2026-11-24T20:05:00Z'), 'flower'), at('2026-11-24T20:05:00Z')).length, 0, 'not yet at 25 minutes (and the reading counts as current)'); n++;
  const gap = log.filter(r => at(r.at) < at('2026-11-24T19:50:00Z') || at(r.at) >= at('2026-11-24T20:15:00Z'));
  assert.deepEqual([CM.glView(G, gap, E, NOW, 'flower').tiles[0].since, CM.glView(G, gap, E, NOW, 'flower').tiles[0].open], [at('2026-11-24T20:15:00Z'), true],
    'a gap in the log over 20 minutes ends the run, and its start is "at least"'); n++;
  assert.equal(CM.glView(G, log.filter(r => at(r.at) >= at('2026-11-24T19:45:00Z')), E, NOW, 'flower').tiles[0].open, true, 'a run reaching the oldest row read is "since at least"'); n++;
  assert.equal(CM.glView(G, [], E, NOW, 'flower').tiles[0].since, null, 'no log: no since'); n++;
  const old = CM.glView({ ...G, reading_at: iso(NOW - 45 * 6e4), sensors: G.sensors.map(s => ({ ...s, at: iso(NOW - 45 * 6e4), parts: s.parts && s.parts.map(x => ({ ...x, at: iso(NOW - 45 * 6e4) })) })) }, log, E, NOW, 'flower');
  assert.deepEqual([old.stale, old.tiles[0].stale, old.tiles[0].state], [true, true, null], 'readings over 20 minutes old are old and not judged'); n++;
  assert.deepEqual(CM.glAttention(old, NOW), ["Growlink hasn't sent a reading for this room since 11:45 AM"], 'readings that stopped coming'); n++;
  assert.equal(CM.glView({ ...G, lights: null }, log, E, NOW, 'flower').tiles[0].state, null, 'no light schedule: shown, not judged'); n++;
  assert.equal(CM.glView(G, log, [], NOW, 'flower').hasPlan, false); assert.equal(CM.glView(null, log, E, NOW, 'flower'), null); n += 2;
  assert.equal(CM.glClock(at('2026-11-23T19:40:00Z'), NOW), 'Mon 11/23 11:40 AM', 'another day carries its day'); n++;
  assert.deepEqual([CM.glVal('co2', 1224, 'ppm'), CM.glVal('temp', 75.14, '°F'), CM.glVal('vpd', 0.934, 'kPa'), CM.glVal('hum', 70, '%'), CM.glVal('temp', null, '°F')],
    ['1,224 ppm', '75.1°F', '0.93 kPa', '70%', '--']); n++;
  assert.equal(CM.glSpark([[0, 1], [10, 3]], 100, 22, 0, 10), 'M0.0 21.0L100.0 1.0'); assert.equal(CM.glSpark([[0, 5], [10, 5]], 100, 22, 0, 10), 'M0.0 11.0L100.0 11.0'); n += 2;
  assert.equal(CM.glSpark([[0, 1], [6e4, 2], [40 * 6e4, 3]], 100, 22, 0, 40 * 6e4).split('M').length - 1, 2, 'readings that stopped break the line'); n++;
  assert.equal(CM.glSpark([[0, 1]], 100, 22, 0, 10), ''); n++;
  // the review's cases (2026-11-24)
  const notFl = CM.glView(G, log, E, NOW, 'harvested');
  assert.deepEqual([notFl.flower, notFl.tiles[0].state, notFl.tiles[3].odd, CM.glAttention(notFl, NOW)], [false, null, null, []], 'out of flower: shown, never judged'); n++;
  const holes = log.map(r => (r.at === iso(at('2026-11-24T20:05:00Z')) ? { ...r, temp: null } : r));
  assert.equal(CM.glView(G, holes, E, NOW, 'flower').tiles[0].since, at('2026-11-24T19:40:00Z'), 'a row without the reading does not end its run'); n++;
  const none = CM.glView({ ...G, reading_at: null, sensors: G.sensors.map(s => ({ ...s, v: null, at: null, parts: s.parts && s.parts.map(x => ({ ...x, v: null, at: null })) })) }, log, E, NOW, 'flower');
  assert.deepEqual(CM.glAttention(none, NOW), ['Growlink has no recent readings for this room'], 'no readings at all is still listed'); n++;
  assert.deepEqual(CM.glAttention(old, NOW, { readErr: true, readAt: NOW - 40 * 6e4, jobAt: NOW - 50 * 6e4 }).slice(0, 1), ["This page hasn't been able to read the room's Growlink readings since 11:50 AM"],
    "the page's own failed reads are not blamed on Growlink or the job"); n++;
  assert.deepEqual(CM.glAttention(old, NOW, { jobAt: NOW - 40 * 6e4 }).slice(0, 1), ["The Growlink job on Gianni's Mac last ran 11:50 AM"], 'a job that stopped is named'); n++;
  assert.deepEqual([CM.glPlanAt(E, at('2026-11-21T07:30:00Z')).temp, CM.glPlanAt(E, at('2026-11-21T08:30:00Z')).temp], [{ day: 82, night: 82 }, { day: 80, night: 78 }],
    "a week's plan by the grows' date: 11:30 PM on 11/20 is week 1, 12:30 AM on 11/21 week 2"); n++;
  {   // across the lights coming on at 1 PM: 77°F is on the night plan (78) and below the day plan (80)
    const N2 = at('2026-11-24T21:31:00Z'), r2 = iso(N2 - 6e4);
    const G2 = { ...G, reading_at: r2, sensors: [{ m: 'temp', name: 'Room Temp', v: 77, unit: '°F', at: r2 }] };
    const log2 = [];
    for (let t = at('2026-11-24T20:30:00Z'); t <= N2 - 6e4; t += 5 * 6e4) log2.push({ at: iso(t), temp: 77 });
    const T2 = CM.glView(G2, log2, E, N2, 'flower').tiles[0];
    assert.deepEqual([T2.state, T2.when, T2.since, T2.open], ['low', 'day', at('2026-11-24T21:00:00Z'), false], 'a run starts where the lights switched'); n++;
  }
  {   // a day of log with two readings off the plan builds no date formatter per row
    const big = [];
    for (let t = NOW - 26 * 3600e3; t <= NOW - 6e4; t += 5 * 6e4) big.push({ at: iso(t), temp: 82, hum: 80, light: 0 });
    const Real = Intl.DateTimeFormat;
    let made = 0;
    Intl.DateTimeFormat = function (...a) { made++; return new Real(...a); };
    Intl.DateTimeFormat.prototype = Real.prototype;
    try { CM.glView({ ...G, sensors: G.sensors.map(s => (s.m === 'hum' ? { ...s, v: 80, parts: [] } : s)) }, big, E, NOW, 'flower'); } finally { Intl.DateTimeFormat = Real; }
    assert.ok(made <= 1, `glView reuses its date formatters (${made} built)`); n++;
  }
}
// the page reads Growlink's copy and never writes it; the job alone writes, through a token
ok(/sb\.from\('cult_growlink_now'\)\.select\('room_id,growlink,read_at,reading_at,lights,setpoints,sensors,alerts,note'\)\.eq\('room_id', roomId\)/.test(html), "the page reads only the open room's Growlink row, by name");
ok(!/rpc\('cult_growlink/.test(html) && !/api\.developer\.growlink|Gl-Api-Key/i.test(html), 'the page never writes Growlink data or calls Growlink');
ok(/glTimer = setInterval\([\s\S]{0,160}5 \* 60e3\)/.test(html), 'the readings are read again every 5 minutes');
ok(!/Live readings from Growlink are not connected yet/.test(html), 'the not-connected note is gone');
{
  const sql = readFileSync(new URL('../supabase/cult-growlink.sql', import.meta.url), 'utf8');
  for (const t of ['cult_growlink_now', 'cult_growlink_log', 'cult_growlink_meta']) {
    ok(new RegExp(`create policy ${t}_select on public\\.${t} for select to authenticated using \\(public\\.cult_can_view\\(\\)\\)`).test(sql), `${t}: any Wizard Trees login reads it`);
    ok(new RegExp(`revoke insert, update, delete on table public\\.${t} from anon, authenticated`).test(sql), `${t}: nobody writes it but the job`);
  }
  ok(/function public\.cult_growlink_save\(p_token text[\s\S]*?raise exception 'bad token'/.test(sql), 'the save checks the job token first');
  ok(!/drop table|truncate/i.test(sql), 'the Growlink SQL drops and truncates nothing');
}

console.log(`cultivation page: ${n} checks passed (TZ ${process.env.TZ})`);
