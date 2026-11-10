// pipeline-sheet-write: the Production Pipeline page's edits to Victoria's sheet (release 1a).
// The page (pipeline.html) builds each edit as ops (CONTRACT.md in this folder). This function checks them against
// the sheet as it is right now, writes them in one all-or-nothing batchUpdate with its own Google account
// (pipeline-writer: no roles, no domain-wide delegation; its JSON key is the PIPELINE_WRITER_KEY secret), reads the
// cells back, and logs the save in pipeline_edits so it can be undone. The rules (where it may write, finding a
// moved cell, carrying colored words) live in rules.js, shared with tests/pipeline-write-check.mjs.
// Self-contained like read-timesheet: it deploys from the repo root. Never the bookkeeping service account.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Rules from "./rules.js";

// rules.js is plain JS shared with node tests; its results are checked by hand below
// deno-lint-ignore no-explicit-any
const R: any = Rules;
// deno-lint-ignore no-explicit-any
type Any = any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const LOCK_SECONDS = 180;         // a save takes 1 to 3 seconds; a lock left by a crashed save expires by itself
const WRITE_BY_MS = 90_000;       // a save still checking this long after locking gives up, so it ends well inside its lock

// the page lives on GitHub Pages; localhost is for trying a change before pushing
const ORIGIN_OK = /^(https:\/\/claude759\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
function corsFor(req: Request): Record<string, string> {
  const o = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(o) ? o : "https://claude759.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// what the person who pressed Save reads (plain English, no em dashes); the rules' own messages are in rules.js
const SAY = {
  signedOut: "Sign in again to save changes to the sheet.",
  notEditor: "Your account can see the plan but cannot change the sheet from the app. Ask Gianni if you need to.",
  off: "Saving to the sheet from the app is switched off right now. Make the change in the sheet.",
  tabOff: (tab: string) => `Saving to the ${tab} tab from the app is not switched on yet. Make the change in the sheet.`,
  notSetUp: "Saving to the sheet from the app is not set up yet. Make the change in the sheet for now.",
  noCopy: "The test copy of the sheet is not set up yet, so nothing was saved.",
  noLive: "The app could not tell which sheet to save to, so nothing was saved. Tell Gianni.",
  noAccess: "The app's Google account cannot open the sheet, so nothing was saved. Ask Gianni to check it is shared with that account as an Editor.",
  badKey: "The app's Google account could not sign in, so nothing was saved. Tell Gianni.",
  google: "Google did not answer in time, so nothing was saved. Try again in a minute.",
  error: "Something went wrong, so nothing was saved. Try again in a minute, and tell Gianni if it keeps happening.",
  noLog: "The app could not record the change, so nothing was saved. Try again in a minute.",
  locked: (who: string) => `${who} is saving a change to the same cell right now, so nothing was saved. Wait a moment, reload, and try again.`,
  moved: "The sheet changed while saving, so nothing was saved. Reload the page and try again.",
  unsure: "Google did not confirm the save. Check the sheet before you try again.",
  mismatch: "Saved, but the sheet now reads differently from what was sent. Check the sheet.",
  unchecked: "Saved, but the app could not read the sheet back to check it. Check the sheet.",
  notInLog: "That change is not in the app's record, so it cannot be undone here.",
  notWritten: "Only a change that was saved to the sheet can be undone.",
  undone: "That change was already undone.",
};

class GoogleFail extends Error {
  step: string;
  status: number;
  constructor(step: string, status: number) { super(`google ${step} ${status}`); this.step = step; this.status = status; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nameOf = (email: unknown) => {
  const n = String(email ?? "").split("@")[0].replace(/[._-]+/g, " ").trim();
  return n ? n[0].toUpperCase() + n.slice(1) : "Someone else";
};

/* ---------- who is calling ---------- */

// the same gate as read-timesheet: a signed-in user with a CONFIRMED @wizardtrees.com email
async function staffCaller(req: Request) {
  const authz = req.headers.get("Authorization") ?? "";
  if (!authz.startsWith("Bearer ")) return null;
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authz } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  const u = data?.user;
  if (error || !u) return null;
  const email = (u.email ?? "").toLowerCase();
  const confirmed = Boolean(u.email_confirmed_at ?? (u as Any).confirmed_at);
  if (!confirmed || !email.endsWith("@wizardtrees.com")) return null;
  return { id: u.id, email, userClient };
}
type Who = NonNullable<Awaited<ReturnType<typeof staffCaller>>>;

/* ---------- Google ---------- */

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let cachedToken: { token: string; exp: number } | null = null;
// an RS256 JWT for the service account, swapped for an access token (cached while the instance is warm)
async function googleToken(rawKey: string): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  let sa: Any, key: CryptoKey;
  try {
    sa = JSON.parse(rawKey);
    const pem = String(sa.private_key ?? "").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (_) { throw new GoogleFail("token", 0); }   // never echo the key or why it did not parse
  const now = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = part({ alg: "RS256", typ: "JWT" }) + "." +
    part({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { await res.body?.cancel(); throw new GoogleFail("token", res.status); }
  const j = await res.json();
  cachedToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cachedToken.token;
}

// reads retry for a few seconds on Google's busy answers; never minutes later
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
async function gget(token: string, url: string): Promise<Any> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }); }
    catch (_) { res = null; }
    if (res?.ok) return await res.json();
    const status = res?.status ?? 0;
    await res?.body?.cancel();
    if (attempt >= 3 || (status && !TRANSIENT.has(status))) throw new GoogleFail("read", status);
    await sleep(400 * attempt + Math.random() * 200);
  }
}
const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const GRID_FIELDS = "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),merges," +
  "data(startRow,startColumn,rowMetadata(hiddenByUser,hiddenByFilter),rowData(values(userEnteredValue,formattedValue,textFormatRuns))))";
