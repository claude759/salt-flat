// BA Field app (ba/index.html) Schedule: task types, done marks and the Schedule export (2026-11-20).
// Runs the page's own SCHEDULE TASK MODEL block, sliced out of the file into a vm. Synthetic rows only.
//   node --test tests/ba-schedule-tasks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const between = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return html.slice(a, b); };
const s = { Set, Map, Date, String };
vm.createContext(s);
vm.runInContext(between('const SCHED_ALIASES=', 'const SCHED_COLORS='), s);
vm.runInContext(between('const SCHED_PAD=', '/* ── end SCHEDULE TASK MODEL ── */'), s);
const get = name => vm.runInContext(name, s);
const plain = x => JSON.parse(JSON.stringify(x));

test('pickers: a person is found by the other names the schedule knows them by; every type has search words', () => {
  const also = get('schedAlsoKnown');
  assert.match(also('Ledy'), /\bleti\b/);
  assert.match(also('Ledy'), /\bleticia\b/);
  assert.match(also('Makenna'), /\bmckenna\b/);
  assert.equal(also('Cesar'), '');
  const kinds = plain(get('SCHED_KINDS'));
  assert.ok(kinds.every(o => o.search && o.search.toLowerCase().includes(o.label.toLowerCase())));
  assert.ok(kinds.find(o => o.k === 'followup').search.includes('followup'));
  assert.ok(kinds.find(o => o.k === 'pad').search.toLowerCase().includes('demo/pad'));
});

test('a task\'s store: exact name, then alias or Pistil name, then the reduced name; the board\'s own first; a tie is no store', () => {
  const key = get('schedStoreKey'), find = get('schedStoreFor');
  assert.equal(key('Kolas - ARDEN'), 'kolas arden');
  assert.equal(key('KOLAS Arden'), 'kolas arden');
  assert.equal(key('The Cake House (Rec) [old]'), 'cake house');
  const stores = [
    { id: 'a', name: 'KOLAS Arden', state: 'CA' },
    { id: 'b', name: 'Urban Smoke Avalon', state: 'CA' }, { id: 'b0', name: 'Urban Smoke Avalon', state: null },
    { id: 'c', name: 'Sundial Collective Redding', state: 'CA', aliases: ['Sundial'] },
    { id: 'd', name: 'Buzz National City', state: 'CA', pistil_name: 'BUZZ - National City' },
    { id: 'e', name: 'Twin', state: 'CA' }, { id: 'f', name: 'Twin', state: 'CA' },
    { id: 'g', name: 'Gone', state: 'CA', active: false }, { id: 'h', name: 'Flowery', state: 'FL' },
  ];
  const id = a => (find(stores, 'CA', a) || {}).id || null;
  assert.equal(id('Kolas - ARDEN'), 'a');               // reduced name
  assert.equal(id('urban smoke avalon'), 'b');           // the board's own store before the state-less copy
  assert.equal(id('Sundial'), 'c');                      // alias
  assert.equal(id('Buzz - National City'), 'd');        // its Pistil name
  assert.equal(id('Twin'), null);                        // two stores: no guess
  assert.equal(id('Gone'), null);                        // inactive
  assert.equal(id('Flowery'), null);                     // another board's store
  assert.equal(id(''), null);
});

test('a task keeps its own type; an older task reads like the sheet: SO# delivery, PAD/EDU notes, else visit', () => {
  const kindOf = get('schedKindOf'), label = get('schedKindLabel');
  assert.equal(kindOf({ kind: 'training' }), 'training');
  assert.equal(kindOf({ kind: null, soNum: '' }), 'visit');
  assert.equal(kindOf({ kind: null, soNum: 'SO-0000481' }), 'delivery');
  assert.equal(kindOf({ so_num: 'SO-1' }), 'delivery');
  assert.equal(kindOf({ kind: null, soNotes: 'PAD 4PM - 6PM' }), 'pad');
  assert.equal(kindOf({ kind: null, notes: 'staff education w/ lunch' }), 'edu');
  assert.equal(kindOf({ kind: 'visit', soNotes: 'PAD 2-4' }), 'visit');   // a type someone picked wins
  assert.equal(label('followup'), 'Follow-up');
  assert.equal(label('nope'), '');
});

