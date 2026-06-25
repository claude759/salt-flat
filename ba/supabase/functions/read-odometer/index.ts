// read-odometer: read a single odometer photo from Storage, return the numeric mileage.
import { caller, claudeVision, downloadImage, json, ownsPath, parseJsonLoose, preflight }
  from "../_shared/util.ts";

const BUCKET = "odometer"; // pinned — never trust a client-supplied bucket

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { path } = await req.json();
    if (!path) return json({ ok: false, error: "path required" }, 400);
    if (!ownsPath(who, path)) return json({ ok: false, error: "forbidden" }, 403);
    // OCR is optional — with no Anthropic key the BA just types the odometer reading.
    if (!Deno.env.get("ANTHROPIC_API_KEY"))
      return json({ ok: false, error: "ocr_unavailable", message: "Type the reading manually." }, 200);

    const { base64, mime } = await downloadImage(BUCKET, path);
    const text = await claudeVision(
      base64, mime,
      `This is a photo of a car odometer (the total-miles display, not the trip meter).
Return ONLY JSON: {"reading": number|null}
- "reading" is the whole-mile odometer value as a plain number (ignore tenths after a decimal/box).
- If you cannot read it confidently, use null.`,
      120,
    );
    const parsed = parseJsonLoose(text) ?? {};
    let reading = typeof parsed.reading === "number"
      ? parsed.reading
      : (parsed.reading != null ? Number(String(parsed.reading).replace(/[^0-9.]/g, "")) : null);
    if (!Number.isFinite(reading)) reading = null;

    return json({ ok: true, reading, raw: parsed });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
