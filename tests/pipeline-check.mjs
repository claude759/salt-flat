// Checks the Production Pipeline page's sheet parsers (pipeline.html) on a made-up week laid out
// the way the DISTRO PIPELINE tab is, a made-up DISTRO SUPPLY tab, made-up Batch Label Sheet rows, and
// made-up task tracker rows for plan vs actual.
// Run: node tests/pipeline-check.mjs [real pipeline export.csv] [--supply=real supply export.csv]
//        [--batches=pipeline_batches rows as JSON] [--tasks=packaging_tasks rows as JSON] [--trims=pipeline_trims rows as JSON]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../pipeline.html', import.meta.url), 'utf8');
const src = html.split('/* ===== PIPELINE PARSER START =====')[1].split('/* ===== PIPELINE PARSER END ===== */')[0];
const PIPE = new Function(`/*${src}; return PIPE;`)();
const supSrc = html.split('/* ===== SUPPLY PARSER START =====')[1].split('/* ===== SUPPLY PARSER END ===== */')[0];
const SUP = new Function('PIPE', `/*${supSrc}; return SUP;`)(PIPE);
const weekSrc = html.split('/* ===== WEEK MODEL START =====')[1].split('/* ===== WEEK MODEL END ===== */')[0];
const WEEK = new Function('PIPE', `/*${weekSrc}; return WEEK;`)(PIPE);
const batSrc = html.split('/* ===== BATCH MODEL START =====')[1].split('/* ===== BATCH MODEL END ===== */')[0];
const BAT = new Function(`/*${batSrc}; return BAT;`)();
const actSrc = html.split('/* ===== ACTUALS MODEL START =====')[1].split('/* ===== ACTUALS MODEL END ===== */')[0];
const ACT = new Function('PIPE', `/*${actSrc}; return ACT;`)(PIPE);
const trySrc = html.split('/* ===== TRIM YIELD MODEL START =====')[1].split('/* ===== TRIM YIELD MODEL END ===== */')[0];
const TRIMY = new Function('PIPE', `/*${trySrc}; return TRIMY;`)(PIPE);
const args = process.argv.slice(2), realPipe = args.find(a => !a.startsWith('--')),
  realSup = (args.find(a => a.startsWith('--supply=')) || '').slice(9),
  realBat = (args.find(a => a.startsWith('--batches=')) || '').slice(10),
  realTasks = (args.find(a => a.startsWith('--tasks=')) || '').slice(8),
  realTrims = (args.find(a => a.startsWith('--trims=')) || '').slice(8);

// one week band: 14 columns, a (task, detail) pair per day
const blank = () => Array(14).fill('');
const rows = [['WIZARD TREES PRODUTION PIPELINE ', ...Array(13).fill('')]];
const hdr = blank();
['OCTOBER, MONDAY 12TH', 'OCTOBER, TUESDAY 13TH', 'OCTOBER, WEDNESDAY 14TH (LORENZO OOO)', 'OCTOBER, THURSDAY 15TH',
  'OCTOBER, FRIDAY 16TH', 'OCTOBER, SATURDAY 17TH', 'OCTOBER,SUNDAY 18TH'].forEach((t, k) => { hdr[k * 2] = t; });
rows.push(hdr);
const put = (r, day, task, detail) => { while (rows.length <= r) rows.push(blank()); rows[r][day * 2] = task; rows[r][day * 2 + 1] = detail; };
// Monday: trim with room + strain list (lights), crew line, a preroll run with strain rows
put(2, 0, 'TRIM - JUSTIN', 'ROOM a @ 15TH - ');
put(3, 0, '', 'ZANGBANGER\t8\t\nM8\t8\nBLACK LIGHT #6\t 1/2');
put(4, 0, 'NOURI ON CALL FOR PORTAL WORK', '');
put(5, 0, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)', '');
put(6, 0, 'BLUEBANGER', '5PK .7G -- 500');
put(7, 0, '', '1G PREROLL- 450');
put(8, 0, 'TIDE', '5PK .7G -- 700');
put(9, 0, '', '1G PREROLL- 700');
put(10, 0, 'STAGE NABIS FOR NOV DROP 1', '');
// Tuesday: jars run (two strains), staff off, testing with a drop
put(2, 1, 'LORENZO & JUSTIN  - OFF', '');
put(3, 1, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): BLACK MAGIC', '10 LBS- 3.5G (4-5 NUG MAX)');
put(4, 1, '', '10 CASES OF 1.5G BAGS (1-2  NUG MAX)');
put(5, 1, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): SMOOTHIE', '12 LBS- 3.5G (4-5 NUG MAX)');
put(6, 1, 'TESTING SCHEDULED FOR NOV DROP 1 -  BLUEBANGER, TIDEBANGER, BLACK MAGIC', '');
put(7, 1, 'NABISPICKUP - NOV DROP 1', '');
// Wednesday: harvest, supply, "drop off" is not a day off, bare strain rows under a task
put(2, 2, 'HARVEST @ 23rd- ROOM 1', '');
put(3, 2, 'PREROLL ORDER ARRIVES- ADD TO SUPPLY SHEET', '');
put(4, 2, 'STIIIZY DROP OFF @ 9AM', '');
put(5, 2, 'PUFFCON - PACKAGE & LABEL - 3.5g', '');
put(6, 2, 'RIPTIDE', '1 LB');
put(7, 2, 'RIPETIDE', '2 LBS');
// next week header so the band closes
const hdr2 = blank();
['OCTOBER, MONDAY 19TH', 'OCTOBER, TUESDAY 20TH', 'OCTOBER, WEDNESDAY 21ST', 'OCTOBER, THURSDAY 22ND',
  'OCTOBER, FRIDAY 23RD', 'OCTOBER, SATURDAY 24TH', 'OCTOBER,SUNDAY 25TH'].forEach((t, k) => { hdr2[k * 2] = t; });
rows.push(blank(), hdr2);
const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');

