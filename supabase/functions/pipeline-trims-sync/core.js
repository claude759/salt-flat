// core.js: the pure helpers shared by the Production Pipeline sync functions (pipeline-marks-sync, pipeline-trims-sync,
// pipeline-batches-sync). Each function deploys on its own, so each folder carries an identical copy of this file;
// tests/pipeline-sync-check.mjs fails if the copies differ. Plain JS with no imports, so the node check loads it as is.

// How a shadow run compares what it read with what the table holds now: rows matched by key, each field compared the
// way the table stores it (the save functions' casts and coalesces), so 1 and "1", or null and false for a flag, are
// not counted as differences. A spec names the key fields and each field's kind:
//   int, num (numeric or null), num0 (numeric, null means 0), bool0 (null means false), text, date (YYYY-MM-DD).
export const SAMPLE = 12;

export function canon(kind, v) {
  if (v === undefined) v = null;
  switch (kind) {
    case 'int':
    case 'num':
    case 'num0': {
      if (v === null || v === '') return kind === 'num0' ? 0 : null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : String(v);
    }
    case 'bool0':
      return v === true || v === 'true';
    case 'date':
      return v === null || v === '' ? null : String(v).slice(0, 10);
    default:
      return v === null ? null : String(v);
  }
}

const keyOf = (spec, r) => spec.key.map((f) => String(canon(spec.fields[f], r[f]))).join('|');

// next: the rows this run read; live: the rows in the table. Counts plus a small sample of what differs.
export function diffRows(next, live, spec) {
  const A = new Map(), B = new Map();
  let dup = 0;
  for (const r of next || []) { const k = keyOf(spec, r); if (A.has(k)) dup++; A.set(k, r); }
  for (const r of live || []) B.set(keyOf(spec, r), r);
  const out = { next: A.size, live: B.size, added: 0, removed: 0, changed: 0, same: 0, dup, sample: [] };
  const note = (x) => { if (out.sample.length < SAMPLE) out.sample.push(x); };
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) { out.added++; note({ key: k, what: 'added' }); continue; }
    const fields = {};
    for (const [f, kind] of Object.entries(spec.fields)) {
      const x = canon(kind, b[f]), y = canon(kind, a[f]);
      if (x !== y) fields[f] = [x, y];
    }
    if (Object.keys(fields).length) { out.changed++; note({ key: k, what: 'changed', fields }); } else out.same++;
  }
  for (const k of B.keys()) if (!A.has(k)) { out.removed++; note({ key: k, what: 'removed' }); }
  out.ok = !out.added && !out.removed && !out.changed && !dup;
  return out;
}

// two timestamps name the same moment ("2026-11-11T18:18:37.208Z" from Drive, "...+00:00" from Postgres)
export function sameInstant(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const x = Date.parse(String(a)), y = Date.parse(String(b));
  return Number.isFinite(x) && x === y;
}

// JSON with every object's keys sorted, so the same rows give the same text whatever order their keys came in. Rows
// kept in a jsonb column (pipeline_sync_state.cache) come back with their keys reordered, shorter keys first, while
// freshly read rows keep the parser's order: sign rows with this, never with plain JSON.stringify.
export function stableJson(v) {
  if (v && typeof v.toJSON === 'function') v = v.toJSON();
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : stableJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// sha256 hex of a string, as the Mac jobs sign their rows (createHash('sha256').update(JSON.stringify(rows)))
export async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// what goes into the run log: counts and the diff, never the rows themselves or the cache
export function forLog(report) {
  const { state: _state, rowsOut: _rows, continue: _c, ...rest } = report || {};
  return rest;
}
