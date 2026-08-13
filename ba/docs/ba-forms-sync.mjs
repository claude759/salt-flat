#!/usr/bin/env node
// Sync the "WIZARD TREES RETAILER VISIT FORM (Responses)" sheet into public.ba_activity.
//
// Why a sync (not a live read): the sheet is org-restricted, so browsers can't read it —
// and the app needs to ask questions the sheet can't answer ("which scheduled visits have
// NO response?"). One row per submission, idempotent on (source, source_key).
//
// Store resolution goes through the CENTRAL REGISTRY (dispensaries: name / sales_key is
// deliberately skipped — it's many-to-one per billing account / pistil_name / aliases),
// so a response lands on the same store the schedule and Pistil use. Unresolved rows are
// kept with dispensary_id NULL and reported — the fix is an alias on the registry row,
// never a guess here.
//
//   node sync.mjs            # sync
//   node sync.mjs --dry-run  # parse + match, write nothing
//   node sync.mjs --report   # print unmatched store strings and exit
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';

const SHEET_ID = process.env.FORMS_SHEET_ID || '1NfQxErlPypzZhJD2m3-VDVfBTUnf5ACGbFGhBSRT2u8';
const TABS = ['Form Responses 1', 'NY RESPONSES'];
const SA_KEY = process.env.GOOGLE_SA_KEY || '/Users/giannilane/bookkeeping-automation/secrets/gmail-sa.json';
const SB_URL = process.env.SUPABASE_URL || 'https://dhiqhgtmelxwelyoowle.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_FtScmtn1C0tE1bwUsavJFg_koiVEu14';
const has = (f) => process.argv.includes(f);
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ── sheet ─────────────────────────────────────────────────────────────── */
async function readSheet() {
  const key = JSON.parse(readFileSync(SA_KEY, 'utf8'));
  const auth = new google.auth.JWT({
    email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  const out = [];
  for (const tab of TABS) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:Z5000` });
    const rows = r.data.values || [];
    rows.slice(1).forEach((row) => { if (row && row[0]) out.push({ tab, row }); });
  }
  return out;
}

/* ── supabase ──────────────────────────────────────────────────────────── */
async function login() {
  const email = process.env.AUTOMATION_EMAIL, password = process.env.AUTOMATION_PASSWORD;
  if (!email || !password) throw new Error('AUTOMATION_EMAIL/PASSWORD required (same creds gusto-sync uses)');
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('automation login failed: ' + JSON.stringify(j).slice(0, 160));
  return j.access_token;
}
async function rest(jwt, pathq, opts = {}) {
  const r = await fetch(`${SB_URL}${pathq}`, {
    ...opts, headers: { apikey: SB_ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${pathq.split('?')[0]} → ${r.status} ${text.slice(0, 220)}`);
  return text ? JSON.parse(text) : null;
}

/* ── parsing ───────────────────────────────────────────────────────────── */
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
// The date lives inside a free-text answer ("Wednesday March 11, 2026 Time 11:58am-2:05pm",
// "12-2pm", "3/11/26"). Fall back to the submission date, which is never blank.
export function parseVisitDate(answer, timestamp) {
  const t = String(answer || '');
  const stamp = String(timestamp || '').match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const fromStamp = stamp ? `${stamp[3]}-${String(+stamp[1]).padStart(2, '0')}-${String(+stamp[2]).padStart(2, '0')}` : null;
  // Typed dates carry typos ("7/23/2925", a year in the 1900s). Only trust one that
  // lands in a plausible window AND isn't wildly far from when the form was submitted.
  const sane = (iso) => {
    if (!iso) return null;
    const y = +iso.slice(0, 4), now = new Date().getFullYear();
    if (y < 2023 || y > now + 1) return null;
    if (fromStamp && Math.abs(new Date(iso) - new Date(fromStamp)) > 120 * 864e5) return null;
    return iso;
  };
  let m = t.match(new RegExp(`(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})`, 'i'));
  if (m) { const iso = sane(`${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`); if (iso) return iso; }
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const iso = sane(`${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`); if (iso) return iso; }
  return fromStamp;
}
export function normStore(s) {
  return String(s || '')
    .replace(/\s*\[[^\]]*\]\s*$/, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/\((rec|med)\.?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|the|dispensary|cannabis|co)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function ratio(a, b) {                      // tiny Dice-coefficient on bigrams
  if (a === b) return 1;
  const g = (s) => { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
  const A = g(a), B = g(b); if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
// name / pistil_name / aliases only — sales_key is a BILLING key shared by every branch
// of a chain, so matching on it would scatter responses across the wrong stores.
export function buildIndex(disp) {
  const idx = new Map();
  for (const d of disp) for (const c of [d.name, d.pistil_name, ...(d.aliases || [])]) {
    const k = normStore(c); if (!k) continue;
    if (!idx.has(k)) idx.set(k, []); if (!idx.get(k).some((x) => x.id === d.id)) idx.get(k).push(d);
  }
  return idx;
}
export function matchStore(raw, state, disp, idx) {
  const tries = [raw]; if (raw.includes(',')) tries.push(raw.split(',')[0]);
  for (const t of tries) {
    const hits = (idx.get(normStore(t)) || []).filter((d) => !state || !d.state || d.state === state);
    if (hits.length === 1) return { d: hits[0], how: 'exact' };
    if (hits.length > 1) return { d: null, how: 'ambiguous', candidates: hits.map((h) => h.name) };
  }
  let best = null, bs = 0;
  for (const t of tries) {
    const k = normStore(t); if (!k) continue;
    for (const d of disp) {
      if (state && d.state && d.state !== state) continue;
      for (const c of [d.name, d.pistil_name, ...(d.aliases || [])]) {
        const nk = normStore(c); if (!nk) continue;
        const s = ratio(k, nk);
        if (s > bs) { bs = s; best = d; }
      }
    }
  }
  return bs >= 0.9 ? { d: best, how: 'fuzzy', score: bs } : { d: null, how: 'unmatched', near: best && best.name, score: +bs.toFixed(2) };
}

/* ── main ──────────────────────────────────────────────────────────────── */
const C = { ts: 0, rep: 1, store: 2, when: 3, activities: 4, promo: 5, aged: 6, presence: 7,
            manager: 8, photos: 9, state: 10, traffic: 11, units: 12, stock: 13, connected: 14, next: 15, email: 16 };

async function main() {
  const jwt = await login();
  const disp = await rest(jwt, '/rest/v1/dispensaries?select=id,name,pistil_name,aliases,state&active=eq.true&private=eq.false&retail=eq.true');
  const idx = buildIndex(disp);
  log(`registry: ${disp.length} stores`);

  const raw = await readSheet();
  log(`sheet: ${raw.length} responses`);

  const rows = [], unmatched = new Map();
  for (const { tab, row } of raw) {
    const g = (i) => (row[i] ?? '').toString().trim();
    const state = /california/i.test(g(C.state)) ? 'CA' : /new york/i.test(g(C.state)) ? 'NY' : (tab.startsWith('NY') ? 'NY' : 'CA');
    const store = g(C.store);
    const m = store ? matchStore(store, state, disp, idx) : { d: null, how: 'blank' };
    if (!m.d && store) unmatched.set(`${store}|${state}`, (unmatched.get(`${store}|${state}`) || 0) + 1);
    rows.push({
      source: 'form',
      source_key: [g(C.ts), g(C.rep), store].join('|').slice(0, 300),
      submitted_at: (() => { const d = new Date(g(C.ts)); return isNaN(d) ? null : d.toISOString(); })(),
      visit_date: parseVisitDate(g(C.when), g(C.ts)),
      rep_name: g(C.rep) || null, rep_email: g(C.email) || null, state,
      store_raw: store || null, dispensary_id: m.d ? m.d.id : null,
      activities: g(C.activities) || null, promo: g(C.promo) || null, aged_product: g(C.aged) || null,
      brand_presence: g(C.presence) || null, manager: g(C.manager) || null, photos: g(C.photos) || null,
      traffic: g(C.traffic) || null, est_units: g(C.units) || null, stock_status: g(C.stock) || null,
      connected_with: g(C.connected) || null, next_steps: g(C.next) || null,
      raw: { tab, when: g(C.when) },
    });
  }
  const matched = rows.filter((r) => r.dispensary_id).length;
  log(`parsed ${rows.length} · store matched ${matched} (${Math.round(matched / rows.length * 100)}%) · unresolved ${rows.length - matched}`);

  if (has('--report') || has('--dry-run')) {
    [...unmatched.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${String(n).padStart(3)}x ${k}`));
    if (has('--report')) return;
  }
  if (has('--dry-run')) { log('dry run — nothing written'); return; }

  // upsert in chunks; unique(source, source_key) makes re-runs idempotent and lets a
  // corrected sheet row (same submission) refresh its parsed fields
  for (let i = 0; i < rows.length; i += 200) {
    await rest(jwt, '/rest/v1/ba_activity?on_conflict=source,source_key', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
    log(`  upserted ${Math.min(i + 200, rows.length)}/${rows.length}`);
  }
  log('done.');
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
