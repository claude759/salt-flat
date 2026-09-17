import fs from 'node:fs'; import vm from 'node:vm';
const src = fs.readFileSync(process.argv[2], 'utf8');
function grab(re){ const m = src.match(re); if (!m) throw new Error('not found '+re); let i = src.indexOf(m[0]), d = 0, st = false;
  for (let j = i; j < src.length; j++){ const c = src[j]; if (c==='{'){d++;st=true;} else if (c==='}'){d--; if (st&&d===0) return src.slice(i,j+1);} } throw new Error('unbalanced'); }
const line = re => { const m = src.match(re); if (!m) throw new Error('not found '+re); return m[0]; };
const code = [
  line(/^const LB = .*$/m), line(/^const PRODUCTS = \[[\s\S]*?\];/m),
  line(/^const VAPE_RE .*$/m), line(/^const PACK_RE .*$/m), line(/^const LABEL_RE .*$/m),
  line(/^const isVape .*$/m), line(/^const isPack .*$/m), line(/^const isLabel .*$/m), line(/^const vapeUnitsOf .*$/m),
  grab(/^function productFor/m), grab(/^function gramsFor/m), grab(/^function taskRank/m), grab(/^function mkClass/m),
  line(/^const fInt .*$/m), line(/^const fMoney .*$/m), line(/^const fCents .*$/m), line(/^const fLbs .*$/m), line(/^const fNum .*$/m),
  line(/^const fH2 .*$/m), line(/^const fLb2 .*$/m), line(/^const sum = .*$/m), line(/^const MONTHS = .*$/m),
  'const esc = s => String(s); const fDayMDY = d => d; const costlbMonths = {all:new Map()};',
  grab(/^function marketTotals/m), grab(/^function renderCostLb/m), grab(/^function costlbSection/m), grab(/^function costlbDetailHTML/m),
  grab(/^function renderUnitsPounds/m),
].join('\n');
// fake DOM: every selector resolves to an object that records innerHTML
const bodies = {};
const document = { querySelector: sel => (bodies[sel] ??= { innerHTML: '' }) };
const ctx = vm.createContext({ document, console });
vm.runInContext(code, ctx);
// rows shaped like the screenshot: cost per row, task names, lo = lowercase
const R = (date, task, packaged, labeled, cost, hours=1) => ({ date, task, lo: task.toLowerCase(), packaged, labeled, cost, hours });
const sel = [
  R('2026-09-01','3.5g jar packed', 2664, 0, 1216, 40),
  R('2026-09-01','3.5g jar packed', 0, 1420, 325, 10),           // jar units typed into the Labeled bubble → stays under Labeling (flower rule unchanged)
  R('2026-09-02','3.5g jar labeled', 0, 6491, 1312, 30),
  R('2026-09-02','Vape filling', 4678, 0, 1593, 20),
  R('2026-09-03','Vape filling', 0, 1337, 368, 5),                // vape units typed into Labeled → counted ONCE, under Vape
  R('2026-09-03','Vape packaging', 902, 1560, 902, 12),           // both bubbles filled → one row, units = both, cost once
  R('2026-09-04','Vape labeling', 0, 9761, 4449, 60),
];
vm.runInContext('globalThis.sel = ' + JSON.stringify(sel) + '; renderUnitsPounds(sel); renderCostLb(sel); globalThis.mt = marketTotals(sel, null); globalThis.detail = costlbDetailHTML(sel);', ctx);
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const task = text(bodies['#taskTable tbody'].innerHTML), prod = text(bodies['#productTable tbody'].innerHTML), costlb = text(bodies['#costlbAll tbody'].innerHTML);
console.log('BY TASK :', task); console.log('BY PROD :', prod); console.log('COST/LB :', costlb);
// by task
ok(task.includes('Packaging 3.5g jar packed 2,664 $1,216'), 'jar packed under Packaging');
ok(task.includes('Labeling 3.5g jar labeled 6,491 $1,312') && task.includes('3.5g jar packed 1,420 $325'), 'flower labeled bucket unchanged');
ok(/Vape Vape filling 6,015 \$1,961/.test(task), 'Vape filling = both bubbles summed, cost once: ' + task.match(/Vape filling[^V]*/)?.[0]);
ok(/Vape packaging 2,462 \$902/.test(task), 'Vape packaging counted once (was in both sections before)');
ok(/Vape filling .* Vape packaging .* Vape labeling/.test(task), 'vape order fill → pack → label');
ok(task.split('Vape filling').length === 2 && task.split('Vape packaging').length === 2, 'no vape rows under Packaging/Labeling');
ok(/Vape labeling 9,761 \$4,449 — — — \$0\.46/.test(task), 'vape labeling: no lbs, cost/unit $0.46');
ok(/3\.5g jar packed 2,664 \$1,216 20\.5 — \$59\.2\d \$0\.46/.test(task), 'flower row keeps lbs + $/lb and gains $/unit');
// by product
ok(/Vape Carts 18,238 \$7,312 — — — \$0\.40/.test(prod), 'Vape Carts row: dashes for weight, $/unit');
ok(/3\.5g Jar 10,575 \$2,853 20\.5 61\.0 \$3[45]\.\d\d \$0\.27/.test(prod), 'jar product row: ' + prod);
// cost per lb: vape pay out of the flower numerators
const mt = vm.runInContext('mt', ctx);
ok(mt.packCost === 1541 && mt.labelCost === 1312 && mt.vapeCost === 7312 && mt.vapeUnits === 18238 && mt.packaged === 2664 && mt.labeled === 7911, 'marketTotals buckets: ' + JSON.stringify(mt));
ok(/\$1,541\.00 .* \$1,312\.00/.test(costlb) && /\$7,312\.00 18,238 \$0\.40/.test(costlb), 'month row: flower pay excludes vape; Vape group shows pay/units/$ per unit');
const detail = vm.runInContext('detail', ctx); const dt = text(detail);
ok(/Vape \$ \/ unit = \$7,312\.00 ÷ 18,238 units = \$0\.40/.test(dt), 'drill-down Vape section with $/unit');
ok(!/Packaging[\s\S]*Vape filling[\s\S]*Σ Packaging/.test(dt), 'drill-down: no vape rows inside the flower sections');
console.log(`vape report tests: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
