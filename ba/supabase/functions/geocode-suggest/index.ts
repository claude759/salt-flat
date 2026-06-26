// geocode-suggest: live US address autocomplete via OpenRouteService (Pelias),
// biased toward the caller's home area so results are local (like a normal address
// picker). Proxies ORS so the key stays server-side. Returns [] gracefully on any
// problem so the client's local (Home/dispensary/recent) suggestions still work.
import { admin, caller, json, preflight } from "../_shared/util.ts";

const ORS_KEY = Deno.env.get("ORS_KEY");

async function geocodeOne(address: string) {
  try {
    const u = new URL("https://api.openrouteservice.org/geocode/search");
    u.searchParams.set("api_key", ORS_KEY!);
    u.searchParams.set("text", address);
    u.searchParams.set("boundary.country", "US");
    u.searchParams.set("size", "1");
    const r = await fetch(u).then((x) => x.json());
    const c = r?.features?.[0]?.geometry?.coordinates;
    return Array.isArray(c) ? { lat: c[1], lng: c[0] } : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const { text } = await req.json();
    const q = String(text ?? "").trim();
    if (q.length < 3 || !ORS_KEY) return json({ ok: true, suggestions: [] });

    const db = admin();
    // focus point = the caller's home area (geocode + cache the base coords once)
    let fLat = who.profile?.base_lat, fLng = who.profile?.base_lng;
    if ((fLat == null || fLng == null) && who.profile?.base_address) {
      const g = await geocodeOne(who.profile.base_address);
      if (g) { fLat = g.lat; fLng = g.lng; await db.from("profiles").update({ base_lat: fLat, base_lng: fLng }).eq("id", who.user.id); }
    }

    const u = new URL("https://api.openrouteservice.org/geocode/autocomplete");
    u.searchParams.set("api_key", ORS_KEY);
    u.searchParams.set("text", q);
    u.searchParams.set("boundary.country", "US");
    u.searchParams.set("size", "6");
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