const tabsOf = (ops: Any[]) => [...new Set(ops.map((o) => o.tab))] as string[];

// Step 1: the tab's text only, to find which rows to read with formats: each op's week band on DISTRO PIPELINE
// (null = a supply tab, read whole).
async function readWindows(token: string, wb: string, ops: Any[]): Promise<Record<string, number[][] | null>> {
  const out: Record<string, number[][] | null> = {};
  await Promise.all(tabsOf(ops).map(async (tab) => {
    if (!R.TABS[tab].plan) { out[tab] = null; return; }
    const j = await gget(token, `${SHEETS}${wb}/values/${encodeURIComponent(quote(tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    const m = String(j.range ?? "").match(/![A-Z]+\d+:[A-Z]+(\d+)$/);
    out[tab] = R.windowsFor(R.gridFromValues(j.values ?? [], tab), ops.filter((o) => o.tab === tab), m ? Number(m[1]) : null);
  }));
  return out;
}
// Step 2: those rows with values, colored words, hidden flags and merges
async function readGrids(token: string, wb: string, windows: Record<string, number[][] | null>): Promise<Record<string, Any>> {
  const grids: Record<string, Any> = {};
  await Promise.all(Object.entries(windows).map(async ([tab, wins]) => {
    if (wins && !wins.length) { grids[tab] = R.gridFromSheet(null, tab); return; }   // week not in the sheet: plan() says so
    // an open end (Infinity) reads to the end of the sheet: "A640:N"
    const ranges = wins ? wins.map(([s, e]) => `${quote(tab)}!A${s + 1}:N${Number.isFinite(e) ? e : ""}`) : [quote(tab)];
    const j = await gget(token, `${SHEETS}${wb}?includeGridData=true&fields=${encodeURIComponent(GRID_FIELDS)}&` +
      ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&"));
    const sheet = (j.sheets ?? []).find((s: Any) => s?.properties?.title === tab);
    if (!sheet) throw new GoogleFail("tab", 404);
    grids[tab] = R.gridFromSheet(sheet, tab);
    if (wins && wins.some(([, e]) => !Number.isFinite(e))) grids[tab].toEnd = true;
  }));
  return grids;
}
// after the write: just the written cells
async function readBack(token: string, wb: string, cells: Any[]): Promise<Record<string, Any>> {
  const fields = "sheets(properties(sheetId,title),data(startRow,startColumn,rowMetadata(hiddenByUser)," +
    "rowData(values(userEnteredValue,formattedValue,textFormatRuns))))";
  const j = await gget(token, `${SHEETS}${wb}?includeGridData=true&fields=${encodeURIComponent(fields)}&` +
    cells.map((x) => "ranges=" + encodeURIComponent(`${quote(x.tab)}!${x.a1}`)).join("&"));
  const grids: Record<string, Any> = {};
  for (const s of j.sheets ?? []) grids[s.properties.title] = R.gridFromSheet(s, s.properties.title);
  return grids;
}
// One batchUpdate (Google applies all of it or none). 'ok', 'refused' (Google said no: nothing written) or
// 'unsure' (no clear answer: the caller reads the cells to find out), with Google's status.
type Sent = { result: "ok" | "refused" | "unsure"; status: number };
async function batchUpdate(token: string, wb: string, requests: Any[]): Promise<Sent> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`${SHEETS}${wb}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests, includeSpreadsheetInResponse: false }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (_) { return { result: "unsure", status: 0 }; }
    if (res.ok) { await res.body?.cancel(); return { result: "ok", status: res.status }; }
    const body = await res.text().catch(() => "");
    console.error("batchUpdate", res.status, body.slice(0, 300));
    if (res.status === 429 && attempt < 3) { await sleep(800 * attempt); continue; }   // rate limit: not applied
    return { result: res.status >= 500 ? "unsure" : "refused", status: res.status };
  }
}

/* ---------- Supabase ---------- */

async function loadSettings(admin: Any) {
  const { data, error } = await admin.from("pipeline_write_settings")
    .select("enabled,test_mode,target,test_workbook,tabs_on").eq("id", 1).maybeSingle();
  if (error) { console.error("settings", error.message); return null; }   // table not applied yet: treat as not set up
  return data;
}
async function workbookFor(admin: Any, target: string, settings: Any): Promise<string | null> {
  if (target === "test") return settings.test_workbook || null;
  const { data, error } = await admin.from("schedule_board").select("workbook_id").eq("state", "CA").limit(1);
  if (error) { console.error("schedule_board", error.message); return null; }
  return data?.[0]?.workbook_id || null;
}
async function logInsert(admin: Any, row: Any): Promise<number | null> {
  const { data, error } = await admin.from("pipeline_edits").insert(row).select("id").single();
  if (error) { console.error("log insert", error.message); return null; }
  return data.id;
}
async function logUpdate(admin: Any, id: number, patch: Any) {
  const { error } = await admin.from("pipeline_edits").update(patch).eq("id", id);
  if (error) console.error("log update", id, error.message);
}

/* ---------- one save ---------- */

// the reply's cells (the contract's shape) and the log's cells (with colored words, for undo)
const replyCells = (cells: Any[]) => cells.map((x) => ({ tab: x.tab, a1: x.a1, r: x.r, c: x.c,
  before: x.before.text, after: x.after.text, moved: x.moved }));
const logCells = (cells: Any[]) => cells.map((x) => ({ tab: x.tab, r: x.r, c: x.c, a1: x.a1, find: x.find, moved: x.moved,
  before: x.before, after: x.after }));
// what was asked, for a save that was refused or conflicted (with what the sheet holds, where known)
const askedCells = (ops: Any[], found: Any[] = []) => ops.map((op) => {
  const a1 = R.a1(op.r, op.c), f = found.find((x) => x.tab === op.tab && x.a1 === a1);
  return { tab: op.tab, r: op.r, c: op.c, a1, find: op.find, before: { text: op.expect }, after: { text: op.text },
    ...(f ? { found: f.found ?? null, why: f.why } : {}) };
});

type Job = { who: Who; admin: Any; action: "write" | "dry" | "undo"; intent: string; ops: Any[]; undoOf?: number; target?: string };

async function save(job: Job): Promise<Any> {
  const { who, admin, action, ops } = job;
  const bad = R.checkOps(ops);
  if (bad) return { ok: false, reason: "refused", message: bad };

  // 1. allowed to edit every tab touched (plan for DISTRO PIPELINE, supply for the supply tabs)
  for (const scope of new Set(ops.map((o) => R.TABS[o.tab].scope))) {
    const { data, error } = await who.userClient.rpc("pipeline_can_edit", { p_scope: scope });
    if (error) { console.error("pipeline_can_edit", error.message); return { ok: false, reason: "off", message: SAY.notSetUp }; }
    if (data !== true) return { ok: false, reason: "not-editor", message: SAY.notEditor };
  }

  // 2. switched on for these tabs (a dry run only reads); test mode plans without writing
  const settings = await loadSettings(admin);
  if (!settings) return { ok: false, reason: "off", message: SAY.notSetUp };
  if (action !== "dry") {
    if (!settings.enabled) return { ok: false, reason: "off", message: SAY.off };
    const tabOff = tabsOf(ops).find((t) => !(settings.tabs_on ?? []).includes(t));
    if (tabOff) return { ok: false, reason: "off", message: SAY.tabOff(tabOff) };
  }
  const dryRun = action === "dry" || settings.test_mode === true;
  const target = job.target ?? settings.target;
  const rawKey = Deno.env.get("PIPELINE_WRITER_KEY");
  if (!rawKey) return { ok: false, reason: "off", message: SAY.notSetUp };
  const wb = await workbookFor(admin, target, settings);
  if (!wb) return { ok: false, reason: "off", message: target === "test" ? SAY.noCopy : SAY.noLive };

  const base = { email: who.email, uid: who.id, intent: job.intent || null, action, target, undo_of: job.undoOf ?? null };
  const stopped = async (p: Any) => {
    await logInsert(admin, { ...base, status: p.reason, message: p.message, cells: askedCells(ops, p.cells) });
    return { ok: false, reason: p.reason, message: p.message, cells: p.reason === "conflict" ? p.cells.map((x: Any) =>
      ({ tab: x.tab, a1: x.a1, r: x.r, c: x.c, expect: x.expect, found: x.found ?? "", why: x.why ?? "changed" })) : undefined };
  };

  // 3-6. read the tab fresh and run every rule
  const token = await googleToken(rawKey);
  const windows = await readWindows(token, wb, ops);
  const first = R.plan(ops, await readGrids(token, wb, windows));
  if (!first.ok) return await stopped(first);
  if (dryRun) {
    const id = await logInsert(admin, { ...base, status: "dry", message: action === "dry" ? null : "Test mode: nothing written.",
      cells: logCells(first.cells) });
    return { ok: true, mode: action === "dry" ? "dry" : "test", target, wrote: false, edit: id,
      cells: replyCells(first.cells), requests: first.requests, ...(job.undoOf ? { undo_of: job.undoOf } : {}) };
  }

  // 7. lock the cells, then check again under the lock: a save that ran in between is seen here
  const keys = first.keys.map((k: string) => `${target}:${k}`), lockToken = crypto.randomUUID();
  const { data: lock, error: lockErr } = await admin.rpc("pipeline_lock_cells",
    { p_keys: keys, p_seconds: LOCK_SECONDS, p_email: who.email, p_token: lockToken });
  if (lockErr) throw new Error("lock: " + lockErr.message);
  if (!lock?.ok) return await stopped({ reason: "conflict", message: SAY.locked(nameOf(lock?.email)), cells: [] });
  const lockedAt = Date.now();
  try {
    const plan = R.plan(ops, await readGrids(token, wb, windows));
    if (!plan.ok) return await stopped(plan);
    if (plan.keys.join("|") !== first.keys.join("|")) return await stopped({ reason: "conflict", message: SAY.moved, cells: [] });

    // Google was slow enough that the lock could run out before the write lands: stop here, nothing written
    if (Date.now() - lockedAt > WRITE_BY_MS) return await stopped({ reason: "error", message: SAY.google, cells: [] });
    // 8. log first (so a save that dies halfway still leaves a trace), write once, read back, finish the log
    const id = await logInsert(admin, { ...base, status: "failed", message: "Started saving but did not finish. Check the sheet.",
      cells: logCells(plan.cells) });
    if (id == null) return { ok: false, reason: "error", message: SAY.noLog };
    const sent = await batchUpdate(token, wb, plan.requests);
    let back: Record<string, Any> | null = null;
    try { back = await readBack(token, wb, plan.cells); } catch (e) { console.error("read back", String(e)); }
    const check = back ? R.checkWritten(plan.cells, back) : { ok: false, wrong: [] };
    if (sent.result !== "ok") {
      // nothing written for sure, or Google gave no answer and the cells do not show the new text
      const landed = sent.result === "unsure" && back && check.ok;
      if (!landed) {
        const message = sent.result === "unsure" ? SAY.unsure : sent.status === 403 || sent.status === 404 ? SAY.noAccess : SAY.error;
        await logUpdate(admin, id, { status: "failed", message });
        return { ok: false, reason: "error", message };
      }
    }
    // what each cell holds now is what an undo must find there
    const wrongAt = new Set(check.wrong.map((w: Any) => `${w.tab}!${w.a1}`));
    const cells = plan.cells.map((x: Any) => {
      const g = back?.[x.tab], now = g ? R.cellAt(g, x.r, x.c) : null;
      if (!now || wrongAt.has(`${x.tab}!${x.a1}`)) return x;
      const v = now.value ?? {};
      return { ...x, after: { text: typeof v.stringValue === "string" ? v.stringValue : now.text, runs: now.runs,
        number: typeof v.numberValue === "number" ? v.numberValue : null } };
    });
    const note = check.ok ? null : back ? SAY.mismatch : SAY.unchecked;
    await logUpdate(admin, id, { status: "written", cells: logCells(cells), message: note });
    if (job.undoOf) {
      const { error } = await admin.from("pipeline_edits").update({ undone_by: id }).eq("id", job.undoOf).is("undone_by", null);
      if (error) console.error("mark undone", job.undoOf, error.message);
    }
    return { ok: true, mode: target === "live" ? "live" : "test", target, wrote: true, edit: id, cells: replyCells(cells),
      checked: check.ok, ...(note ? { message: note } : {}), ...(job.undoOf ? { undo_of: job.undoOf } : {}) };
  } finally {
    const { error } = await admin.rpc("pipeline_unlock_cells", { p_keys: keys, p_token: lockToken });
    if (error) console.error("unlock", error.message);
  }
}

// Undo: put back each cell of a written edit, only where the cell still holds what that edit wrote
async function undo(who: Who, admin: Any, id: unknown): Promise<Any> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: "refused", message: R.MSG.bad };
  // an editor of some tab first, so the log is not read for anyone else (save() then checks the edit's own tabs)
  let editor = false;
  for (const scope of ["plan", "supply"]) {
    const { data, error: e } = await who.userClient.rpc("pipeline_can_edit", { p_scope: scope });
    if (e) { console.error("pipeline_can_edit", e.message); return { ok: false, reason: "off", message: SAY.notSetUp }; }
    if (data === true) { editor = true; break; }
  }
  if (!editor) return { ok: false, reason: "not-editor", message: SAY.notEditor };
  const { data: edit, error } = await admin.from("pipeline_edits")
    .select("id,action,status,target,intent,cells,undone_by").eq("id", n).maybeSingle();
  if (error) throw new Error("undo read: " + error.message);
  if (!edit) return { ok: false, reason: "refused", message: SAY.notInLog };
  if (edit.action !== "write" || edit.status !== "written") return { ok: false, reason: "refused", message: SAY.notWritten };
  if (edit.undone_by) return { ok: false, reason: "refused", message: SAY.undone };
  return await save({ who, admin, action: "undo", intent: `Undo of change ${n}` + (edit.intent ? `: ${edit.intent}` : ""),
    ops: R.undoOps(edit), undoOf: n, target: edit.target });
}

