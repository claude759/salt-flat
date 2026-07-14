// read-timesheet: read a paper time-sheet photo from Storage, return structured
// shift rows. The tracker uploads the image to the private 'timesheets' bucket,
// then calls this with its path. Self-contained (no _shared import) because it
// deploys from the repo root while the BA functions deploy from ba/.
//
// Caller gate mirrors the tracker's is_staff(): a signed-in user with a
// CONFIRMED @wizardtrees.com email. (Tracker staff have no BA `profiles` row,
// so the BA caller() helper doesn't apply here.)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "timesheets"; // pinned — never trust a client-supplied bucket

const OCR_INSTRUCTION =
  'You are reading a photo of a paper EMPLOYEE TIME SHEET (a sign-in sheet). It has a title header ' +
  'naming a company/LLC, then a table: LAST NAME | FIRST NAME | DATE | TIME IN | TIME OUT | LUNCH | SIGNATURE.\n' +
  'Return ONLY a JSON object, no prose:\n' +
  '{"company": string|null, "sheet_date": "YYYY-MM-DD"|null, "rows": [{"last": string|null, "first": string|null, ' +
  '"date": "YYYY-MM-DD"|null, "time_in": "HH:MM"|null, "time_out": "HH:MM"|null, "break_minutes": number|null}]}\n' +
  '- company: from the TITLE header, usually Filifera/Slane/Portal (drop ", LLC" + license numbers).\n' +
  '- Ignore the SIGNATURE column. One object per named data row; skip blanks + the header.\n' +
  '- 24-hour "HH:MM"; infer AM/PM from an 8am-6pm workday ("8:00" in = 08:00, "5:00" out = 17:00).\n' +
  '- CARRY-DOWN: a ditto mark ("), a blank cell inside a bracket, or a vertical line/brace/arrow drawn ' +
  'down a column all mean "same value as the row above". Apply the carried value to EVERY row the mark ' +
  'or line spans - this applies to TIME IN, TIME OUT, LUNCH and DATE alike. Only leave a value null when ' +
  'the cell is truly empty with no mark or line through it.\n' +
  '- break_minutes from the LUNCH column: "12-1" = 60; "12-12:30" = 30; blank with no mark = 0.\n' +
  '- ONE SHEET = ONE DAY: every row on the sheet is the same work date. Determine the sheet date from the ' +
  'clearest/majority DATE entry (assume 2026 if no year; ignore an obviously miswritten outlier) and use ' +
  'it for sheet_date AND for every row date.\n' +
  '- Preserve names exactly as handwritten.';

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
  const confirmed = Boolean(u.email_confirmed_at ?? (u as any).confirmed_at);
  if (!confirmed || !email.endsWith("@wizardtrees.com")) return null;
  return u;
}

function parseJsonLoose(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* ignore */ } }
  return null;
}
const cleanCompany = (c: unknown) => {
  if (typeof c !== "string") return null;
  const s = c.replace(/,?\s*LLC.*$/i, "").trim();
  for (const k of ["Filifera", "Slane", "Portal"]) if (s.toLowerCase().includes(k.toLowerCase())) return k;
  return s || null;
};
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const cleanTime = (v: unknown) => {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return m[1].padStart(2, "0") + ":" + m[2];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const who = await staffCaller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { path } = await req.json();
    if (!path || String(path).includes("..")) return json({ ok: false, error: "path required" }, 400);
    if (!Deno.env.get("ANTHROPIC_API_KEY"))
      return json({ ok: false, error: "ocr_unavailable", message: "Enter the rows manually." }, 200);

    const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(String(path));
    if (dlErr || !blob) return json({ ok: false, error: "download failed: " + (dlErr?.message ?? "no data") }, 400);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const mime = blob.type?.startsWith("image/") ? blob.type
      : (String(path).toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

    const key = Deno.env.get("ANTHROPIC_API_KEY")!;
    const model = Deno.env.get("OCR_MODEL") ?? "claude-opus-4-8";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 3000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mime, data: encodeBase64(buf) } },
          { type: "text", text: OCR_INSTRUCTION },
        ] }],
      }),
    });
    if (!res.ok) return json({ ok: false, error: `anthropic ${res.status}` }, 502);
    const data = await res.json();
    const text = (data?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
    const parsed = parseJsonLoose(text) ?? {};

    const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).map((r: any) => {
      const last = typeof r?.last === "string" ? r.last.trim() : null;
      const first = typeof r?.first === "string" ? r.first.trim() : null;
      if (!last && !first) return null;
      const brk = Number(r?.break_minutes);
      return {
        last, first,
        date: isDate(r?.date) ? r.date : null,
        time_in: cleanTime(r?.time_in),
        time_out: cleanTime(r?.time_out),
        break_minutes: Number.isFinite(brk) && brk >= 0 && brk <= 480 ? Math.round(brk) : 0,
      };
    }).filter(Boolean);

    return json({
      ok: true,
      company: cleanCompany(parsed.company),
      sheet_date: isDate(parsed.sheet_date) ? parsed.sheet_date : null,
      rows,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
