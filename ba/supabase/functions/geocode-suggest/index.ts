// geocode-suggest: live US address autocomplete via Photon (komoot's OSM geocoder —
// keyless, built for search-as-you-type; the old OpenRouteService key was disallowed,
// which silently killed suggestions). Biased toward the caller's home area when we
// already have their coords (cached by calc-distance). Returns [] gracefully on any
// problem so the client's local suggestions still work.
import { caller, json, preflight } from "../_shared/util.ts";

const UA = { "User-Agent": "wizardtrees-ba-app/1.0" };

// compose a readable one-line label from Photon's structured properties
function photonLabel(p: Record<string, string | undefined>) {
  const line1 = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
  const line2 = [p.city || p.district || p.county, p.state, p.postcode].filter(Boolean).join(", ");
  return [line1, line2].filter(Boolean).join(", ");
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { text } = await req.json();
    const q = String(text ?? "").trim();
    if (q.length < 3) return json({ ok: true, suggestions: [] });

    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", q);
    u.searchParams.set("limit", "8");
    // bias to the caller's home area if we already have it (no live geocode here)
    const fLat = who.profile?.base_lat, fLng = who.profile?.base_lng;
    if (fLat != null && fLng != null) {
      u.searchParams.set("lat", String(fLat));
      u.searchParams.set("lon", String(fLng));
    }

    const r = await fetch(u, { headers: UA }).then((x) => x.json()).catch(() => null);
    const seen = new Set<string>();
    const suggestions = (r?.features ?? [])
      .filter((f: any) => f?.properties?.countrycode === "US" && Array.isArray(f?.geometry?.coordinates))
      .map((f: any) => ({ label: photonLabel(f.properties), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }))
      .filter((s: any) => s.label && !seen.has(s.label) && seen.add(s.label))
      .slice(0, 6);

    return json({ ok: true, suggestions });
  } catch {
    return json({ ok: true, suggestions: [] });
  }
});
