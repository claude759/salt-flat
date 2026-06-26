// geocode-suggest: live US address autocomplete via OpenRouteService (Pelias).
// Proxies ORS so the key stays server-side. Returns [] gracefully if there's no
// key or any error, so the client's local (Home/dispensary/recent) suggestions
// still work and typing is never blocked.
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
    u.searchParams.set("size", "5");

    const r = await fetch(u).then((x) => x.json()).catch(() => null);
    const suggestions = (r?.features ?? [])
      .map((f: any) => ({
        label: f?.properties?.label ?? "",
        lat: f?.geometry?.coordinates?.[1],
        lng: f?.geometry?.coordinates?.[0],
      }))
      .filter((s: any) => s.label && s.lat != null);

    return json({ ok: true, suggestions });
  } catch {
    return json({ ok: true, suggestions: [] }); // never block typing
  }
});
