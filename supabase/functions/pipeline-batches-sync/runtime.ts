// runtime.ts: the Deno side shared by the Production Pipeline sync functions (pipeline-marks-sync, pipeline-trims-sync,
// pipeline-batches-sync): who may call, the overlap guard, Google reads with pipeline-writer's key and READ-ONLY scopes,
// and the database calls. Each function deploys on its own, so each folder carries an identical copy of this file;
// tests/pipeline-sync-check.mjs fails if the copies differ, and runs this file in node with a fake Google and a fake
// database. The job's own work (parsing, when to write, shadow comparisons) is in job.js.
//
// Callers: the pg_cron job (header x-pipeline-sync, checked against the hash in pipeline_sync_secret; see
// supabase/postgres/pipeline-sync-cron.sql), or a signed-in pipeline admin (pipeline_sync_can_admin()), for example to
// run a compare-only pass now: POST {"mode": "shadow", "wait": true}. Deployed with --no-verify-jwt, since the cron job
// sends a secret, not a JWT. What the job does (off, shadow or write) and which Drive file or folder it reads come from
// pipeline_sync_settings, never from the repo. Shadow mode reads and compares; the database refuses its writes.
// Never the bookkeeping service account: Google is read as pipeline-writer (secret PIPELINE_WRITER_KEY).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createHash } from "node:crypto";
import { forLog, sha256Hex } from "./core.js";

// deno-lint-ignore no-explicit-any
type Any = any;

const env = (k: string) => Deno.env.get(k) ?? "";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_HOPS = 4;   // follow-up runs one run may start in a row (a big trims change parsed over several runs)

// a pipeline admin's page may call it from GitHub Pages; localhost is for trying a change before pushing
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- Google, read-only ---------- */

const STEP: Record<string, string> = {
  token: "sign in with the app's Google account (pipeline-writer)", meta: "read the file's details", list: "list the folder",
  download: "download the file", export: "export the sheet", grid: "read the sheet",
};
class GoogleFail extends Error {
  step: string;
  status: number;
  constructor(step: string, status: number) {
    const hint = status === 403 || status === 404 ? ": pipeline-writer cannot open it, share it with that account as Viewer" : "";
    super(`Google: could not ${STEP[step] ?? step} (HTTP ${status})${hint}`);
    this.step = step;
    this.status = status;
  }
}
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const tokens = new Map<string, { token: string; exp: number }>();
// an RS256 JWT for pipeline-writer with only the scopes asked for, swapped for an access token (cached while warm)
async function googleToken(scope: string): Promise<string> {
  const hit = tokens.get(scope);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  let sa: Any, key: CryptoKey;
  try {
    sa = JSON.parse(env("PIPELINE_WRITER_KEY"));
    const pem = String(sa.private_key ?? "").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (_) { throw new GoogleFail("token", 0); }   // never echo the key or why it did not parse
  const now = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = part({ alg: "RS256", typ: "JWT" }) + "." +
    part({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned)));
  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) { throw new GoogleFail("token", 0); }
  if (!res.ok) { await res.body?.cancel(); throw new GoogleFail("token", res.status); }
  const j = await res.json();
  tokens.set(scope, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}
// a GET that retries for a few seconds on Google's busy answers
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
async function gget(step: string, scope: string, url: string, timeoutMs = 30000): Promise<Response> {
  const token = await googleToken(scope);
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (_) { res = null; }
    if (res?.ok) return res;
    const status = res?.status ?? 0;
    await res?.body?.cancel();
    if (attempt >= 3 || (status && !TRANSIENT.has(status))) throw new GoogleFail(step, status);
    await sleep(500 * attempt + Math.random() * 250);
  }
}

/* ---------- the database ---------- */

async function rpc(client: Any, fn: string, args: Any): Promise<Any> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// what job.js may do: read Google (read-only), write through pipeline_sync_apply (refused unless this run holds the
// job in write mode), read the table for a comparison
function ioFor(job: Any, deps: Any, admin: Any, claim: Any) {
  const scope = String(job.SCOPES);
  const json = async (step: string, url: string, ms?: number) => await (await gget(step, scope, url, ms)).json();
  return {
    XLSX: deps.XLSX,
    now: () => performance.now(),
    today: () => new Date().toISOString().slice(0, 10),
    sha256: sha256Hex,
    driveMeta: (id: string, fields: string) =>
      json("meta", `${DRIVE}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`),
    listFolder: async (folder: string) => {
      const out: Any[] = [];
      const q = encodeURIComponent(`'${String(folder).replace(/[^A-Za-z0-9_-]/g, "")}' in parents and trashed=false`);
      const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)");
      let page = "";
      for (let n = 0; n < 10; n++) {
        const j = await json("list", `${DRIVE}?q=${q}&fields=${fields}&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100` +
          (page ? `&pageToken=${encodeURIComponent(page)}` : ""));
        out.push(...(j.files ?? []));
        if (!j.nextPageToken) break;
        page = j.nextPageToken;
      }
      return out;
    },
    download: async (f: Any) => {
      const res = await gget("download", scope, `${DRIVE}/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`, 60000);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (f.md5Checksum && createHash("md5").update(bytes).digest("hex") !== f.md5Checksum) throw new Error(`download md5 mismatch for ${f.name}`);
      return bytes;
    },
    exportXlsx: async (id: string) => new Uint8Array(await (await gget("export", scope,
      `${DRIVE}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`, 60000)).arrayBuffer()),
    sheetGrid: (id: string, tab: string, fields: string) => json("grid",
      `${SHEETS}${encodeURIComponent(id)}?ranges=${encodeURIComponent(`'${tab}'`)}&includeGridData=true&fields=${encodeURIComponent(fields)}`, 60000),
    apply: (rows: Any, meta: Any) => rpc(admin, "pipeline_sync_apply", { p_job: job.JOB, p_token: claim.token, p_rows: rows, p_meta: meta }),
    live: () => rpc(admin, "pipeline_sync_live", { p_job: job.JOB }),
  };
}

