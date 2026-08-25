// parse-harvest: turn messy harvest/deleaf notes (pasted text OR a photo in the
// 'timesheets' bucket) into structured labor rows. Port of the Apps Script
// parseHarvestNotes_/visionHarvestNotes_ flow. Same staff gate as read-timesheet.
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
const BUCKET = "timesheets";

const HARVEST_INSTR =
  'You are parsing messy, informal worker-submitted labor notes into structured rows. ' +
  'The input may be typed text OR a photo of handwritten notes or a phone screenshot; read whatever is given.\n' +
  'Workers often MIX two kinds of work in one list. Classify every row:\n' +
  '- category "distro" = packaging/warehouse work: the word "distro", OR the location "Portal"/"portal" ' +
  '(Portal is a packaging company, not a grow site), or clear warehouse/packaging wording.\n' +
  '- category "harvest" = grow-site work: 23rd, 25th, imperial, Olympic, or harvest-type tasks ' +
  '(harvest, veg, deleaf, transplant, clean lamps, loading...).\n' +
  '- If a row is genuinely unclear (e.g. an unknown location like "the spot"), category null and keep the ' +
  'original wording in the note.\n' +
  'Location mapping (map any mention to the business): "23rd"/"23 st"/"23rd st" -> Slane; "25th"/"25 st"/"25st" -> Filifera; ' +
  '"imperial"/"imp" -> Imperial; "Olympic"/"Olimpic" -> Olympic; "portal" -> Portal (a distro company: category distro).\n' +
  'Each note describes a crew OR a named person working at a location on a date, for a time range, on a ' +
  'task (harvest, veg, deleaf, clean lamps, transplant, loading, general cleaning, etc). A header naming a ' +
  'person (e.g. the sender) applies to every row below it; a section header like "DISTRO" or "OLYMPIC" ' +
  'applies to the rows under it until the next header.\n' +
  'These are often photos of a phone showing a chat or notes app: a lone personal name — the contact name in ' +
  'the chat header/title bar at the TOP, or a signature name on its own line at the BOTTOM (e.g. "Tany", ' +
  '"Elmer") — is the WORKER; apply it to EVERY row. If any single name is visible anywhere and the rows ' +
  'themselves name nobody, do NOT return worker null; use that name for all rows.\n' +
  'Transcribe carefully — these lists are messy handwriting or low-res screenshots. A date wildly outside ' +
  'the run of the list (like 7/25 inside a 7/5..7/16 list) is almost certainly a misread; re-examine the ' +
  'line before writing it. Do not skip lines: one physical line = one row.\n' +
  'Return ONLY a JSON object, no prose: {"rows":[{"category":"distro"|"harvest"|null,"date":"YYYY-MM-DD"|null,"location":string|null,' +
  '"task":string|null,"break_min":number|null,"worker":string|null,"people":number|null,"rate":number|null,"time_in":"HH:MM"|null,"time_out":"HH:MM"|null,"note":string}],"sheet_row_count":number|null}\n' +
  '- COMPLETENESS (critical): output ONE row for EVERY filled line — never omit a line because a name is hard to read. ' +
  'For a printed sign-in grid (a numbered "#" column), set "sheet_row_count" to the number of numbered rows that contain ANY handwriting ' +
  '(a name and/or a time), INCLUDING crossed-out rows. For a freeform notes list, "sheet_row_count" = the number of work lines. ' +
  'The number of objects in "rows" should equal "sheet_row_count".\n' +
  '- UNREADABLE / CROSSED: if a filled row exists but its name is illegible, STILL output the row with "worker" null and "note" beginning "UNREADABLE — " ' +
  'plus whatever letters you can make out and the times. If a row is crossed out, output it with "worker" null and "note" beginning "CROSSED OUT — ". ' +
  'Do not silently drop either kind; a human will fill it in or untick it.\n' +
  'Rules:\n' +
  '- Bare dates like "6/7", "jun 6", "5/27", "6/20/16" are year 2026 (ignore an obviously wrong year like 16). Output YYYY-MM-DD.\n' +
  '- SPANISH is common. Month names: enero=01 febrero=02 marzo=03 abril=04 mayo=05 junio=06 julio=07 ' +
  'agosto=08 septiembre/setiembre=09 octubre=10 noviembre=11 diciembre=12. "5 de julio" -> 2026-07-05. ' +
  'Weekdays: lunes/martes/miércoles/jueves/viernes/sábado/domingo (a weekday-only Spanish row follows the ' +
  'same rule as English — date null, weekday in the note). "hrs"/"horas" totals lines (e.g. "32.8 hrs") are ' +
  'SUMMARY lines, not work rows — skip them. "la 23"/"la 25" (Spanish "the 23rd/25th") are the street ' +
  'shorthand -> Slane/Filifera. Times stay am/pm as written ("8am - 1pm").\n' +
  '- A row giving ONLY a weekday ("Monday - 8am-5pm"): date null, and START the note with that weekday name.\n' +
  '- If a weekday and a date disagree ("sat 8/11" when 8/11 is not a Saturday), KEEP the written date but ' +
  'start the note with "DATE?" and the discrepancy (e.g. "DATE? sat vs 8/11 — maybe 7/11") so a human resolves it. Never move a date yourself.\n' +
  '- PAY: NORMA is paid her own rate; everyone else is the base rate. The server sets the final "rate" from ' +
  'the work date, so leave "rate" null and never guess a dollar amount.\n' +
  '- SEPARATE NORMA: whenever "Norma" (or "+norma") is part of a crew, output her as her OWN row ' +
  '(worker "Norma", people 1) for that same date/location/task/time, AND do NOT count her in the crew. ' +
  'Example: "8 people + norma" -> a crew row {people 8} PLUS a separate {worker "Norma", people 1}. ' +
  'A bare number of people is that count as one base-rate crew row.\n' +
  '- A specific named person (Esmeralda, Issac, Stefani, Elmer, Oscar, Lili, Andres, Norma, Nouri, ...) -> ' +
  'worker = that name, people = 1 unless a count is given. One row per date for that person.\n' +
  '- Times: "7 to 5pm" -> 07:00/17:00; "8:30 to 4pm" -> 08:30/16:00; "10:50-2:00" -> 10:50/14:00; ' +
  '"5pm to 9pm" -> 17:00/21:00. Infer AM/PM for a normal daytime shift.\n' +
  '- If the image has a header naming the location or person, apply it to every row below it.\n' +
  '- location MUST be one of exactly Slane, Filifera, Imperial, Olympic, Portal, or null. Never read it off ' +
  'the logo or letterhead: the sheets are printed on Wizard Trees / Wizard Tags stationery and neither is a ' +
  'site. If the sheet names none of the five, use null.\n' +
  '- location: use the mapped business name (Slane/Filifera/Imperial/Olympic for harvest; Portal or another ' +
  'distro company name for distro rows). If none is given, null.\n' +
  '- BREAKS/LUNCH are NOT tasks. A lunch or break notation — "30m", "30 min", "30 min break", "1/2 hr", ' +
  '"half hour", "1 hr lunch", "lunch", "break" — goes in "break_min" as the number of MINUTES (30, 60, ...); ' +
  '"no lunch"/"no break" -> break_min 0. NEVER put a break/lunch value in "task". If no break is mentioned, break_min null. ' +
  'Keep the original wording in the note either way.\n' +
  '- task: short label incl. room if noted (harvest / veg / deleaf / clean lamps / etc). note: a short snippet of the original line.\n' +
  '- One row per distinct work entry. Skip pure header/label lines with no work info.\n';

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
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const cleanTime = (v: unknown) => {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return m[1].padStart(2, "0") + ":" + m[2];
};
// An Anthropic ACCOUNT failure is not "this photo is unreadable" — it is a
// billing or key problem nobody in the field can act on. Say which, in a
// sentence a warehouse manager can act on, instead of pasting raw API JSON.
function accountError(status: number, body: string): string | null {
  const b = (body || "").toLowerCase();
  if (b.includes("credit balance is too low") || b.includes("insufficient_quota") || b.includes("billing"))
    return "The sheet reader has run out of Anthropic API credit, so it can't read photos right now. " +
           "Send Gianni this message so he can top up the balance. You can still type the hours in by hand with + row.";
  if (status === 401 || b.includes("invalid x-api-key") || b.includes("authentication_error"))
    return "The sheet reader's API key was rejected. Send Gianni this message. " +
           "You can still type the hours in by hand with + row.";
  if (status === 403)
    return "The sheet reader was refused by the API. Send Gianni this message. " +
           "You can still type the hours in by hand with + row.";
  return null;
}
function cleanLocation(s: unknown){
  if (typeof s !== "string") return null;
  const t = s.toLowerCase();
  if (t.includes("portal")) return "Portal";       // checked first: never lose to a stray digit
  if (t.includes("slane") || t.includes("filifera")) return t.includes("slane") ? "Slane" : "Filifera";
  if (t.includes("imp")) return "Imperial";
  if (t.includes("olim") || t.includes("olym")) return "Olympic";
  // street-number shorthand (23rd/25st/25t...) — but not date-like strings ("7/25")
  if (!/\d\s*\/\s*\d/.test(t)){
    if (/(^|[^0-9])23/.test(t)) return "Slane";
    if (/(^|[^0-9])25/.test(t)) return "Filifera";
  }
  // Only the five real sites survive. The sheets are printed on Wizard Trees /
  // Wizard Tags letterhead and a stray read of the logo used to land in the log
  // as a company; an unknown string now becomes null so the review card asks.
  return null;
}
// minutes from a break/lunch token, or null if the token isn't a break at all
function breakFromToken(s: string): number | null {
  const t = s.toLowerCase().trim();
  let m = t.match(/^(\d{1,3})\s*(m|min|mins|minute|minutes)(\s*(break|lunch))?$/);
  if (m) return Math.min(600, +m[1]);
  // a bare "1 hr" / "2 hour" alone in the task is a break like "1/2 hr" is (keyword optional, symmetric)
  m = t.match(/^(\d)\s*(hr|hour|hours)(\s*(break|lunch))?$/);
  if (m) return Math.min(600, +m[1] * 60);
  if (/^(1\/2|½|half)\s*(hr|hour)(\s*(break|lunch))?$/.test(t)) return 30;
  if (/^no\s+(lunch|break)$/.test(t)) return 0;
  if (/^(lunch|break)$/.test(t)) return 0;   // recognized, unknown length -> 0 (a human sets it)
  return null;
}
// numeric minutes, or recover a stringy break_min the model may emit ("30 min", "½ hr")
const cleanBreak = (v: unknown) => {
  const n = Number(v);
  if (isFinite(n) && n >= 0) return Math.min(600, Math.round(n));
  if (typeof v === "string"){ const b = breakFromToken(v); if (b !== null) return b; }
  return 0;
};
// Dated pay-rate changes. A row is paid at the LAST entry whose `from` is on or
// before its work date; with no match the flat fallback below stands. Record a
// raise by ADDING a row here, never by editing one, which would reprice history.
const RATE_CHANGES = [
  { match: /norma/i, from: "2026-08-15", rate: 26 },
];
// null when the row has no date (an undated row must never pick up the NEW rate)
// or nothing matches. Dates are 'YYYY-MM-DD' and compared as plain strings: a Date
// here would shift the boundary by a timezone and mis-pay a whole day.
function datedRate(name: string | null, workDate: string | null){
  if (!name || !workDate) return null;
  const d = String(workDate).slice(0, 10);
  let best: { from: string; rate: number } | null = null;
  for (const c of RATE_CHANGES){
    if (!c.match.test(name)) continue;
    if (d < c.from) continue;
    if (!best || c.from > best.from) best = c;
  }
  return best ? best.rate : null;
}
function normNote(r: any){
  if (!r || typeof r !== "object") return null;
  let people = Number(r.people); if (!isFinite(people) || people < 1) people = 1; people = Math.round(people);
  const worker = typeof r.worker === "string" ? r.worker.trim() : null;
  const isNorma = worker && /norma/i.test(worker);
  const location = cleanLocation(r.location);
  const c = String(r.category ?? "").toLowerCase();
  let category = c === "distro" || c === "harvest" ? c : null;
  if (location === "Portal") category = "distro";   // Portal is a packaging company, never a grow site
  // a break can arrive in break_min, or (if the model slipped) still be sitting
  // in the task like "30m" — recover it so it never pollutes Team/Task
  let task = typeof r.task === "string" ? r.task.trim() : null;
  let brk = cleanBreak(r.break_min);
  if (task){ const b = breakFromToken(task); if (b !== null){ task = null; if (!brk) brk = b; } }
  const date = isDate(r.date) ? r.date : null;
  const row = {
    category,
    date,
    location,
    task,
    break_min: brk,
    worker,
    rate: datedRate(worker, date) ?? (isNorma ? 25 : 20),
    people: isNorma ? 1 : people,
    time_in: cleanTime(r.time_in),
    time_out: cleanTime(r.time_out),
    note: typeof r.note === "string" ? r.note.trim().slice(0, 120) : null,
  };
  // never silently drop a filled line: keep the row if it has ANY structured
  // field OR a note (an illegible/crossed row comes back with only a note —
  // don't depend on the model using an exact "UNREADABLE" prefix). Only a truly
  // empty {} is discarded.
  if (!row.worker && !row.task && !row.location && !row.time_in && !row.time_out && !row.note) return null;
  return row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const who = await staffCaller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);
    const { text, path } = await req.json();
    if (!text && !path) return json({ ok: false, error: "text or path required" }, 400);
    if (path && String(path).includes("..")) return json({ ok: false, error: "bad path" }, 400);
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ ok: false, error: "ocr_unavailable", message: "Enter the rows manually." }, 200);

    let content: any;
    if (path){
      const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
      const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(String(path));
      if (dlErr || !blob) return json({ ok: false, error: "download failed: " + (dlErr?.message ?? "no data") }, 400);
      const buf = new Uint8Array(await blob.arrayBuffer());
      const mime = blob.type?.startsWith("image/") ? blob.type : "image/jpeg";
      content = [
        { type: "image", source: { type: "base64", media_type: mime, data: encodeBase64(buf) } },
        { type: "text", text: HARVEST_INSTR + "\nParse the labor notes shown in the attached photo." },
      ];
    } else {
      content = HARVEST_INSTR + "\nNOTES TO PARSE:\n" + String(text).slice(0, 20000);
    }

    const model = Deno.env.get("OCR_MODEL") ?? "claude-opus-4-8";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8000,
        messages: [{ role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("anthropic", res.status, body.slice(0, 300));
      const acct = accountError(res.status, body);
      if (acct) return json({ ok: false, error: "ocr_unavailable", message: acct }, 200);
      return json({ ok: false, error: `anthropic ${res.status}` }, 502);
    }
    const data = await res.json();
    const out = (data?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
    const parsed = parseJsonLoose(out) ?? {};
    const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).map(normNote).filter(Boolean);
    const n = Number(parsed.sheet_row_count);
    const filled_rows = isFinite(n) && n > 0 ? Math.round(n) : null;
    return json({ ok: true, rows, filled_rows });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
