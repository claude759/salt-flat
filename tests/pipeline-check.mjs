// Checks the Production Pipeline page's sheet parsers (pipeline.html) on a made-up week laid out
// the way the DISTRO PIPELINE tab is, and a made-up DISTRO SUPPLY tab.
// Run: node tests/pipeline-check.mjs [real pipeline export.csv] [--supply=real supply export.csv]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../pipeline.html', import.meta.url), 'utf8');
const src = html.split('/* ===== PIPELINE PARSER START =====')[1].split('/* ===== PIPELINE PARSER END ===== */')[0];
const PIPE = new Function(`/*${src}; return PIPE;`)();
const supSrc = html.split('/* ===== SUPPLY PARSER START =====')[1].split('/* ===== SUPPLY PARSER END ===== */')[0];
const SUP = new Function('PIPE', `/*${supSrc}; return SUP;`)(PIPE);
const args = process.argv.slice(2), realPipe = args.find(a => !a.startsWith('--')),
  realSup = (args.find(a => a.startsWith('--supply=')) || '').slice(9);

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

// optional: a real export of the tab, to see it parses end to end
if (realSup) {
  const real = SUP.parse(readFileSync(realSup, 'utf8'), 'DISTRO SUPPLY');
  assert.ok(real && real.items.length > 100, 'real supply export parses');
  console.log(`real supply export: ${real.items.length} items, ${real.items.filter(i => i.below).length} below par, sites ${real.sites.join(' ')}`);
}
if (realPipe) {
  const real = PIPE.parse(readFileSync(realPipe, 'utf8'));
  const n = real.reduce((a, x) => a + x.days.reduce((b, d) => b + d.items.length, 0), 0);
  assert.ok(real.length > 10 && n > 100, 'real export parses');
  console.log(`real export: ${real.length} weeks, ${n} items, ${real[0].start} to ${real[real.length - 1].start}`);
}
console.log('pipeline-check: all checks passed');