test('status: a past visit waits 16 days for the BA to log it; a training or follow-up is overdue the next day', () => {
  const st = get('schedTaskStatus');
  assert.equal(st({ iso: '2026-11-10' }, '2026-11-20'), '');                          // a schedule-sheet row
  assert.equal(st({ dbId: 'a', iso: '2026-11-10', doneAt: '2026-11-11T01:00:00Z' }, '2026-11-20'), 'done');
  assert.equal(st({ dbId: 'a', iso: '2026-11-20' }, '2026-11-20'), 'open');          // today is not late yet
  assert.equal(st({ dbId: 'a', iso: '2026-11-19', kind: 'visit' }, '2026-11-20'), 'unconfirmed');
  assert.equal(st({ dbId: 'a', iso: '2026-11-04', kind: 'pad' }, '2026-11-20'), 'unconfirmed');   // day 16
  assert.equal(st({ dbId: 'a', iso: '2026-11-03', kind: 'visit' }, '2026-11-20'), 'overdue');     // day 17
  assert.equal(st({ dbId: 'a', iso: '2026-11-19', kind: 'followup' }, '2026-11-20'), 'overdue');
  assert.equal(st({ dbId: 'a', iso: '2026-11-19', kind: 'training' }, '2026-11-20'), 'overdue');
  assert.equal(st({ dbId: 'a', iso: '2026-11-01', soNum: 'SO-9' }, '2026-11-20'), '');            // deliveries: no status
  assert.equal(get('SCHED_STATUS_WORD').unconfirmed, 'Not confirmed yet');
});

test('done day: the visit day for logged or confirmed visits; the marking day for a training or follow-up', () => {
  const dd = get('schedDoneDay'), local = ts => ts.slice(0, 10);
  assert.equal(dd({ iso: '2026-11-03', doneAt: '2026-11-20T18:00:00Z', doneHow: 'trip' }, local), '2026-11-03');
  assert.equal(dd({ iso: '2026-11-03', doneAt: '2026-11-20T18:00:00Z', doneHow: 'report' }, local), '2026-11-03');
  assert.equal(dd({ iso: '2026-11-06', doneAt: '2026-11-20T18:00:00Z', doneHow: 'report', doneOn: '2026-11-08' }, local), '2026-11-08'); // the report's visit day
  // a report filed from the task marks it ('marked') and names its visit day, five days after the planned day
  assert.equal(dd({ iso: '2026-11-03', kind: 'visit', doneAt: '2026-11-08T18:00:00Z', doneHow: 'marked', doneOn: '2026-11-08' }, local), '2026-11-08');
  assert.equal(dd({ iso: '2026-11-03', kind: 'visit', doneAt: '2026-11-05T18:00:00Z', doneHow: 'marked' }, local), '2026-11-03');
  assert.equal(dd({ iso: '2026-11-30', kind: 'visit', doneAt: '2026-11-05T18:00:00Z', doneHow: 'marked' }, local), '2026-11-05'); // never later than the tap
  assert.equal(dd({ iso: '2026-11-03', kind: 'followup', doneAt: '2026-11-05T18:00:00Z', doneHow: 'marked' }, local), '2026-11-05');
  assert.equal(dd({ iso: '2026-11-03', kind: 'training', doneAt: '2026-11-05T18:00:30Z', doneHow: 'marked',
    createdAt: '2026-11-05T18:00:00Z' }, local), '2026-11-03');                                  // ticked Done as it was added
  assert.equal(dd({ iso: '2026-11-03', doneAt: null }, local), '');
});

test('row type in words: app tasks by their type, sheet rows by SO# or PAD/EDU in the notes', () => {
  const t = get('schedRowType');
  assert.equal(t({ dbId: 'x', kind: 'followup' }), 'Follow-up');
  assert.equal(t({ dbId: 'x', kind: null, soNum: '' }), 'Visit');
  assert.equal(t({ soNum: 'SO-1' }), 'Delivery');
  assert.equal(t({ synth: true }), 'Delivery');
  assert.equal(t({ soNotes: 'PAD 2-4pm' }), 'Demo / PAD');
  assert.equal(t({ teamNotes: 'education talk' }), 'Education talk');
  assert.equal(t({ soNotes: 'drop off merch' }), 'Visit');
});

