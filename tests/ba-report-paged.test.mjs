// BA Field app (ba/index.html): the Reports page reads its trips, hours and expenses whole (2026-11-25, Gianni: "yes
// fix", after "Last 6 months" was found counting only the first 1,000 trips: the API answers at most 1,000 rows a
// request and says nothing about the rest). Runs the page's own readAll and selectExpensesAll in a vm over a stand-in
// that caps every request at 1,000 rows as PostgREST does. Synthetic rows only; nothing here reads a database.
//   node --test tests/ba-report-paged.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const between = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return html.slice(a, b); };
const fnText = name => { const a = html.indexOf(`async function ${name}(`); assert.ok(a >= 0, name); return html.slice(a, html.indexOf('\n}\n', a) + 2); };

// a PostgREST stand-in: gte/lte filters, order, range, at most 1,000 rows a request, the count when asked, and (o.noEvent)
// the error a select naming the expenses' event columns gets before supabase/ba-expense-events.sql is applied
function api(tables, o = {}) {
  const log = [];
  const from = table => {
    const st = { table, cols: '', count: false, f: [], order: [], range: null };
    const b = {
      select(cols, opts) { st.cols = cols; st.count = !!(opts && opts.count); return b; },
      gte(c, v) { st.f.push(r => r[c] >= v); return b; },
      lte(c, v) { st.f.push(r => r[c] <= v); return b; },
      order(c) { st.order.push(c); return b; },
      range(a, z) { st.range = [a, z]; return b; },
      then(res, rej) {
        log.push({ table, range: st.range && st.range.join('-') });
        if (o.noEvent && table === 'expenses' && /event_name/.test(st.cols)) return Promise.resolve({ data: null, error: { code: '42703', message: 'column expenses.event_name does not exist' } }).then(res, rej);
        let out = (tables[table] || []).filter(r => st.f.every(f => f(r)));
        const total = out.length;
        out = out.slice().sort((x, y) => { for (const c of st.order) { if (x[c] < y[c]) return -1; if (x[c] > y[c]) return 1; } return 0; });
        if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
        out = out.slice(0, 1000);
        return Promise.resolve({ data: out, error: null, count: st.count ? total : null }).then(res, rej);
      },
    };
    return b;
  };
  return { supabase: { from }, log };
}
const rows = (n, dateCol, amount) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, [dateCol]: `2026-${String(6 + (i % 5)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, amount }));
function sandbox(supabase) {
  const s = { supabase };
  vm.createContext(s);
  vm.runInContext(between('/* ── PAGED READS', '/* ── end PAGED READS ── */'), s);
  vm.runInContext(between("const EXP_EVENT_COLS =", '/* ─────────────────────────── helpers'), s);
  return s;
}

test('2,600 trips in range come back whole, a page of 1,000 at a time', async () => {
  const { supabase, log } = api({ trips: rows(2600, 'trip_date', 1) });
  const s = sandbox(supabase);
  const r = await vm.runInContext(`readAll(()=>supabase.from('trips').select('id,trip_date,amount', { count:'exact' }).gte('trip_date','2026-05-25').lte('trip_date','2026-11-25'), ['trip_date','id'])`, s);
  assert.equal(r.error, null);
  assert.equal(r.data.length, 2600);
  assert.equal(new Set(r.data.map(x => x.id)).size, 2600);
  assert.deepEqual(log.map(x => x.range), ['0-999', '1000-1999', '2000-2999']);
});

test('expenses: read whole, with or without the event columns', async () => {
  for (const noEvent of [false, true]) {
    const { supabase } = api({ expenses: rows(1500, 'expense_date', 3) }, { noEvent });
    const s = sandbox(supabase);
    const r = await vm.runInContext(`selectExpensesAll('id,expense_date,amount', q=>q.gte('expense_date','2026-05-25').lte('expense_date','2026-11-25'))`, s);
    assert.equal(r.error, null, String(noEvent));
    assert.equal(r.data.length, 1500, String(noEvent));
    assert.equal(vm.runInContext('expEventCols', s), !noEvent);
  }
});

test('the Reports page reads trips, hours and expenses only through the paged reads', () => {
  const body = fnText('adminReport');
  const reads = body.slice(0, body.indexOf('const dById'));
  assert.match(reads, /readAll\(\(\)=>supabase\.from\('trips'\)/);
  assert.match(reads, /readAll\(\(\)=>supabase\.from\('hours'\)/);
  assert.match(reads, /selectExpensesAll\(/);
  assert.doesNotMatch(reads.replace(/readAll\(\(\)=>supabase\.from\('(trips|hours)'\)/g, ''), /supabase\.from\('(trips|hours)'\)/);
  assert.doesNotMatch(reads, /selectExpenses\(/);
  assert.match(reads, /Some of this range didn\\'t load/);
});

test('the Reports date range is a type-to-search picker', () => {
  assert.match(html, /<select id="rpPreset" data-searchable>/);
  assert.match(between('function wireRangeControls(', 'function rangeLabel('), /searchifySelect\(ps, 'Date range'\)/);
});
