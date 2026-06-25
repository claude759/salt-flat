// extract-receipt: read a receipt photo from Storage, return {vendor,total,date,category}.
// The browser uploads the image to the private 'receipts' bucket first, then calls
// this with its path. Any signed-in user may call it (for their own upload).
import { caller, claudeVision, downloadImage, json, ownsPath, parseJsonLoose, preflight }
  from "../_shared/util.ts";

const CATEGORIES = ["Meals", "Fuel", "Supplies", "Parking/Tolls", "Lodging", "Other"];
const BUCKET = "receipts"; // pinned — never trust a client-supplied bucket

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { path } = await req.json();
    if (!path) return json({ ok: false, error: "path required" }, 400);
    if (!ownsPath(who, path)) return json({ ok: false, error: "forbidden" }, 403);
    // OCR is optional — with no Anthropic key the BA just types the details (the
    // receipt photo is still uploaded + attached as proof).
    if (!Deno.env.get("ANTHROPIC_API_KEY"))
      return json({ ok: false, error: "ocr_unavailable", message: "Enter the details manually." }, 200);

    const { base64, mime } = await downloadImage(BUCKET, path);
    const text = await claudeVision(
      base64, mime,
      `You are reading a purchase receipt. Return ONLY a JSON object, no prose:
{"vendor": string|null, "total": number|null, "date": "YYYY-MM-DD"|null, "category": one of ${JSON.stringify(CATEGORIES)}}
- "total" is the final amount paid (grand total incl. tax/tip), as a plain number.
- "date" is the transaction date. If unreadable use null.
- Pick the single best "category". If unsure use "Other".`,
    );
    const parsed = parseJsonLoose(text) ?? {};
    const total = typeof parsed.total === "number"
      ? parsed.total
      : (parsed.total != null ? Number(String(parsed.total).replace(/[^0-9.\-]/g, "")) : null);

    return json({
      ok: true,
      vendor: parsed.vendor ?? null,
      total: Number.isFinite(total) ? total : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? "") ? parsed.date : null,
      category: CATEGORIES.includes(parsed.category) ? parsed.category : "Other",
      raw: parsed,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
