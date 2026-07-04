// read-route: read a navigation-app route screenshot (Google/Apple Maps) from
// Storage and return the trip distance in miles. Mirrors read-odometer.
import { caller, claudeVision, downloadImage, json, ownsPath, parseJsonLoose, preflight }
  from "../_shared/util.ts";

const BUCKET = "odometer"; // route screenshots live beside odometer photos (same private, per-BA bucket)

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { path } = await req.json();
    if (!path) return json({ ok: false, error: "path required" }, 400);
    if (!ownsPath(who, path)) return json({ ok: false, error: "forbidden" }, 403);
    if (!Deno.env.get("ANTHROPIC_API_KEY"))
      return json({ ok: false, error: "ocr_unavailable", message: "Type the miles manually." }, 200);

    const { base64, mime } = await downloadImage(BUCKET, path);
    const text = await claudeVision(
      base64, mime,
      `This is a screenshot of a navigation app (Google Maps, Apple Maps, Waze…) showing a driven or planned route.
Return ONLY JSON: {"miles": number|null, "start": string|null, "destination": string|null}
- "miles": the route's total distance as a number in MILES. If the app shows kilometers, convert (km × 0.621371) and round to 1 decimal.
- If several routes are shown, use the selected/highlighted one.
- "start"/"destination": the place names if visible, else null.
- If you cannot read a distance confidently, use null for miles.`,
      200,
    );
    const parsed = parseJsonLoose(text) ?? {};
    let miles = typeof parsed.miles === "number"
      ? parsed.miles
      : (parsed.miles != null ? Number(String(parsed.miles).replace(/[^0-9.]/g, "")) : null);
    if (!Number.isFinite(miles) || miles <= 0 || miles > 2000) miles = null;

    return json({
      ok: true,
      miles: miles != null ? Math.round(miles * 10) / 10 : null,
      start: typeof parsed.start === "string" ? parsed.start : null,
      destination: typeof parsed.destination === "string" ? parsed.destination : null,
      raw: parsed,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