const weeks = PIPE.parse(csv);
assert.equal(weeks.length, 2, 'two week bands');
const [w] = weeks;
assert.equal(w.start, '2026-10-12');
assert.deepEqual(w.days.map(d => d.date), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
assert.equal(w.days[2].note, 'LORENZO OOO');

const mon = w.days[0].items, tue = w.days[1].items, wed = w.days[2].items;
const trim = mon.find(i => i.type === 'trim');
assert.equal(trim.crew, 'JUSTIN');
assert.equal(trim.room, 'A'); assert.equal(trim.site, '15TH');
assert.deepEqual(trim.strains, [{ strain: 'ZANGBANGER', n: 8 }, { strain: 'M8', n: 8 }, { strain: 'BLACK LIGHT #6', n: 0.5 }]);
assert.ok(mon.some(i => i.type === 'crew' && /ON CALL/.test(i.title)));
const pre = mon.find(i => i.type === 'prerolls');
assert.deepEqual(pre.lines.map(l => [l.strain, l.size, l.n]),
  [['BLUEBANGER', '5pk', 500], ['BLUEBANGER', '1g', 450], ['TIDE', '5pk', 700], ['TIDE', '1g', 700]]);
const stage = mon.find(i => i.type === 'orders');
assert.equal(stage.drop, 'NOV DROP 1');

assert.equal(tue[0].type, 'crew', 'LORENZO & JUSTIN - OFF is a crew line');
const jars = tue.find(i => i.type === 'jars');
assert.equal(jars.note, 'ADD VERIFICATION STICKER');
assert.deepEqual(jars.lines.map(l => [l.strain, l.lbs, l.size, l.cases, l.caseSize]),
  [['BLACK MAGIC', 10, '3.5g', 10, '1.5g'], ['SMOOTHIE', 12, '3.5g', null, '']]);
const test = tue.find(i => i.type === 'testing');
assert.equal(test.drop, 'NOV DROP 1');
assert.deepEqual(test.strains.map(s => s.strain), ['BLUEBANGER', 'TIDEBANGER', 'BLACK MAGIC']);
assert.ok(tue.some(i => i.type === 'orders' && i.drop === 'NOV DROP 1'), 'pickup names the drop');

const hv = wed.find(i => i.type === 'harvest');
assert.equal(hv.room, '1'); assert.equal(hv.site, '23RD');
assert.ok(wed.some(i => i.type === 'supply'));
assert.equal(wed.find(i => /STIIIZY/.test(i.title)).type, 'orders', 'a drop off is not a day off');
const puff = wed.find(i => /PUFFCON/.test(i.title));
assert.deepEqual(puff.sub, [{ strain: 'RIPTIDE', text: '1 LB' }, { strain: 'RIPTIDE', text: '2 LBS' }], 'strain rows fold into the task, typo alias applies');

// helpers
assert.deepEqual(PIPE.prerollQtys('5PK- 128 UNITS\n1G- 1362 UNITS'), [{ size: '5pk', n: 128, note: '' }, { size: '1g', n: 1362, note: '' }]);
assert.equal(PIPE.dropName('STAGE NABIS PICK UP FOR NOV PREROLL DROP'), 'NOV PREROLL DROP');
assert.equal(PIPE.strainKey('Zanganger'), 'ZANGBANGER');

// year rollover: December -> January
const roll = PIPE.parse('"DECEMBER, MONDAY 28TH",,TUESDAY 29TH,,WEDNESDAY 30TH,,THURSDAY 31ST,,JANUARY FRIDAY 1ST,,SATURDAY 2ND,,SUNDAY 3RD,\n' +
  '"JANUARY, MONDAY 4TH",,TUESDAY 5TH,,WEDNESDAY 6TH,,THURSDAY 7TH,,FRIDAY 8TH,,SATURDAY 9TH,,SUNDAY 10TH,');
assert.deepEqual(roll.map(x => x.start), ['2026-12-28', '2027-01-04']);

// supplies: header row found by name, site columns between PAR and Vendor, empty formula rows skipped
const supCsv = [
  'Column 1,ITEM,TOTAL QTY,STATUS,PAR ,23RD,25TH,PORTAL,VOID,Vendor ,NOTES',
  'Jar - 3.5g,JAR,53400,IN STOCK,"20,000",50352,3048,,,ZACK  - CHINA,50K JAR ORDER COMING',
  'Black Light - 3.5g - Label,LABEL,1200,IN STOCK,"5,000",,"1,200",,,CGA ,',
  'Zoza - 1.5g - Preroll Jar,PRE-LABELED JAR,2000,NOT REORDERING,3500,1600,400,,,ZACK  - CHINA,NO RE ORDER',
  'Preroll Papers - 1g,PREROLL,0,OOS,5000,0,0,,,ZACK  - CHINA,',
  'Lid - 1g,LIDS,40,Running Low,0,,40,,,,',
  'Smoothie - Bundle (10ct Box),BUNDLE,0,IN STOCK,,,,,6(1.5 LBS),,2 1/2 lbs per 10ct ',
  ',,0,,,,,,,,',
  ',,0,,,,,,,,',
].join('\n');
const sp = SUP.parse(supCsv, 'DISTRO SUPPLY');
assert.deepEqual(sp.sites, ['23RD', '25TH', 'PORTAL', 'VOID']);
assert.equal(sp.items.length, 6, 'empty formula rows are skipped');
const [jar, bl, zoza, papers, lid, bundle] = sp.items;
assert.deepEqual([jar.total, jar.par, jar.status, jar.at, jar.below, jar.row], [53400, 20000, 'IN STOCK', { '23RD': 50352, '25TH': 3048 }, false, 2]);
assert.equal(jar.vendor, 'ZACK - CHINA');
assert.deepEqual([bl.at['25TH'], bl.below], [1200, true], 'comma numbers parse; total under par is flagged');
assert.equal(zoza.below, false, 'an item no longer reordered is not flagged below par');
assert.deepEqual([papers.status, papers.below, papers.total], ['OOS', true, 0]);
assert.deepEqual([lid.cat, lid.status, lid.below], ['LID', 'RUNNING LOW', false], 'category alias; status normalised; PAR 0 = no par');
assert.deepEqual([bundle.at.VOID, bundle.raw.VOID, bundle.total, bundle.sum], [6, '6(1.5 LBS)', 0, 0], 'a text cell keeps its words');
const acc = SUP.parse('Column 1,ITEM,TOTAL QTY,STATUS,PAR ,23RD,25TH,PORTAL,MYLARS,Vendor ,NOTES\nWizzy Lego,ACCESSORY,1560,IN STOCK,,,,1560,,,', 'ACCESSORY SUPPLY');
assert.deepEqual([acc.sites[3], acc.items[0].par, acc.items[0].below], ['MYLARS', null, false]);
assert.equal(SUP.parse('nothing,here\n1,2', 'X'), null, 'a tab without the header row is refused');

// ---------------- Week board model ----------------
// parser fixes: "5PK .7G PREROLL- 700", and "PREROLLS- ...: SMOOTHIE" naming the strain its lines are for
assert.deepEqual(PIPE.prerollQtys('5PK .7G PREROLL- 700'), [{ size: '5pk', n: 700, note: '' }]);
{
  const [it] = PIPE.structure([{ title: 'PREROLLS- GRIND, PRODUCE, PACKAGE (ADD VERIFICATION STICKER): SMOOTHIE', details: ['1G PREROLL- 500', '5PK .7G PREROLL- 700'] }]);
  assert.deepEqual(it.lines.map(l => [l.strain, l.size, l.n]), [['SMOOTHIE', '1g', 500], ['SMOOTHIE', '5pk', 700]]);
  const [j] = PIPE.structure([{ title: 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): TIDE', details: ['10 LBS- 3.5G (4-5 NUG MAX)'] }]);
  assert.equal(j.lines[0].lbsNote, '4-5 NUG MAX', 'jar notes are kept');
}

// crew lines -> one status per person
const crew = t => { const r = WEEK.parseCrew(t); return [Object.entries(r.people).map(([n, v]) => `${n} ${v.st}${v.note ? ' (' + v.note + ')' : ''}`).sort().join(', '), r.flag, r.unparsed]; };
assert.deepEqual(crew('LORENZO @ DISTRO'), ['LORENZO DISTRO', '', false]);
assert.deepEqual(crew('NOURI ON CALL FOR PORTAL WORK'), ['NOURI ON CALL (PORTAL WORK)', '', false]);
assert.deepEqual(crew('JUSTIN OFF / LORENZO OFF // DREA DISTRO LEAD'), ['DREA LEAD, JUSTIN OFF, LORENZO OFF', '', false]);
assert.deepEqual(crew('LORENZO OFF // JUSTIN DISTRO LEAD'), ['JUSTIN LEAD, LORENZO OFF', '', false]);
assert.deepEqual(crew('DISTRO OFF'), ['', 'DISTRO OFF', false]);
assert.deepEqual(crew('JUSTIN / DISTRO OFF'), ['JUSTIN OFF', 'DISTRO OFF', false]);
assert.deepEqual(crew('LORENZO / JUSTIN DISTRO'), ['JUSTIN DISTRO, LORENZO DISTRO', '', false]);
assert.deepEqual(crew('JUSTIN/NOURI/LORENZO OFF'), ['JUSTIN OFF, LORENZO OFF, NOURI OFF', '', false]);
assert.deepEqual(crew('LOREZNO & JUSTIN DISTRO'), ['JUSTIN DISTRO, LORENZO DISTRO', '', false]);
assert.deepEqual(crew('NO DISTRO WORK'), ['', 'NO DISTRO WORK', false]);
assert.deepEqual(crew('JUSTIN @ TRIM / LORENZO @ DISTRO'), ['JUSTIN TRIM, LORENZO DISTRO', '', false]);
assert.deepEqual(crew('LORENZO @ DISTRO w/ DREA, JORGE, THANH?'), ['DREA DISTRO, JORGE DISTRO, LORENZO DISTRO, THANH DISTRO', '', false]);
assert.deepEqual(crew('CARLOS OOO'), ['CARLOS OOO', '', false]);
assert.equal(WEEK.parseCrew('VIC - NY').unparsed, true, 'unknown wording is shown as written');
assert.deepEqual(crew('NO DISTRO WORK - JUSTIN / NOURI OFF'), ['JUSTIN OFF, NOURI OFF', 'NO DISTRO WORK', false], 'names after the team phrase take the next status');
assert.deepEqual(crew('NOURI OFF - CC & JUSTIN ON SCHEDULE'), ['NOURI OFF', '', true], 'a name is not a note; the line is shown as written');
assert.deepEqual(crew('THANKSGIVING - DISTRO OFF'), ['', 'DISTRO OFF', true], 'a holiday is not a person');
assert.equal(WEEK.parseCrew('CC ON CALL FOR PORTAL/DISTRO WORK IF NEED').unparsed, true, 'a status for nobody keeps the line visible');
// light counts stand apart from names; a number after a cross "x" is a pheno
assert.deepEqual(PIPE.parseStrainLines('(phenos) ZOZA x 2424\n2424 - 7 lights\nM8\n2424 x 2424 #2,9,26').map(l => l.n), [null, 7, null, null]);
// headlines lose dangling punctuation
assert.notEqual(WEEK.headline(PIPE.structure([{ title: 'NOURI & JUSTIN PRINT 3.5G  LABELS FOR PREROLLS, 3.5G & 1.5G BUDTENDER SAMPS', details: [] }])[0]).head.slice(-1), ',');
// testing keeps the sheet's words the parser could not place
{
  const it = PIPE.structure([{ title: 'TESTING SCHEDULED FOR 7 STRAINS :DARK MATTER, ZANGBANGER, LIMELIGHT, JUNGLE JUICE (TOAD VENOM) -- RUSH TESTING', details: [] }])[0];
  const M1 = WEEK.buildModel([{ start: '2026-03-23', days: [0, 1, 2, 3, 4, 5, 6].map(k => ({ date: PIPE.addDays('2026-03-23', k), dow: k, note: '', items: k ? [] : [it] })) }]);
  const card = WEEK.dayBoard(M1, '2026-03-23', { drops: new Map() }).cards[0];
  assert.ok(JSON.stringify(card).includes('RUSH TESTING'), 'RUSH TESTING is not dropped');
}
{
  const d = WEEK.crewDay({ note: 'LORENZO OOO', items: [{ type: 'crew', title: 'JUSTIN/NOURI/LORENZO OFF' }] });
  assert.deepEqual([d.people.LORENZO.st, d.people.JUSTIN.st, d.people.NOURI.st, d.flag], ['OOO', 'OFF', 'OFF', 'DISTRO OFF'], 'OOO beats OFF; all core crew off = distro off');
}

// headlines: the short bold line a bar leads with
const hl = (title, drop) => WEEK.headline(Object.assign(PIPE.structure([{ title, details: [] }])[0], drop ? { drop } : {}));
assert.deepEqual([hl('PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)').head, hl('PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)').detail],
  ['GRIND, PRODUCE, PACKAGE', ['ADD BATCH LABEL', 'ADD VERIFICATION STICKER']]);
assert.equal(hl('FINISH 5PK PREROLLS').head, 'FINISH 5-PACK PRE-ROLLS');
{
  const t = hl('TBD TESTING SCHEDULED FOR NOV DROP 2 -  ZANGBANGER, VOODOO, TEA PARTY (2 FACILITIES, 2 CHAIN OF CUSTODIES)');
  assert.deepEqual([t.head, t.tbd], ['TESTING SCHEDULED · NOV DROP 2', true]);
}
assert.deepEqual([hl('FINISH PREROLLS FOR TESTING !!!').head, hl('FINISH PREROLLS FOR TESTING !!!').urgent], ['FINISH PRE-ROLLS FOR TESTING', true]);
assert.equal(hl('NABISPICKUP - NOV DROP 1').head, 'NABIS PICKUP · NOV DROP 1');
assert.equal(hl('STAGE NABIS FOR NOV DROP 1').head, 'STAGE NABIS · NOV DROP 1');
assert.equal(hl('DCR - INSPECTION @ 25TH').head, 'DCR - INSPECTION @ 25TH', 'a one-word left part is not cut');
assert.equal(hl('#36 THE VOID - FINISH STICKERING GAS GIMLET').head, '#36 THE VOID');

// a made-up week shaped like the sheet's Oct 12 band: repeats on several days must become one bar each
{
  const rows2 = [blank()], hdrW = blank();
  ['OCTOBER, MONDAY 12TH', 'OCTOBER, TUESDAY 13TH', 'OCTOBER, WEDNESDAY 14TH', 'OCTOBER, THURSDAY 15TH', 'OCTOBER, FRIDAY 16TH',
    'OCTOBER, SATURDAY 17TH', 'OCTOBER,SUNDAY 18TH'].forEach((t, k) => { hdrW[k * 2] = t; });
  rows2.push(hdrW);
  const at = (r, day, task, detail) => { while (rows2.length <= r) rows2.push(blank()); rows2[r][day * 2] = task; rows2[r][day * 2 + 1] = detail; };
  const room2 = 'RIPTIDE 5.5\nKINGTIDE 1.5\nTIDEBANGER 3.5';
  at(2, 0, 'TRIM - JUSTIN', 'ROOM a @ 15TH - '); at(3, 0, '', 'ZANGBANGER 8\nM8 8');
  at(4, 0, 'NOURI ON CALL FOR PORTAL WORK', '');
  at(5, 0, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)', '');
  at(6, 0, 'BLUEBANGER', '5PK .7G -- 500'); at(7, 0, '', '1G PREROLL- 450');
  at(8, 0, 'TIDE', '5PK .7G -- 700'); at(9, 0, '', '1G PREROLL- 700');
  at(10, 0, 'PICK SELF DISTRO ORDERS', '');
  at(2, 1, 'JUSTIN OFF / LORENZO OFF // DREA DISTRO LEAD', '');
  at(3, 1, 'TIDE', '5PK .7G -- 700'); at(4, 1, '', '1G PREROLL- 700');
  at(5, 1, 'WIZZY', '5PK .7G -- 600');
  at(6, 1, 'PICK SELF DISTRO ORDERS', '');
  at(2, 2, 'BLUEBANGER', '5PK .7G -- 500'); at(3, 2, '', '1G PREROLL- 450');
  at(4, 2, 'TIDE', '5PK .7G -- 700'); at(5, 2, '', '1G PREROLL- 700');
  at(6, 2, 'NABIS PICKUP', '');
  at(2, 3, 'TRIM - JUSTIN', 'ROOM 2 @ 25TH - '); at(3, 3, '', room2);
  at(4, 3, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)', '');
  at(2, 4, 'TRIM - JUSTIN', 'ROOM 2 @ 25TH - '); at(3, 4, '', room2);
  at(4, 4, 'FINISH 5PK PREROLLS', '');
  at(5, 4, 'BLUEBANGER', '5PK .7G -- 500'); at(6, 4, '', '1G PREROLL- 450');
  at(7, 4, 'TBD TESTING SCHEDULED FOR NOV DROP 2 -  ZANGBANGER, VOODOO', '');
  at(2, 5, 'DISTRO OFF', ''); at(3, 5, 'TRIM - JUSTIN', 'ROOM 2 @ 25TH - '); at(4, 5, '', room2);
  at(2, 6, 'JUSTIN / DISTRO OFF', '');
  const toCsv = rs => rs.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');
  const wks = PIPE.parse(toCsv(rows2));
  const M = WEEK.buildModel(wks);
  const B = WEEK.buildBoard(M, '2026-10-12', { today: '2026-10-15', summary: WEEK.summarize(wks[0]), drops: new Map() });
  const lane = id => B.lanes.find(l => l.id === id);
  const span = b => b.a === b.b ? WEEK.DOWS[b.a] : `${WEEK.DOWS[b.a]}-${WEEK.DOWS[b.b]}`;
  const rowSpans = (id, key) => lane(id).rows.find(r => r.key === key).tracks.flat().map(span).join(' ');
  assert.equal(rowSpans('trim', '15TH|A'), 'MON');
  assert.equal(rowSpans('trim', '25TH|2'), 'THU-SAT', 'a room trimmed three days running is one bar');
  assert.equal(lane('trim').total, '2 rooms · 26.5 lights');
  assert.deepEqual(lane('prerolls').headTracks.flat().map(b => `${span(b)} ${b.head}`), ['MON-THU GRIND, PRODUCE, PACKAGE', 'FRI FINISH 5-PACK PRE-ROLLS'],
    'strain-only days take the instruction from Monday');
  assert.equal(rowSpans('prerolls', 'TIDE'), 'MON-WED');
  assert.equal(rowSpans('prerolls', 'BLUEBANGER'), 'MON WED FRI', 'a gap shows as separate blocks');
  assert.equal(rowSpans('prerolls', 'WIZZY'), 'TUE');
  const nl = id => lane('prerolls').rows.find(r => r.key === id).notListed;
  assert.deepEqual([nl('BLUEBANGER'), nl('TIDE'), nl('WIZZY')], [[3], [3], []], 'Thursday lists no strains: hatch only the strains listed next to it');
  assert.equal(lane('prerolls').total, '3 strains listed · 1,800 5-packs · 1,150 1g');
  assert.deepEqual(lane('orders').headTracks.flat().map(b => `${span(b)} ${b.head}`), ['MON-TUE PICK SELF DISTRO ORDERS', 'WED NABIS PICKUP']);
  const t = lane('testing').headTracks.flat()[0];
  assert.deepEqual([span(t), t.head, t.tbd], ['FRI', 'TESTING SCHEDULED · NOV DROP 2', true]);
  const justin = lane('crew').rows.find(r => r.key === 'JUSTIN').tracks.map(tr => tr.map(b => `${span(b)} ${b.head}`).join(' | '));
  assert.deepEqual(justin, ['TUE OFF | SUN OFF', 'MON TRIM ROOM A @ 15TH | THU-SAT TRIM ROOM 2 @ 25TH']);
  assert.deepEqual(B.days.map(d => d.flag), ['', '', '', '', '', 'DISTRO OFF', 'DISTRO OFF']);
  assert.deepEqual(B.days.map(d => d.tasks), [3, 2, 2, 2, 3, 1, 0], 'strain rows fold into one pre-roll task per day');
  // the day view
  const tue = WEEK.dayBoard(M, '2026-10-13', { drops: new Map() }).cards.find(c => c.lane === 'prerolls');
  assert.deepEqual(tue.changes.map(c => `${c.kind} ${c.strain}`), ['add WIZZY', 'gone BLUEBANGER']);
  assert.equal(tue.inheritedFrom, '2026-10-12');
  assert.deepEqual(tue.table.total, { '5pk': 1300, '1g': 700 });
  const thu = WEEK.dayBoard(M, '2026-10-15', { drops: new Map() });
  const thuPre = thu.cards.find(c => c.lane === 'prerolls');
  assert.deepEqual([thuPre.n, thuPre.m, thuPre.borrowedFrom], [4, 5, '2026-10-14'], 'no list on Thursday: show Wednesday\'s, labelled');
  const thuTrim = thu.cards.find(c => c.lane === 'trim');
  assert.deepEqual([thuTrim.n, thuTrim.m, thuTrim.range], [1, 3, 'THU – SAT']);
}

// the Batches view: batch codes, statuses, item names and grouping, as the Batch Label Sheet writes them
{
  const dc = c => { const d = BAT.decode(c); return [d.room, d.site, d.harvest].join(' '); };
  assert.equal(dc('F2-BM-9126-S'), 'F2 23RD 2026-09-01');
  assert.equal(dc('FA-Z-10226-I'), 'FA 15TH ', '10226 reads as 10/2 or 1/02: no harvest guessed');
  assert.equal(dc('F1-BB-92226-S'), 'F1 23RD 2026-09-22');
  assert.equal(dc('V-92226-S-5PK'), ' 23RD 2026-09-22', 'a code that starts with the strain has no room');
  assert.equal(dc('B- LL-31726-I'), 'B 15TH 2026-03-17');
  assert.equal(dc('A-A-8426-I'), 'A 15TH 2026-08-04', 'room A, strain A (Antidote)');
  assert.equal(dc('F1-82426-A-F'), 'F1 25TH 2026-08-24', 'strain after the date; the last site letter wins');
  assert.equal(dc('F1-BL-42026.7-F'), 'F1 25TH 2026-04-20');
  assert.equal(dc('F2-BM-92826-O'), 'F2 OLYMPIC 2026-09-28');
  assert.equal(dc('F3-ZB-10232025'), 'F3  2025-10-23', 'old MMDDYYYY codes carry no site');
  assert.equal(dc('F1-121725ZB'), 'F1  ', 'digits run into letters: nothing read');
  assert.equal(dc(''), '  ');
  assert.equal(BAT.codeDate('242026'), null, 'a typo date is not guessed');

  assert.deepEqual(['PACKAGING', 'Awaiting pkg / labeling', 'waiting on coa', 'WAITING FOR TESTING ', 'Failed testing', 'DONE', 'QA HOLD', '']
    .map(BAT.statusKey), ['PACKAGING', 'AWAITING PKG/LABELING', 'WAITING FOR COA', 'WAITING FOR TESTING', 'FAILED TESTING', 'DONE', 'QA HOLD', '']);
  assert.equal(BAT.info('QA HOLD').label, 'Qa hold');
  assert.deepEqual(['FLOWER', '5PK', '1G', '1.0G PREROLL', '1.5g prerolls', '.7g prerolls', 'Infused cone'].map(BAT.itemLabel),
    ['Flower', '5-pack', '1g pre-roll', '1g pre-roll', '1.5g pre-rolls', '0.7g pre-rolls', 'Infused cone']);

  const row = (sheet_row, status, extra = {}) => ({ sheet_row, status, finished: false, strain: 'TIDE', ...extra });
  const g = BAT.groups([
    row(3, 'WAITING FOR TESTING'), row(4, 'WAITING FOR TESTING'), row(14, 'AWAITING PKG/LABELING'), row(24, 'NOT STARTED'),
    row(30, 'PACKAGING'), row(31, 'PACKAGING'), row(23, 'LABELING BATCH INFO'), row(33, 'DONE'), row(35, 'QA HOLD'),
    row(234, 'DONE', { finished: true, package_date: '2026-10-02' }), row(238, 'DONE', { finished: true, package_date: '2026-10-02' }),
    row(220, 'FAILED TESTING', { finished: true, nabis_date: '2026-09-28' }), row(150, 'DONE', { finished: true, coa_date: '2026-10-05' }),
  ]);
  assert.deepEqual(g.map(x => `${x.label} ${x.rows.map(r => r.sheet_row).join(',')}`), [
    'Packaging 30,31', 'Labeling batch info 23', 'Awaiting packaging & labeling 14', 'Qa hold 35',
    'Waiting for testing 3,4', 'Not started 24', 'Finished 33,150,238,234,220'],
    'work in progress first, sheet order inside a group; DONE above the divider leads Finished; then newest first');
  assert.equal(BAT.lastDate({ harvest_date: '2026-08-03', package_date: '2026-09-15', nabis_date: '2026-09-30' }), '2026-09-30');
}

// plan vs actual: tracker task names and units, runs from the sheet, the batch sheet matched to runs
{
  const k = t => { const x = ACT.taskKind(t); return [x.prod, x.step, x.market].join(' '); };
  assert.equal(k('5pk (.7g) pre-roll produced(rec)'), '5pk made rec');
  assert.equal(k('5pk (.7g) pre-roll labeled (post COA)(rec)'), '5pk label2 rec');
  assert.equal(k('1g pre-roll labeled (pre COA)(rec)'), '1g label1 rec');
  assert.equal(k('1.5g pre-roll produced (rec)'), '1.5g made rec');
  assert.equal(k('1.5g budtender samples (packaged)(rec)'), 'bud made rec');
  assert.equal(k('3.5g jar packed (rec)'), 'jar made rec');
  assert.equal(k('3.5g jar labeled (void)'), 'jar label void');
  assert.equal(k('3.5g pouch prepped (void)'), 'pouch prep void');
  assert.equal(k('General packaging activities'), '  rec');
  assert.equal(ACT.taskKind('Lunch').rest, true);
  assert.equal(ACT.taskKind('Breaking down 18 Pallets').rest, false, 'breaking down pallets is work, not a break');
  assert.equal(ACT.units({ packaged: 800, labeled: 0 }, 'label'), 800, 'a count typed in the other column still counts');
  assert.equal(ACT.units({ packaged: 128, labeled: 128 }, 'made'), 128);
  const days = ACT.byDay([
    { work_date: '2026-10-14', task: '5pk (.7g) pre-roll produced(rec)', people: 8, hours: 8.15, packaged: 3400, labeled: 0, begin_at: '08:00:00' },
    { work_date: '2026-10-14', task: '5pk (.7g) pre-roll produced(rec)', people: 2, hours: 1, packaged: 3, labeled: 0, begin_at: '16:10:00' },
    { work_date: '2026-10-14', task: 'Lunch', people: 8, hours: 0.5, packaged: 0, labeled: 0, begin_at: '12:00:00' }]);
  const d = days.get('2026-10-14'), p = d.prods['5pk'];
  assert.deepEqual([p.sticks, p.made, Math.round(p.madePh * 10) / 10], [3403, 680.6, 67.2], '5-pack sticks are added first, then divided by 5');
  assert.equal(Math.round(d.ph * 10) / 10, 67.2, 'a lunch row stays out of the day\'s person-hours');

  assert.deepEqual(['PREROLLS FOR CARLOS- GRIND', 'FINISH PREROLLS FOR CARLOS / REC', 'MAKE PREROLLS FOR EVENT  - CUSTOM LABELS',
    'MAKE 200 TIDEBANGER PREOLLS FOR TORCHES PARTY', 'MAKE PREROLLS FOR CA- 1G PREROLLS', 'FINISH PREROLLS FOR REC',
    'PREROLLS- START GRINDING FOR PREROLLS', 'PREROLLS- GRIND, PRODUCE, PACKAGE', 'TESTING SCHEDULED FOR NOV DROP 1'].map(ACT.jobOf),
    ['CARLOS', 'CARLOS', 'EVENT', 'TORCHES PARTY', '', '', '', '', '']);

  // runs: a weekend gap joins when the list carries on; a new jar list a weekend later is its own run; side jobs stay out
  const it = (type, title, lines) => ({ type, title, lines });
  const pr = (strain, n5, n1) => [{ strain, size: '5pk', n: n5 }, { strain, size: '1g', n: n1 }];
  const wk = (start, byDate) => ({ start, days: Object.entries(byDate).map(([date, items]) => ({ date, items })) });
  const weeks = [
    wk('2026-10-05', {
      '2026-10-07': [it('prerolls', 'PREROLLS- GRIND', [...pr('TIDE', 700, 700), ...pr('VOODOO', 500, 400)])],
      '2026-10-08': [it('prerolls', 'PREROLLS- GRIND', [...pr('TIDE', 700, 700), ...pr('VOODOO', 500, 400)])],
      '2026-10-10': [it('prerolls', 'PREROLLS- GRIND', pr('TIDE', 700, 650)), it('prerolls', 'PREROLLS FOR CARLOS', pr('M8', 128, 454))] }),
    wk('2026-10-12', {
      '2026-10-12': [it('prerolls', 'PREROLLS- GRIND', pr('TIDE', 700, 650))],
      '2026-10-13': [it('prerolls', 'Pre-rolls', [{ strain: 'WIZZY', size: '5pk', n: 600 }])],
      '2026-10-15': [it('prerolls', 'PREROLLS- GRIND', [])],
      '2026-10-19': [it('jars', 'Package to jars', [{ strain: 'SMOOTHIE', lbs: 10, cases: 10 }])],
      '2026-10-20': [it('jars', 'Package to jars', [{ strain: 'SMOOTHIE', lbs: 10, cases: 10 }])] }),
    wk('2026-10-26', { '2026-10-26': [it('jars', 'Package to jars', [{ strain: 'NEBULA', lbs: 8, cases: 5 }])] }),
  ];
  const runs = ACT.runs(weeks, 'prerolls');
  assert.equal(runs.length, 1, 'Oct 7-15 is one pre-roll run across the weekend and the empty-list day');
  const r = runs[0];
  assert.deepEqual([r.start, r.end, r.days.length], ['2026-10-07', '2026-10-15', 6]);
  assert.deepEqual([...r.plan.keys()], ['TIDE|5pk', 'TIDE|1g', 'VOODOO|5pk', 'VOODOO|1g', 'WIZZY|5pk'], 'the plan is every strain and size listed, never a sum over days');
  assert.deepEqual([r.plan.get('TIDE|1g').n, r.plan.get('TIDE|1g').firstN], [650, 700], 'a changed amount keeps the latest and remembers the first');
  assert.deepEqual(r.side.map(x => `${x.job} ${x.strain} ${x.size}`), ['CARLOS M8 5pk', 'CARLOS M8 1g'], 'a job for Carlos is kept out of the plan');
  assert.deepEqual(ACT.runs(weeks, 'jars').map(x => `${x.start}..${x.end}`), ['2026-10-19..2026-10-20', '2026-10-26..2026-10-26'], 'new jar strains a weekend later start a new run');

  // the batch sheet: counted rows by strain and size; packaging or not started is not counted
  const bat = [
    { strain: 'Tide', item: '5PK', package_date: '2026-10-14', total_units: 700, status: 'LABELING BATCH INFO' },
    { strain: 'TIDE', item: '1G', package_date: '2026-10-14', total_units: null, status: 'NOT STARTED' },
    { strain: 'VOODOO', item: '5PK', package_date: '2026-10-14', total_units: 500, status: 'WAITING FOR TESTING' },
    { strain: 'VOODOO', item: '1G', package_date: '2026-10-14', total_units: 120, status: 'PACKAGING' },
    { strain: 'BLACK LIGHT', item: '5PK', package_date: '2026-10-14', total_units: 300, status: 'DONE' },
    { strain: 'SMOOTHIE', item: 'FLOWER', package_date: '2026-10-21', total_units: 1139, budtender_units: 150, status: 'DONE' },
  ];
  const tasks = [
    { work_date: '2026-10-07', task: '5pk (.7g) pre-roll produced(rec)', people: 6, hours: 5.25, packaged: 2500, labeled: 0 },
    { work_date: '2026-10-08', task: '1g pre-roll produced (rec)', people: 6, hours: 4, packaged: 700, labeled: 0 },
    { work_date: '2026-10-17', task: '5pk (.7g) pre-roll produced(rec)', people: 6, hours: 1, packaged: 100, labeled: 0 },
    { work_date: '2026-10-04', task: '1g pre-roll produced (rec)', people: 6, hours: 1, packaged: 50, labeled: 0 },
    { work_date: '2026-10-21', task: '5pk (.7g) pre-roll produced(rec)', people: 6, hours: 1, packaged: 999, labeled: 0 },
    { work_date: '2026-10-21', task: 'General packaging activities', people: 6, hours: 1, packaged: 0, labeled: 0 },
    { work_date: '2026-10-07', task: 'General packaging activities', people: 4, hours: 1, packaged: 0, labeled: 0 },
    { work_date: '2026-10-28', task: '5pk (.7g) pre-roll labeled (post COA)(rec)', people: 5, hours: 3, packaged: 0, labeled: 1200 },
  ];
  const A = ACT.build(weeks, tasks, bat, '2026-10-16', BAT.statusKey);
  const R = A.byId.get('prerolls-2026-10-07'), line = key => R.act.lines.find(l => l.strain + '|' + l.size === key);
  assert.deepEqual([line('TIDE|5pk').counted, line('TIDE|1g').counted, line('VOODOO|5pk').counted, line('VOODOO|1g').counted], [700, null, 500, null],
    'counted = units on the batch sheet past packaging');
  assert.deepEqual(R.act.extra.map(x => x.strain), ['BLACK LIGHT'], 'a counted batch the plan never listed is shown apart');
  const five = R.prods.find(x => x.prod === '5pk'), one = R.prods.find(x => x.prod === '1g');
  assert.deepEqual([five.plan, five.made, five.counted, five.label2], [1800, 520, 1200, 1200],
    'made counts to 5 days after the run (Oct 17 in, Oct 21 out); after-COA labels count up to 3 weeks on');
  assert.deepEqual([one.plan, one.made, one.counted], [1050, 750, null], 'and from 3 days before it (Oct 4)');
  assert.equal(R.act.otherPh, 4, 'general hours on a pre-roll day go to the pre-roll run; Oct 21 is outside every window');
  assert.deepEqual(R.act.missing, ['2026-10-10', '2026-10-12', '2026-10-13', '2026-10-15'], 'planned past days with nothing logged');
  assert.equal(R.act.closed, false);
  const J = A.byId.get('jars-2026-10-19');
  assert.deepEqual(J.prods.map(x => `${x.prod} ${x.plan} ${x.counted}`), ['jar 10 1139', 'bud 10 150'], 'jars plan in lb, samples in cases; counts in jars and bags');
  assert.equal(ACT.runForWeek(A, 'prerolls', '2026-10-12').id, 'prerolls-2026-10-07');
  // labels go to the run that made the product, even when the next run has started; a blank sample count stays blank
  const B2 = ACT.build(weeks, [
    { work_date: '2026-10-19', task: '3.5g jar packed (rec)', people: 5, hours: 4, packaged: 1000, labeled: 0 },
    { work_date: '2026-10-26', task: '3.5g jar labeled (rec)', people: 8, hours: 5, packaged: 0, labeled: 900 },
  ], [{ strain: 'NEBULA', item: 'FLOWER', package_date: '2026-10-27', total_units: 700, budtender_units: null, status: 'DONE' }], '2026-11-02', BAT.statusKey);
  const j1 = B2.byId.get('jars-2026-10-19').prods.find(x => x.prod === 'jar'), j2 = B2.byId.get('jars-2026-10-26');
  assert.deepEqual([j1.made, j1.label, j1.labelPh], [1000, 900, 40], 'Oct 26 labels belong to the Oct 19 run that packed the jars');
  assert.equal(j2.prods.find(x => x.prod === 'jar').label, 0);
  assert.equal(j2.act.lines[0].buds, null, 'a blank budtender count is not a zero');
  assert.equal(ACT.runOn(A, 'prerolls', '2026-10-11').id, 'prerolls-2026-10-07', 'a weekend inside a run belongs to it');
}

// trim estimates: past trims from the trim sheets -> pounds per light; a trim to come = room lights x the site's last 3
{
  const LB = TRIMY.LB;
  const line = (file, tab, start, end, room, lights, strain, bigs, littles, trim, l, block = 0) =>
    ({ file, tab, block, line: l, site: file.startsWith('SLANE') ? '23RD' : '25TH', room, start_date: start, end_date: end, lights, strain, bigs_g: bigs, littles_g: littles, trim_g: trim });
  const lbs = n => n * LB;   // grams for n pounds
  const rows = [
    line('SLANE 2026.xlsx', 'Aug 4-5', '2026-08-04', '2026-08-05', '1', 48, 'Tide', lbs(100), lbs(20), lbs(40), 0),       // 2.50 / light
    line('SLANE 2026.xlsx', 'Aug 19-21', '2026-08-19', '2026-08-21', '3', 45, 'Zang Banger', lbs(110), lbs(25), lbs(45), 0), // 3.00
    line('SLANE 2026.xlsx', 'Sep 11-13', '2026-09-11', '2026-09-13', '2', 54, 'Wizzy', lbs(120), lbs(15), lbs(54), 0),     // 2.50
    line('SLANE 2026.xlsx', 'Oct 2-4', '2026-10-02', '2026-10-04', '1', 48, 'Antidote', lbs(80), lbs(16), lbs(30), 0),     // 2.00
    // a one-strain early harvest, then the room's full trim that repeats it: the early tab is dropped
    line('FILIFERA 2026.xlsx', 'Oct. 6(RM2 early harvest)', '2026-10-06', '2026-10-06', '2', 21, 'Rip Tide', 5000, 900, 0, 0),
    line('FILIFERA 2026.xlsx', 'Oct. 15', '2026-10-15', '2026-10-15', '2', 21, 'Bluebanger', lbs(40), lbs(8), lbs(15), 0),
    line('FILIFERA 2026.xlsx', 'Oct. 15', '2026-10-15', '2026-10-15', '2', 21, 'Rip Tide', 5000, 900, 0, 1),
    // a partial first tab whose strain shows as zero on the later one: folded in
    line('FILIFERA 2026.xlsx', 'April 16-(1 strain)', '2026-04-16', '2026-04-16', '1', 37, 'Zoza x Tide #17', lbs(9), lbs(0.4), 0, 0),
    line('FILIFERA 2026.xlsx', 'April 16 Cont.-(April 30-May 1)', '2026-04-30', '2026-05-01', '1', 37, 'Zoza x Tide #17', 0, 0, 0, 0),
    line('FILIFERA 2026.xlsx', 'April 16 Cont.-(April 30-May 1)', '2026-04-30', '2026-05-01', '1', 37, 'Tidebanger', lbs(90), lbs(10), lbs(30), 1),
  ];
  const ev = TRIMY.events(rows);
  assert.deepEqual(ev.map(e => e.tab), ['April 16 Cont.-(April 30-May 1)', 'Aug 4-5', 'Aug 19-21', 'Sep 11-13', 'Oct 2-4', 'Oct. 15'],
    'the repeated early-harvest tab is dropped and the partial April tab is folded into the next one');
  const apr = ev[0];
  assert.equal(Math.round(apr.lb * 10) / 10, 109.4, 'the folded strain counts once, in the room\'s full trim');
  const r = TRIMY.rate(ev, '23RD', '2026-10-17');
  assert.deepEqual([r.from.map(e => e.tab), Math.round(r.perLight * 1000) / 1000, r.scope], [['Aug 19-21', 'Sep 11-13', 'Oct 2-4'], 2.5, 'site'],
    'the site\'s last 3 trims before the date: (3.00 + 2.50 + 2.00) / 3');
  assert.equal(TRIMY.roomLights(ev, '23RD', '1'), 48);
  const item = { site: '23RD', room: '3', strains: [{ strain: 'ANTIDOTE', n: 8 }, { strain: 'BLUEBANGER', n: null }, { strain: 'RIPTIDE', n: 8 }] };
  const e = TRIMY.estimate(ev, item, '2026-10-17', 0.1);
  assert.deepEqual([e.lights, e.lightsFrom, e.sheetLights, Math.round(e.lb * 10) / 10, Math.round(e.lo), Math.round(e.hi)], [45, 'room', 16, 112.5, 101, 124],
    'the room\'s lights as the trim sheets count them (45) times 2.5 lb, with the usual miss either side');
  assert.deepEqual(e.strains.map(x => `${x.strain} ${x.lb}`), ['ANTIDOTE 20', 'RIPTIDE 20']);
  assert.equal(TRIMY.match(ev, '25TH', '2', '2026-10-16').tab, 'Oct. 15', 'a sheet day within 3 days of the tab finds it');
  assert.equal(TRIMY.match(ev, '25TH', '2', '2026-10-20'), null);
  assert.equal(TRIMY.estimate(ev, { site: 'OLYMPIC', room: '3', strains: [] }, '2026-12-10'), null, 'no lights anywhere: no estimate');
  const all = TRIMY.rate(ev, 'OLYMPIC', '2026-12-10');
  assert.equal(all.scope, 'all', 'a site with no trims yet borrows the last trims of every site');
  const bt = TRIMY.backtest(ev);
  assert.ok(bt && bt.n === 4, 'the backtest scores every trim that had earlier trims at its site (3 at Slane, 1 at Filifera)');
  // the folded early harvests stay findable on their own days, and a past trim's estimate uses its own lights
  const mp = TRIMY.matchPart(ev, '25TH', '2', '2026-10-06');
  assert.deepEqual([mp.of.tab, mp.part.tab, Math.round(mp.part.lb * 10) / 10], ['Oct. 15', 'Oct. 6(RM2 early harvest)', 13]);
  assert.equal(TRIMY.match(ev, '25TH', '2', '2026-10-06'), null);
  assert.equal(TRIMY.estimate(ev, item, '2026-10-02', 0.1, 40).lights, 40, 'a lights override wins over the room\'s latest count');
  // an early harvest with no later tab yet never sets the site's rate
  const early = TRIMY.events([...rows.slice(0, 4), line('SLANE 2026.xlsx', 'Oct 10 (RM2 early)', '2026-10-10', '2026-10-10', '2', 54, 'Wizzy', lbs(20), 0, 0, 0)]);
  assert.equal(Math.round(TRIMY.rate(early, '23RD', '2026-10-17').perLight * 1000) / 1000, 2.5, 'the 0.37 lb/light early harvest is left out');
}

// optional: a real export of the tab, to see it parses end to end
if (realSup) {
  const real = SUP.parse(readFileSync(realSup, 'utf8'), 'DISTRO SUPPLY');
  assert.ok(real && real.items.length > 100, 'real supply export parses');
  console.log(`real supply export: ${real.items.length} items, ${real.items.filter(i => i.below).length} below par, sites ${real.sites.join(' ')}`);
}
if (realBat) {
  const rows = JSON.parse(readFileSync(realBat, 'utf8'));
  const groups = BAT.groups(rows);
  assert.equal(groups.reduce((a, x) => a + x.rows.length, 0), rows.length, 'every batch lands in a group');
  assert.ok(groups[groups.length - 1].finished, 'finished batches come last');
  const coded = rows.filter(r => BAT.decode(r.batch_code).site).length;
  console.log(`real batches: ${rows.length} rows, ${coded} with a site in the code; ${groups.map(x => `${x.label} ${x.rows.length}`).join(', ')}`);
}
if (realPipe) {
  const real = PIPE.parse(readFileSync(realPipe, 'utf8'));
  const n = real.reduce((a, x) => a + x.days.reduce((b, d) => b + d.items.length, 0), 0);
  assert.ok(real.length > 10 && n > 100, 'real export parses');
  // every week builds a board, and no bar is left without a headline
  const M = WEEK.buildModel(real);
  let bars = 0;
  for (const w of real) {
    const B = WEEK.buildBoard(M, w.start, { today: '', summary: WEEK.summarize(w), drops: new Map() });
    for (const l of B.lanes) for (const b of [...l.headTracks.flat(), ...l.rows.flatMap(r => r.tracks.flat())]) {
      bars++;
      if (!(l.id === 'jars' || l.id === 'prerolls') || b.kind === 'head') assert.ok(b.head, `bar with no headline in ${w.start} ${l.id}`);
    }
    for (const d of w.days) WEEK.dayBoard(M, d.date, { drops: new Map() });
  }
  console.log(`real export: ${real.length} weeks, ${n} items, ${bars} bars, ${real[0].start} to ${real[real.length - 1].start}`);
  if (realTrims) {
    const ev = TRIMY.events(JSON.parse(readFileSync(realTrims, 'utf8')));
    const bt = TRIMY.backtest(ev);
    assert.ok(ev.length >= 40 && bt && bt.miss < 0.2, 'real trims parse and the estimate stays within 20% on average');
    console.log(`real trims: ${ev.length} trims; estimates off by ${Math.round(bt.miss * 1000) / 10}% on average, within 10% on ${bt.within10} of ${bt.n}`);
  }
  if (realTasks && realBat) {
    // plan vs actual on the real sheets: September's run is closed, so its figures hold still
    const A = ACT.build(real, JSON.parse(readFileSync(realTasks, 'utf8')), JSON.parse(readFileSync(realBat, 'utf8')), '2026-10-15', BAT.statusKey);
    const sep = A.byId.get('prerolls-2026-09-07');
    assert.ok(sep, 'the Sep 7-15 pre-roll run is found');
    const f = sep.prods.find(x => x.prod === '5pk'), g = sep.prods.find(x => x.prod === '1g');
    assert.deepEqual([f.plan, g.plan, f.sticks, f.label2, g.label2], [4450, 3000, 10350, 2773, 1820]);
    console.log(`real plan vs actual: ${A.runs.prerolls.length} pre-roll runs, ${A.runs.jars.length} jar runs; Sep 7-15 5-packs plan ${f.plan}, made ${f.made}, counted ${f.counted}`);
  }
}
console.log('pipeline-check: all checks passed');
