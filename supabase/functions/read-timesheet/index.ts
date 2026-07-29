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
  'You are reading a photo or PDF of a paper EMPLOYEE TIME SHEET / sign-in sheet. It has a title header ' +
  '(a company/LLC such as Filifera/Slane/Portal, or a location/crew name such as "New York — Temp Crew ' +
  'Sign In"), often a "Date:" field near the top, then a numbered table: ' +
  '# | LAST NAME | FIRST NAME | DATE | TIME IN | TIME OUT | LUNCH | SIGNATURE.\n' +
  'Return ONLY a JSON object, no prose:\n' +
  '{"company": string|null, "sheet_date": "YYYY-MM-DD"|null, "rows": [{"last": string|null, "first": string|null, ' +
  '"date": "YYYY-MM-DD"|null, "time_in": "HH:MM"|null, "time_out": "HH:MM"|null, "break_minutes": number|null}]}\n' +
  '- company: from the TITLE header ONLY when it names a company/LLC (drop ", LLC" + license numbers); if ' +
  'the title is only a location or crew name, set company to null.\n' +
  '- Ignore the leading "#" row-number column and the SIGNATURE column. One object per NAMED data row; ' +
  'skip rows with no name written, and skip the header.\n' +
  '- 24-hour "HH:MM"; infer AM/PM from an 8am-6pm workday ("8:00" in = 08:00, "5:00" out = 17:00).\n' +
  '- CARRY-DOWN: a ditto mark ("), a blank cell inside a bracket, or a vertical line/brace/arrow drawn ' +
  'down a column all mean "same value as the row above". Apply the carried value to EVERY row the mark ' +
  'or line spans - this applies to TIME IN, TIME OUT, LUNCH and DATE alike. Only leave a value null when ' +
  'the cell is truly empty with no mark or line through it.\n' +
  '- break_minutes from the LUNCH column, which appears in THREE shapes:\n' +
  '    (a) a RANGE — "12-1" = 60; "12:33 - 1:07" = 34; "12-12:30" = 30.\n' +
  '    (b) a DURATION — "30" = 30; "1 hr" = 60.\n' +
  '    (c) a START TIME ONLY — "12:33". This crew takes lunch together and often writes the full\n' +
  '        range on the FIRST row only (sometimes cramped, spilling above the row or into the\n' +
  '        header), then just the start time on the rest. So when a cell holds only a start time,\n' +
  '        find the most complete lunch entry ANYWHERE on the sheet and apply ITS duration.\n' +
  '        Example: row 1 "12:33 - 1:07" and rows 2-8 "12:33" means EVERY row is 34 minutes.\n' +
  '  A cell that is genuinely blank with no mark = 0. But a start time you cannot resolve to a\n' +
  '  duration is NOT 0 — return null so a human checks it, because a wrongly-zeroed lunch\n' +
  '  overstates paid hours for every person on the sheet.\n' +
  '- ONE SHEET = ONE DAY: every row on the sheet is the same work date. Use the top "Date:" field if it is ' +
  'filled in; otherwise the clearest/majority DATE-column entry (assume the year is {{YEAR}} if none is ' +
  'written; ignore an obviously miswritten outlier). Use it for sheet_date AND for every row date.\n' +
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
    const lower = String(path).toLowerCase();
    // NY sign-in sheets arrive as PDFs; CA sheets as photos. A PDF goes to Claude
    // as a `document` block (media_type application/pdf); an image as an `image`
    // block. Either way the OCR instruction is the same.
    const isPdf = blob.type === "application/pdf" || lower.endsWith(".pdf");
    const b64 = encodeBase64(buf);
    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64",
          media_type: blob.type?.startsWith("image/") ? blob.type : (lower.endsWith(".png") ? "image/png" : "image/jpeg"),
          data: b64 } };

    const key = Deno.env.get("ANTHROPIC_API_KEY")!;
    const model = Deno.env.get("OCR_MODEL") ?? "claude-opus-4-8";
    // pin the "no year written" fallback to the real current year, deterministically —
    // never let the model guess a year from its training prior (that put rows in 2025).
    const instruction = OCR_INSTRUCTION.replace("{{YEAR}}", String(new Date().getFullYear()));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 3000,
        messages: [{ role: "user", content: [
          contentBlock,
          { type: "text", text: instruction },
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
      // null must SURVIVE here. Number(null) is 0, so the old coercion turned "I could not
      // read this lunch" into a confident "no lunch" — which silently pays everyone on the
      // sheet for their break. Unknown stays null and the review screen asks for it.
      const raw = r?.break_minutes;
      const brk = Number(raw);
      const known = raw !== null && raw !== undefined && raw !== ''
        && Number.isFinite(brk) && brk >= 0 && brk <= 480;
      return {
        last, first,
        date: isDate(r?.date) ? r.date : null,
        time_in: cleanTime(r?.time_in),
        time_out: cleanTime(r?.time_out),
        break_minutes: known ? Math.round(brk) : null,
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