const ROWS = [
  { iso: '2026-11-03', canon: 'Makenna', account: 'Buzz Santee', dbId: 't1', kind: 'visit', doneAt: '2026-11-20T18:00:00Z', doneHow: 'trip', soNotes: 'restock' },
  { iso: '2026-11-03', canon: 'Ledy', account: 'Zen Leaf', dbId: 't2', kind: 'training', doneAt: null, soNotes: '=HYPERLINK("x")' },
  { iso: '2026-11-18', canon: 'Cesar', account: 'Urban Smoke Avalon', dbId: 't4', kind: null, doneAt: null, soNotes: 'PAD 12-2' },
  { iso: '2026-11-25', canon: 'Ledy', account: 'Alpha Store', dbId: 't3', kind: 'followup', doneAt: null, title: 'Order draft - Vapes',
    time: { mins: 870, label: '2:30 PM' }, booking: null },
  { iso: '2026-11-06', canon: 'Joanna', account: 'Sharps Co', dbId: 't5', kind: 'visit', doneAt: '2026-11-18T20:00:00Z', doneHow: 'marked' },
  { iso: '2026-11-04', canon: 'Carlos', account: 'Catalyst Santa Ana', soNum: 'SO-0000476', inv: '1,200.00', synth: true },
  { iso: '2026-11-05', canon: 'Joanna', account: 'Benzeen La Brea', soNotes: 'PAD 2-4', teamNotes: 'bring table', region: 'LA' },
  { iso: '2026-10-31', canon: 'Ledy', account: 'Too Early', dbId: 't9' },
  { iso: '2026-12-01', canon: 'Ledy', account: 'Too Late', dbId: 't8' },
];
const OPTS = (x = {}) => ({ from: '2026-11-01', to: '2026-11-30', sel: null, todayIso: '2026-11-20', localDay: ts => ts.slice(0, 10),
  place: v => (v.account === 'Buzz Santee' ? '9500 Cuyamaca St, Santee, CA 92071' : ''),
  reports: v => (v.account === 'Benzeen La Brea' ? 1 : 0), ...x });

test('export: header, days included at both ends, sorted by day, person, store', () => {
  const rows = plain(get('schedExportRows')(ROWS, OPTS()));
  assert.deepEqual(rows[0], plain(get('SCHED_CSV_HEAD')));
  const H = rows[0], col = n => H.indexOf(n);
  assert.deepEqual(H.slice(0, 7), ['Date', 'Day', 'Time', 'Person', 'Type', 'Title', 'Account']);
  assert.deepEqual(rows.slice(1).map(r => r[col('Date')] + ' ' + r[col('Person')] + ' ' + r[col('Account')]), [
    '2026-11-03 Ledy Zen Leaf', '2026-11-03 Makenna Buzz Santee', '2026-11-04 Carlos Catalyst Santa Ana',
    '2026-11-05 Joanna Benzeen La Brea', '2026-11-06 Joanna Sharps Co', '2026-11-18 Cesar Urban Smoke Avalon', '2026-11-25 Ledy Alpha Store']);
});

