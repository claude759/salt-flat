// Drives the REAL doSyncShift / doSyncTaskDay out of the shipped HTML against a
// stubbed Supabase client whose response is deliberately slow, so the in-flight
// edit race is exercised deterministically instead of hoped about.
//
// The bug under test: a value typed WHILE a save is in flight was acknowledged
// by a request that never carried it, so the DB kept the old value.
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

// pull a top-level `function`/`const` block out by brace matching
function grab(startRe) {
  const m = src.match(startRe);
  if (!m) throw new Error('not found: ' + startRe);
  let i = src.indexOf(m[0]), depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + startRe);
}

const pieces = [
  grab(/^const SHIFT_COL = \{/m),
  grab(/^function markShiftDirty/m),
  grab(/^async function doSyncShift/m),
  grab(/^const TASK_COL = \{/m),
  'const TASK_COL_NAME = { begin: \'begin_at\', end: \'end_at\' };',
  grab(/^function markTaskDirtyRow/m),
  grab(/^async function doSyncTaskDay/m),
].join('\n');

// ---- the stub DB -----------------------------------------------------------
const db = { shifts: {}, tasks: {} };
let LATENCY = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function table(name) {
  const store = name.includes('shift') ? db.shifts : db.tasks;
  const api = {
    update(rec) { return { _op: 'update', rec, store, ...chain }; },
    insert(rec) { return { _op: 'insert', rec, store, ...chain }; },
    upsert(rec) { return { _op: 'insert', rec, store, ...chain }; },
    delete() { return { _op: 'delete', store, ...chain }; },
    select() { return { _op: 'select', store, ...chain }; },
  };
  return api;
}
const chain = {
  eq(_c, v) { this._id = v; return this; },
  in() { return this; },
  select() { return this; },
  // PostgREST returns a ROW for .single() and an ARRAY otherwise. doSyncShift
  // uses .single(); doSyncTaskDay's update does not — and it branches on
  // data.length, so the stub has to get this distinction right.
  single() { this._single = true; return this; },
  // every terminal await funnels here
  then(res, rej) {
    return (async () => {
      await sleep(LATENCY);                     // <- the in-flight window
      if (this._op === 'update') {
        const row = this.store[this._id];
        if (!row) return { data: this._single ? null : [], error: this._single ? { code: 'PGRST116' } : null };
        Object.assign(row, this.rec);
        const hit = { ...row, hours: row.hours || 0, total: row.total || 0 };
        return { data: this._single ? hit : [hit], error: null };
      }
      if (this._op === 'insert') {
        const id = this.rec.id;
        this.store[id] = { ...this.rec };
        return { data: this._single ? { id } : [{ id }], error: null };
      }
      return { data: [], error: null };
    })().then(res, rej);
  },
};

// ---- everything doSync* touches, stubbed to a no-op ------------------------
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Math, Number, String, Object, Array, Set, JSON, Date,
  crypto: { randomUUID: () => 'tid-' + Math.random().toString(16).slice(2) },
  sb: { from: table },
  SITE: { tables: { shifts: 'ny_shifts', tasks: 'ny_tasks', notes: 'ny_notes' } },
  myId: 'race-test',
  shifts: [], lcEdits: {}, lpNotes: {},
  pendingTaskDeletes: new Set(), pendingShiftDeletes: new Set(),
  shiftSyncBusy: 0, taskSyncBusy: 0,
  document: { querySelector: () => null, activeElement: null },
  renderTsFilters(){}, renderTsLog(){}, renderCombined(){}, renderAll(){},
  renderLaborPack(){}, renderReports(){}, scheduleDerivedRender(){},
  tasksDirtyNow: () => false, toast(m){ sandbox._toasts.push(m); },
  queueShiftSave(s){ sandbox._requeued.push(s); },
  markDirtyDay(d){ sandbox._daysRequeued.push(d); },
  _toasts: [], _requeued: [], _daysRequeued: [],
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(pieces, sandbox);

const ok = [], bad = [];
const check = (name, cond, detail) => (cond ? ok : bad).push(name + (detail ? ' — ' + detail : ''));

// ── 1. SHIFT: correct a cell while the save is in flight ────────────────────
{
  const s = { id: 'sh1', break_minutes: 3, rate: 23, people: 1, _dirty: new Set(['break_minutes']) };
  db.shifts.sh1 = { id: 'sh1', break_minutes: 0, hours: 8, total: 184 };
  sandbox.shifts = [s];
  const inflight = vm.runInContext('doSyncShift', sandbox)(s);
  await sleep(80);                                   // request is out on the wire
  s.break_minutes = 30;                              // the packer finishes typing "30"
  vm.runInContext('markShiftDirty', sandbox)(s, 'break_minutes');
  await inflight;
  check('shift: mid-flight edit stays dirty after the ack',
    s._dirty.has('break_minutes'), 'dirty=' + [...s._dirty]);
  await vm.runInContext('doSyncShift', sandbox)(s);  // the follow-up save
  check('shift: DB ends at the typed value 30',
    db.shifts.sh1.break_minutes === 30, 'db=' + db.shifts.sh1.break_minutes);
}

// ── 2. SHIFT: a failed save re-marks the fields so nothing is dropped ───────
{
  const s = { id: 'gone', break_minutes: 15, rate: 23, people: 1, _dirty: new Set(['break_minutes']) };
  sandbox.shifts = [s];                              // NOT in db.shifts -> PGRST116
  await vm.runInContext('doSyncShift', sandbox)(s);
  check('shift: deleted-row path re-marks then drops the row',
    sandbox.shifts.length === 0 && sandbox._toasts.some(t => /deleted elsewhere/.test(t)));
}
{
  const s = { id: 'sh2', break_minutes: 5, rate: 23, people: 1, _dirty: new Set(['break_minutes']) };
  db.shifts.sh2 = { id: 'sh2', break_minutes: 0 };
  sandbox.shifts = [s];
  const realFrom = sandbox.sb.from;
  sandbox.sb.from = () => ({ update: () => ({ eq: () => ({ select: () => ({ single: async () => {
    await sleep(50); return { data: null, error: { code: '500', message: 'boom' } };
  } }) }) }) });
  await vm.runInContext('doSyncShift', sandbox)(s);
  sandbox.sb.from = realFrom;
  check('shift: network failure puts the field back on the retry list',
    s._dirty.has('break_minutes'), 'dirty=' + [...s._dirty]);
}

// ── 3. TASK update: correct a cell while the save is in flight ──────────────
{
  const r = { _id: 't1', task: 'Jar pack', people: 4, packaged: 100, _dirty: new Set(['packaged']) };
  db.tasks.t1 = { id: 't1', packaged: 0 };
  sandbox.lcEdits = { '2026-07-28': [r] };
  const inflight = vm.runInContext('doSyncTaskDay', sandbox)('2026-07-28');
  await sleep(80);
  r.packaged = 1000;                                 // typed one more zero mid-flight
  vm.runInContext('markTaskDirtyRow', sandbox)(r, 'packaged');
  await inflight;
  check('task: mid-flight edit stays dirty after the ack',
    r._dirty.has('packaged'), 'dirty=' + [...r._dirty]);
  await vm.runInContext('doSyncTaskDay', sandbox)('2026-07-28');
  check('task: DB ends at the typed value 1000',
    db.tasks.t1.packaged === 1000, 'db=' + db.tasks.t1.packaged);
}

// ── 4. TASK insert: typing during the INSERT is not swallowed ───────────────
{
  const r = { task: 'Bud pack', people: 3, packaged: 50, _dirty: new Set(['task','people','packaged']) };
  sandbox.lcEdits = { '2026-07-28': [r] };
  sandbox._daysRequeued = [];
  const inflight = vm.runInContext('doSyncTaskDay', sandbox)('2026-07-28');
  await sleep(80);
  r.note = 'ran short on jars';                      // typed while the INSERT is out
  vm.runInContext('markTaskDirtyRow', sandbox)(r, 'note');
  await inflight;
  await sleep(20);
  check('task insert: mid-insert edit survives and requeues the day',
    r._dirty.has('note') && sandbox._daysRequeued.includes('2026-07-28'),
    'dirty=' + [...r._dirty] + ' requeued=' + sandbox._daysRequeued.join(','));
  await vm.runInContext('doSyncTaskDay', sandbox)('2026-07-28');
  check('task insert: the note reaches the DB on the follow-up write',
    db.tasks[r._id] && db.tasks[r._id].note === 'ran short on jars',
    'db note=' + JSON.stringify(db.tasks[r._id] && db.tasks[r._id].note));
}

// ── 5. an untouched row is still never written by this tab ─────────────────
{
  const r = { _id: 't9', task: 'Prep', people: 2, packaged: 7, _dirty: new Set() };
  db.tasks.t9 = { id: 't9', packaged: 7, people: 2 };
  sandbox.lcEdits = { '2026-07-28': [r] };
  db.tasks.t9.people = 99;                           // another tab's edit
  await vm.runInContext('doSyncTaskDay', sandbox)('2026-07-28');
  check('clean row: this tab does not clobber another tab\'s value',
    db.tasks.t9.people === 99, 'db people=' + db.tasks.t9.people);
}

console.log('\n' + file);
ok.forEach(t => console.log('  PASS  ' + t));
bad.forEach(t => console.log('  FAIL  ' + t));
console.log(`  ${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
