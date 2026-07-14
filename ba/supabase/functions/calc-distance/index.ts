// calc-distance: driving distance from a start to a destination, via Google Maps
// (Geocoding + Directions). Returns the SHORTEST route as `miles` (backward-compat)
// PLUS the full set of alternative routes so the BA can pick the one they actually
// drove. Geocoding is state-restricted (components) so ambiguous addresses like
// "376 stockton st" resolve in the BA's state, not San Francisco. Start can be GPS
// coords, a typed address, or the trip owner's saved base. Any failure returns a
// graceful 200 {ok:false} so the BA just types miles. Key lives in the edge secret.
import { admin, caller, json, preflight } from "../_shared/util.ts";

const KEY = Deno.env.get("GOOGLE_MAPS_KEY");
const STATE_NAME: Record<string, string> = { NY: "New York", CA: "California", FL: "Florida" };
const M_PER_MI = 1609.344;

// address → {lat,lng}, hard-restricted to the BA's US state so bare street names
// can't match the same street in another state. null on any failure.
async function geocode(address: string, region?: string | null) {
  if (!KEY) return null;
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", address);
    u.searchParams.set("key", KEY);
    const comps = ["country:US"];
    if (region && STATE_NAME[region]) comps.push(`administrative_area:${STATE_NAME[region]}`);
    u.searchParams.set("components", comps.join("|"));
    const r = await fetch(u).then((x) => x.json());
    const loc = r?.results?.[0]?.geometry?.location;
    return (loc && typeof loc.lat === "number") ? { lat: loc.lat, lng: loc.lng } : null;
  } catch {
    return null;
  }
}
// Resolve a store by BUSINESS NAME via Google Places (many imported stores have no
// street address, only a trade name like "Goat Global DTLA"). Region-restricted so
// the result stays in the BA's state. Returns coords + a formatted address to cache.
async function findPlace(name: string, region?: string | null) {
  if (!KEY || !name) return null;
  try {
    const stateName = region && STATE_NAME[region] ? STATE_NAME[region] : "";
    const u = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
    u.searchParams.set("input", `${name} dispensary${stateName ? " " + stateName : ""}`);
    u.searchParams.set("inputtype", "textquery");
    u.searchParams.set("fields", "geometry,formatted_address");
    u.searchParams.set("key", KEY);
    const r = await fetch(u).then((x) => x.json());
    const c = r?.candidates?.[0];
    const loc = c?.geometry?.location;
    if (!loc || typeof loc.lat !== "number") return null;
    // guard against a wrong-state match when we know the state
    if (stateName && c.formatted_address && !new RegExp(`\\b(${region}|${stateName})\\b`, "i").test(c.formatted_address)) return null;
    return { lat: loc.lat, lng: loc.lng, address: (c.formatted_address as string) || null };
  } catch {
    return null;
  }
}
// "376 stockton st" typed by hand ≈ "376 Stockton St, Brooklyn, NY 11206" saved on the
// profile — compare the first 3 normalized tokens (joining hyphenated leading numbers)
const addrSig = (s: string) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/^(\d+) (\d+) /, "$1$2 ").split(" ").slice(0, 3).join(" ");

type Route = { oneWay: number; mins: number; summary: string };
// alternative driving routes, shortest first, near-duplicates removed. [] on failure.
async function routeOptions(o: { lat: number; lng: number }, d: { lat: number; lng: number }): Promise<Route[]> {
  if (!KEY) return [];
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/directions/json");
    u.searchParams.set("origin", `${o.lat},${o.lng}`);
    u.searchParams.set("destination", `${d.lat},${d.lng}`);
    u.searchParams.set("alternatives", "true");
    u.searchParams.set("region", "us");
    u.searchParams.set("key", KEY);
    const r = await fetch(u).then((x) => x.json());
    const raw: Route[] = (r?.routes ?? []).map((rt: any) => {
      const leg = rt?.legs?.[0];
      return leg ? { oneWay: leg.distance.value / M_PER_MI, mins: Math.round(leg.duration.value / 60), summary: String(rt.summary || "") } : null;
    }).filter(Boolean);
    raw.sort((a, b) => a.oneWay - b.oneWay);
    const seen = new Set<string>(); const out: Route[] = [];
    for (const x of raw) { const k = x.oneWay.toFixed(1); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out.slice(0, 3);
  } catch {
    return [];
  }
}

