// geocode-suggest: live address + business autocomplete via Google Places (the
// picked string is resolved to coords later by calc-distance, so we return labels
// only — no Place Details call, keeps it one cheap request per keystroke-batch).
// Biased to the caller's home area when we have their coords (cached by calc-distance).
// Returns [] gracefully on any problem so the client's local suggestions still work.
import { caller, json, preflight } from "../_shared/util.ts";

const KEY = Deno.env.get("GOOGLE_MAPS_KEY");

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { text } = await req.json();
    const q = String(text ?? "").trim();
    if (q.length < 3 || !KEY) return json({ ok: true, suggestions: [] });

    const u = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    u.searchParams.set("input", q);
    u.searchParams.set("components", "country:us");
    u.searchParams.set("key", KEY);
    // bias to the caller's home area if we have it (Places uses this to rank nearby hits)
    const fLat = who.profile?.base_lat, fLng = who.profile?.base_lng;
    if (fLat != null && fLng != null) {
      u.searchParams.set("location", `${fLat},${fLng}`);
      u.searchParams.set("radius", "60000"); // ~37 mi
    }

    const r = await fetch(u).then((x) => x.json()).catch(() => null);
    const suggestions = (r?.predictions ?? [])
      .map((p: any) => ({ label: String(p?.description ?? "") }))
      .filter((s: any) => s.label)
      .slice(0, 6);

    return json({ ok: true, suggestions });
  } catch {
    return json({ ok: true, suggestions: [] });
  }
});