/* ---------- who is calling ---------- */

type Caller = { kind: "cron" | "admin"; label: string; forward: Record<string, string> };
async function callerOf(req: Request, admin: Any): Promise<Caller | null> {
  const secret = req.headers.get("x-pipeline-sync") ?? "";
  if (secret) {
    const ok = await rpc(admin, "pipeline_sync_check_secret", { p_secret: secret });
    return ok === true ? { kind: "cron", label: "cron", forward: { "x-pipeline-sync": secret } } : null;
  }
  // a signed-in pipeline admin with a confirmed @wizardtrees.com email (the same gate as pipeline-sheet-write)
  const authz = req.headers.get("Authorization") ?? "";
  if (!authz.startsWith("Bearer ")) return null;
  const userClient = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authz } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  const u = data?.user;
  if (error || !u) return null;
  const email = String(u.email ?? "").toLowerCase();
  if (!(u.email_confirmed_at ?? u.confirmed_at) || !email.endsWith("@wizardtrees.com")) return null;
  const { data: ok, error: e2 } = await userClient.rpc("pipeline_sync_can_admin");
  if (e2 || ok !== true) return null;
  return { kind: "admin", label: email, forward: { Authorization: authz } };
}

/* ---------- one run ---------- */

async function runClaimed(job: Any, deps: Any, admin: Any, claim: Any, caller: Caller, hop: number, forced: boolean): Promise<Any> {
  const t0 = Date.now();
  let report: Any;
  try {
    report = await job.run(ioFor(job, deps, admin, claim), { mode: claim.mode, state: claim.state ?? {}, sourceId: claim.source_id ?? null });
  } catch (e) {
    report = { status: "error", error: String((e as Error)?.message ?? e).slice(0, 1000) };
  }
  report.ms = Date.now() - t0;
  report.mode = claim.mode;
  if (hop) report.hop = hop;
  // release the job and log the run (an error keeps the last good state, so the next run starts from it)
  let released = false;
  try {
    const fin = await rpc(admin, "pipeline_sync_finish", {
      p_job: job.JOB, p_token: claim.token, p_report: forLog(report), p_state: report.status === "error" ? {} : (report.state ?? {}),
    });
    released = fin?.mine === true;
  } catch (e) { console.error(job.FUNCTION, "finish", String((e as Error)?.message ?? e)); }
  // counts only: the run log in the database holds the rest
  const d = report.diff;
  console.log(`${job.FUNCTION} ${claim.mode} ${report.status}` + (report.rows != null ? ` rows=${report.rows}` : "") +
    (d ? ` diff +${d.added} -${d.removed} ~${d.changed}` : "") + ` ${report.ms}ms`);
  // part of the work is left (trims: more changed workbooks than one run's CPU allows): a follow-up run takes it
  if (report.continue && released && hop < MAX_HOPS) {
    try {
      const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/${job.FUNCTION}`, {
        method: "POST",
        headers: { ...caller.forward, "Content-Type": "application/json" },
        body: JSON.stringify({ hop: hop + 1, ...(forced ? { mode: "shadow" } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      await res.body?.cancel();
    } catch (e) { console.error(job.FUNCTION, "follow-up run", String((e as Error)?.message ?? e)); }
  }
  return forLog(report);
}

export async function handle(job: Any, deps: Any, req: Request): Promise<Response> {
  const cors = corsFor(req);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { ok: false, reason: "post-only" });
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
    const caller = await callerOf(req, admin);
    if (!caller) return reply(401, { ok: false, reason: "not-allowed" });
    let body: Any = {};
    try { body = await req.json(); } catch (_) { body = {}; }
    const forced = body?.mode === "shadow";
    const hop = Math.max(0, Math.min(MAX_HOPS, Math.floor(Number(body?.hop) || 0)));
    // the overlap guard: one run per job at a time; 'off' and 'busy' answer at once
    const claim = await rpc(admin, "pipeline_sync_claim",
      { p_job: job.JOB, p_stale_seconds: job.STALE_SECONDS, p_by: caller.label, p_force_shadow: forced });
    if (!claim?.ok) return reply(200, { ok: true, job: job.JOB, skipped: claim?.reason ?? "unknown" });
    const work = runClaimed(job, deps, admin, claim, caller, hop, forced);
    if (body?.wait === true) return reply(200, await work);
    // answer the cron job at once and finish in the background (pg_net does not wait long)
    const rt = (globalThis as Any).EdgeRuntime;
    if (rt?.waitUntil) { rt.waitUntil(work); return reply(202, { ok: true, job: job.JOB, mode: claim.mode, started: true }); }
    return reply(200, await work);
  } catch (e) {
    console.error(job.FUNCTION, String((e as Error)?.message ?? e));
    return reply(500, { ok: false, reason: "error" });
  }
}

export function serveJob(job: Any, deps: Any = {}) {
  addEventListener("beforeunload", (ev: Any) => console.log(`${job.FUNCTION}: worker stopping (${ev?.detail?.reason ?? "unknown"})`));
  Deno.serve((req: Request) => handle(job, deps, req));
}