// only the fields the contract names; never `restore`, which only undo() builds
function pageOps(raw: unknown): Any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x: Any) => {
    const f = x?.find ?? {};
    return { tab: x?.tab, r: x?.r, c: x?.c, expect: x?.expect, text: x?.text, number: x?.number ?? false,
      find: { week: f.week, day: f.day, owner: f.owner, item: f.item, category: f.category, header: f.header } };
  });
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // every answer is HTTP 200 with the contract's JSON, so the page reads one shape
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    if (req.method !== "POST") return reply({ ok: false, reason: "refused", message: R.MSG.bad });
    const who = await staffCaller(req);
    if (!who) return reply({ ok: false, reason: "signed-out", message: SAY.signedOut });
    let body: Any;
    try { body = await req.json(); } catch (_) { return reply({ ok: false, reason: "refused", message: R.MSG.bad }); }
    const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
    const action = body?.action;
    if (action === "undo") return reply(await undo(who, admin, body.undo));
    if (action !== "write" && action !== "dry") return reply({ ok: false, reason: "refused", message: R.MSG.bad });
    const intent = typeof body.intent === "string" ? body.intent.slice(0, 500) : "";
    return reply(await save({ who, admin, action, intent, ops: pageOps(body.ops) }));
  } catch (e) {
    console.error("pipeline-sheet-write", String((e as Error)?.message ?? e));
    if (e instanceof GoogleFail)
      return reply({ ok: false, reason: "error",
        message: e.step === "token" ? SAY.badKey : e.status === 403 || e.status === 404 ? SAY.noAccess : SAY.google });
    return reply({ ok: false, reason: "error", message: SAY.error });
  }
});