test('export: status, done day and how, post-visit report, notes, source', () => {
  const rows = plain(get('schedExportRows')(ROWS, OPTS()));
  const ai = rows[0].indexOf('Account');
  const by = Object.fromEntries(rows.slice(1).map(r => [r[ai], Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))]));
  assert.equal(by['Buzz Santee'].Status, 'Done');
  assert.equal(by['Buzz Santee']['Done on'], '2026-11-03');      // the visit day, not the day it was marked
  assert.equal(by['Buzz Santee'].How, 'trip logged');
  assert.equal(by['Buzz Santee']['Marked on'], '');               // nobody tapped it: the trip did
  assert.equal(by['Buzz Santee'].Address, '9500 Cuyamaca St, Santee, CA 92071');
  assert.equal(by['Buzz Santee']['Post-visit report'], 'Not filed');
  assert.equal(by['Buzz Santee'].Day, 'Tue');
  assert.equal(by['Zen Leaf'].Status, 'Overdue');
  assert.equal(by['Zen Leaf'].Type, 'Training');
  assert.equal(by['Zen Leaf']['Post-visit report'], '');         // a training needs no post-visit report
  assert.equal(by['Urban Smoke Avalon'].Type, 'Demo / PAD');     // an older task, PAD in its notes
  assert.equal(by['Urban Smoke Avalon'].Status, 'Not confirmed yet');
  assert.equal(by['Urban Smoke Avalon']['Post-visit report'], 'Not filed');
  assert.equal(by['Alpha Store'].Status, 'Open');
  assert.equal(by['Alpha Store']['Post-visit report'], '');       // a future task has no report to miss
  assert.equal(by['Catalyst Santa Ana'].Type, 'Delivery');
  assert.equal(by['Catalyst Santa Ana'].Status, '');             // Distru orders carry no done mark
  assert.equal(by['Catalyst Santa Ana']['Post-visit report'], ''); // deliveries are not store visits
  assert.equal(by['Catalyst Santa Ana'].Source, 'Distru order');
  assert.equal(by['Catalyst Santa Ana']['Invoice $'], '1,200.00');
  assert.equal(by['Benzeen La Brea'].Type, 'Demo / PAD');
  assert.equal(by['Benzeen La Brea']['Post-visit report'], 'Filed');
  assert.equal(by['Benzeen La Brea'].Notes, 'PAD 2-4 · Team: bring table');
  assert.equal(by['Benzeen La Brea'].Source, 'Schedule sheet');
  assert.equal(by['Benzeen La Brea'].Region, 'LA');
  assert.equal(by['Zen Leaf'].Source, 'App task');
  assert.equal(by['Sharps Co']['Done on'], '2026-11-06');         // a visit confirmed by hand counts on its own day
  assert.equal(by['Sharps Co']['Marked on'], '2026-11-18');       // and the tap day is kept
  assert.equal(by['Sharps Co'].How, 'marked done');
  assert.equal(by['Alpha Store'].Title, 'Order draft - Vapes');
  assert.equal(by['Alpha Store'].Time, '2:30 PM');
});

test('export: only the people picked, and deliveries can be left out', () => {
  const ex = get('schedExportRows');
  const onlyLedy = plain(ex(ROWS, OPTS({ sel: new Set(['Ledy']) })));
  const ai = onlyLedy[0].indexOf('Account'), ti = onlyLedy[0].indexOf('Type');
  assert.deepEqual(onlyLedy.slice(1).map(r => r[ai]), ['Zen Leaf', 'Alpha Store']);
  const noDel = plain(ex(ROWS, OPTS({ noDeliveries: true })));
  assert.ok(!noDel.slice(1).some(r => r[ti] === 'Delivery'));
  assert.equal(noDel.length, 7);
  assert.equal(plain(ex([], OPTS())).length, 1);                  // header only
});

test('CSV: commas, quotes and line breaks are quoted; a formula is kept as text', () => {
  const csv = get('schedCsv')([['a,b', 'say "hi"', 'two\nlines', '=HYPERLINK("x")', '-5', 'plain']]);
  assert.equal(csv, '"a,b","say ""hi""","two\nlines","\'=HYPERLINK(""x"")",\'-5,plain');
});

test('Done before a visit\'s day: not for a visit, Demo / PAD or EDU still to come; trainings and follow-ups any day', () => {
  const early = (v) => get('schedTooEarly')({ dbId: 'x', iso: '2026-11-27', ...v }, '2026-11-23');
  assert.equal(early({ kind: 'visit' }), true);
  assert.equal(early({ kind: 'pad' }), true);
  assert.equal(early({ kind: 'edu' }), true);
  assert.equal(early({ kind: null, soNotes: 'store visit' }), true);        // an older task: a visit by its notes
  assert.equal(early({ kind: null, soNotes: 'Demo 2-4pm PAD' }), true);
  assert.equal(early({ kind: 'training' }), false);
  assert.equal(early({ kind: 'followup' }), false);
  assert.equal(early({ kind: null, soNum: 'SO-1' }), false);               // a delivery
  assert.equal(early({ kind: 'visit', iso: '2026-11-23' }), false);        // its day
  assert.equal(early({ kind: 'visit', iso: '2026-11-20' }), false);        // past
  assert.equal(early({ kind: 'visit', doneAt: '2026-11-21T16:45:00Z' }), false);   // already done: Not done is still offered
  assert.equal(get('schedTooEarly')({ iso: '2026-11-27', kind: 'visit' }, '2026-11-23'), false);   // a sheet row: no Done at all
});
