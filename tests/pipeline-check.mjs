// Checks the Production Pipeline page's sheet parser (pipeline.html) on a made-up week laid out
// the way the DISTRO PIPELINE tab is. Run: node tests/pipeline-check.mjs [optional real export.csv]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../pipeline.html', import.meta.url), 'utf8');
const src = html.split('/* ===== PIPELINE PARSER START =====')[1].split('/* ===== PIPELINE PARSER END ===== */')[0];
const PIPE = new Function(`/*${src}; return PIPE;`)();

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

// optional: a real export of the tab, to see it parses end to end
if (process.argv[2]) {
  const real = PIPE.parse(readFileSync(process.argv[2], 'utf8'));
  const n = real.reduce((a, x) => a + x.days.reduce((b, d) => b + d.items.length, 0), 0);
  assert.ok(real.length > 10 && n > 100, 'real export parses');
  console.log(`real export: ${real.length} weeks, ${n} items, ${real[0].start} to ${real[real.length - 1].start}`);
}
console.log('pipeline-check: all checks passed');
