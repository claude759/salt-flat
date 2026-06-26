// geocode-suggest: live US address autocomplete via OpenRouteService (Pelias),
// biased toward the caller's home area when we already have their coords (cached
// by calc-distance). Proxies ORS so the key stays server-side. Returns []
// gracefully on any problem so the client's local suggestions still work.
// Kept lean (no per-keystroke geocoding) so it stays fast.
import { caller, json, preflight } from "../_shared/util.ts";

const ORS_KEY = Deno.env.get("ORS_KEY");

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { text } = await req.json();
    const q = String(text ?? "").trim();
    if (q.length < 3 || !ORS_KEY) return json({ ok: true, suggestions: [] });

    const u = new URL("https://api.openrouteservice.org/geocode/autocomplete");
    u.searchParams.set("api_key", ORS_KEY);
    u.searchParams.set("text", q);
    u.searchParams.set("boundary.country", "US");
    u.searchParams.set("size", "6");
    // bias to the caller's home area if we already have it (no live geocode here)
    const fLat = who.profile?.base_lat, fLng = who.profile?.base_lng;
    if (fLat != null && fLng != null) {
      u.searchParams.set("focus.point.lat", String(fLat));
      u.searchParams.set("focus.point.lon", String(fLng));
    }

    const r = await fetch(u).then((x) => x.json()).catch(() => null);
    const suggestions = (r?.features ?? [])
      .map((f: any) => ({ label: f?.properties?.label ?? "", lat: f?.geometry?.coordinates?.[1], lng: f?.geometry?.coordinates?.[0] }))
      .filter((s: any) => s.label && s.lat != null);

    return json({ ok: true, suggestions });
  } catch {
    return json({ ok: true, suggestions: [] });
  }
});
