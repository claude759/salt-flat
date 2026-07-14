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
  'You are parsing messy, informal HARVEST/DELEAF labor notes into structured rows. ' +
  'The input may be typed text OR a photo of handwritten notes; read whatever is given.\n' +
  'Location mapping (map any mention to the business): "23rd" -> Slane; "25th" -> Filifera; ' +
  '"imperial"/"imp" -> Imperial; "Olympic"/"Olimpic" -> Olympic.\n' +
  'Each note describes a crew OR a named person working at a location on a date, for a time range, on a ' +
  'task (harvest, veg, deleaf, clean lamps, transplant, loading, general cleaning, etc).\n' +
  'Return ONLY a JSON object, no prose: {"rows":[{"date":"YYYY-MM-DD"|null,"location":string|null,' +
  '"task":string|null,"worker":string|null,"people":number|null,"rate":number|null,"time_in":"HH:MM"|null,"time_out":"HH:MM"|null,"note":string}]}\n' +
  'Rules:\n' +
  '- Bare dates like "6/7", "jun 6", "5/27", "6/20/16" are year 2026 (ignore an obviously wrong year like 16). Output YYYY-MM-DD.\n' +
  '- PAY: NORMA is paid $25/hr; everyone else is $20/hr. Set "rate" 25 for a Norma row, 20 otherwise.\n' +
  '- SEPARATE NORMA: whenever "Norma" (or "+norma") is part of a crew, output her as her OWN row ' +
  '(worker "Norma", people 1, rate 25) for that same date/location/task/time, AND do NOT count her in the crew. ' +
  'Example: "8 people + norma" -> a crew row {people 8, rate 20} PLUS a separate {worker "Norma", people 1, rate 25}. ' +
  'A bare number of people is that count at rate 20.\n' +
  '- A specific named person (Esmeralda, Issac, Stefani, Elmer, Oscar, Lili, Andres, Norma, Nouri, ...) -> ' +
  'worker = that name, people = 1 unless a count is given. One row per date for that person.\n' +
  '- Times: "7 to 5pm" -> 07:00/17:00; "8:30 to 4pm" -> 08:30/16:00; "10:50-2:00" -> 10:50/14:00; ' +
  '"5pm to 9pm" -> 17:00/21:00. Infer AM/PM for a normal daytime shift.\n' +
  '- If the image has a header naming the location or person, apply it to every row below it.\n' +
  '- location: use the mapped business name (Slane/Filifera/Imperial/Olympic). If none is given, null.\n' +
  '- task: short label incl. room if noted. note: a short snippet of the original line (incl. things like "no lunch").\n' +
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
function cleanLocation(s: unknown){
  if (typeof s !== "string") return null;
  const t = s.toLowerCase();
  if (t.includes("slane") || t.includes("23")) return "Slane";
  if (t.includes("filifera") || t.includes("25")) return "Filifera";
  if (t.includes("imp")) return "Imperial";
  if (t.includes("olim") || t.includes("olym")) return "Olympic";
  return s.trim() || null;
}
function normNote(r: any){
  if (!r || typeof r !== "object") return null;
  let people = Number(r.people); if (!isFinite(people) || people < 1) people = 1; people = Math.round(people);
  const worker = typeof r.worker === "string" ? r.worker.trim() : null;
  const isNorma = worker && /norma/i.test(worker);
  const row = {
    date: isDate(r.date) ? r.date : null,
    location: cleanLocation(r.location),
    task: typeof r.task === "string" ? r.task.trim() : null,
    worker,
    rate: isNorma ? 25 : 20,
    people: isNorma ? 1 : people,
    time_in: cleanTime(r.time_in),
    time_out: cleanTime(r.time_out),
    note: typeof r.note === "string" ? r.note.trim().slice(0, 120) : null,
  };
  if (!row.worker && !row.task && !row.location && !row.time_in) return null;
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
        { type: "text", text: HARVEST_INSTR + "\nParse the harvest/deleaf notes shown in the attached photo." },
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
    if (!res.ok) return json({ ok: false, error: `anthropic ${res.status}` }, 502);
    const data = await res.json();
    const out = (data?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
    const parsed = parseJsonLoose(out) ?? {};
    const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).map(normNote).filter(Boolean);
    return json({ ok: true, rows });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