const manual = (msg: string, error = "manual") => json({ ok: false, error, message: msg }, 200);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);
    if (!KEY) return manual("Auto-distance isn’t set up yet — enter miles manually.", "no_provider");

    const body = await req.json();
    const dispensary_id = body.dispensary_id;
    const db = admin();

    // region bias: the trip OWNER's, not the admin caller's — a CA admin editing a NY
    // trip must geocode in NY. Falls back to the caller's own profile.
    let fp = who.profile, fpId = who.user.id;
    if (body.for_ba && who.profile?.role === "admin") {
      const { data: t } = await db.from("profiles").select("id,base_address,base_lat,base_lng,region").eq("id", String(body.for_ba)).maybeSingle();
      if (t) { fp = t; fpId = t.id; }
    }
    const region = fp?.region ?? null;

    // ── resolve START: GPS coords > typed address > saved base ──
    let sLat = body.start_lat, sLng = body.start_lng, sLabel: string | null = null;
    if (sLat != null && sLng != null) {
      sLabel = "Current location";
    } else if (body.start_address) {
      // a typed start that IS the BA's saved home → use the saved full address / cached coords
      const typed = String(body.start_address);
      const isHome = fp?.base_address && addrSig(typed) === addrSig(fp.base_address);
      if (isHome && fp.base_lat != null && fp.base_lng != null) {
        sLat = fp.base_lat; sLng = fp.base_lng; sLabel = typed;
      } else {
        // try as a street address first; if that fails it may be a store/office NAME
        // (e.g. "* Office (CA)", "Goat Global DTLA") → resolve as a business via Places
        const g = await geocode(isHome ? fp.base_address : typed, region)
          || (isHome ? null : await findPlace(typed, region));
        if (!g) return manual("Couldn’t find that starting address — enter miles manually.", "geocode_start");
        sLat = g.lat; sLng = g.lng; sLabel = typed;
        if (isHome) await db.from("profiles").update({ base_lat: sLat, base_lng: sLng }).eq("id", fpId);
      }
    } else {
      sLat = fp?.base_lat; sLng = fp?.base_lng; sLabel = fp?.base_address ?? "Base";
      if ((sLat == null || sLng == null) && fp?.base_address) {
        const g = await geocode(fp.base_address, region);
        if (g) { sLat = g.lat; sLng = g.lng; await db.from("profiles").update({ base_lat: sLat, base_lng: sLng }).eq("id", fpId); }
      }
      if (sLat == null || sLng == null) return manual("Set your base address in Profile, tap Current location, or type a start.", "no_start");
    }

    // ── resolve DESTINATION: a dispensary (by id) OR a free address / coords ──
    let dLat: number | null = null, dLng: number | null = null;
    if (dispensary_id) {
      const { data: disp } = await db.from("dispensaries").select("*").eq("id", dispensary_id).single();
      if (disp) {
        dLat = disp.lat; dLng = disp.lng;
        if ((dLat == null || dLng == null) && disp.address) {
          const g = await geocode(disp.address, disp.state ?? region);
          if (g) { dLat = g.lat; dLng = g.lng; await db.from("dispensaries").update({ lat: dLat, lng: dLng }).eq("id", dispensary_id); }
        }
        // no usable street address (common for the imported store list) → find it by name
        if (dLat == null || dLng == null) {
          const fp = await findPlace(disp.name, disp.state ?? region);
          if (fp) { dLat = fp.lat; dLng = fp.lng; await db.from("dispensaries").update({ lat: dLat, lng: dLng, address: disp.address || fp.address }).eq("id", dispensary_id); }
        }
      }
    } else if (body.dest_lat != null && body.dest_lng != null) {
      dLat = body.dest_lat; dLng = body.dest_lng;
    } else if (body.dest_address) {
      const g = await geocode(String(body.dest_address), region);
      if (g) { dLat = g.lat; dLng = g.lng; }
    } else {
      return json({ ok: false, error: "destination required" }, 400);
    }
    if (dLat == null || dLng == null) return manual("Destination can’t be located — enter miles manually.", "no_dest");

    // ── routes ──
    const opts = await routeOptions({ lat: sLat, lng: sLng }, { lat: dLat, lng: dLng });
    if (!opts.length) return manual("Couldn’t compute the route — enter miles manually.", "route_unavailable");
    // sanity cap: a one-way field visit over 300 mi almost always means a wrong geocode.
    if (opts[0].oneWay > 300) {
      return manual(`That route came out to ~${Math.round(opts[0].oneWay)} mi one-way — likely a wrong address match. Check the start/destination, or type the miles.`, "implausible_distance");
    }
    const roundtrip = body.roundtrip !== false; // default true
    const r2 = (n: number) => Math.round(n * 100) / 100;

    return json({
      ok: true,
      source: "google",
      roundtrip,
      miles: r2(opts[0].oneWay * (roundtrip ? 2 : 1)),                 // shortest, roundtrip applied (backward-compat)
      routes: opts.map((r) => ({ miles: r2(r.oneWay), mins: r.mins, summary: r.summary })),   // ONE-WAY miles; client doubles if roundtrip
      start_label: sLabel, start_lat: sLat, start_lng: sLng,
    });
  } catch (_e) {
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
