// calc-distance: driving miles from a starting location to a dispensary, via
// OpenRouteService (free, no credit card). Start can be GPS coords (start_lat/
// start_lng), a typed address (start_address), or — if neither — the caller's
// saved base address. Round-trip by default. Geocoded coords are cached onto the
// profile/dispensary rows so we only geocode once. Any failure returns a graceful
// 200 {ok:false} so the BA just types miles instead.
import { admin, caller, json, preflight } from "../_shared/util.ts";

const ORS_KEY = Deno.env.get("ORS_KEY");

// Bias ambiguous addresses toward the BA's part of the country. Without this,
// "376 stockton st" (Brooklyn) geocoded to Stockton St, San Francisco and produced
// 2,900-mile "trips". focus.point makes Pelias rank nearby matches first.
const REGION_FOCUS: Record<string, { lat: number; lng: number }> = {
  NY: { lat: 40.71, lng: -74.0 },
  CA: { lat: 34.05, lng: -118.24 },
  FL: { lat: 26.12, lng: -80.14 },
};
async function geocode(address: string, focus?: { lat: number; lng: number } | null) {
  if (!ORS_KEY) return null;
  try {
    const u = new URL("https://api.openrouteservice.org/geocode/search");
    u.searchParams.set("api_key", ORS_KEY);
    u.searchParams.set("text", address);
    u.searchParams.set("boundary.country", "US");
    if (focus) { u.searchParams.set("focus.point.lat", String(focus.lat)); u.searchParams.set("focus.point.lon", String(focus.lng)); }
    u.searchParams.set("size", "1");
    const r = await fetch(u).then((x) => x.json());
    const c = r?.features?.[0]?.geometry?.coordinates; // [lon, lat]
    return Array.isArray(c) ? { lat: c[1], lng: c[0] } : null;
  } catch {
    return null;
  }
}

// one-way driving meters, or null on any failure
async function drivingMeters(o: { lat: number; lng: number }, d: { lat: number; lng: number }) {
  try {
    const u = new URL("https://api.openrouteservice.org/v2/directions/driving-car");
    u.searchParams.set("api_key", ORS_KEY!);
    u.searchParams.set("start", `${o.lng},${o.lat}`);
    u.searchParams.set("end", `${d.lng},${d.lat}`);
    const r = await fetch(u).then((x) => x.json());
    const m = r?.features?.[0]?.properties?.summary?.distance;
    return typeof m === "number" ? m : null;
  } catch {
    return null;
  }
}

const manual = (msg: string, error = "manual") => json({ ok: false, error, message: msg }, 200);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    const body = await req.json();
    const dispensary_id = body.dispensary_id;
    if (!ORS_KEY) return manual("Auto-distance isn’t set up yet — enter miles manually.", "no_provider");

    const db = admin();

    // geocode bias: the trip OWNER's coords/region — when an admin edits a BA's trip
    // (body.for_ba), bias to that BA, not the admin (a CA admin fixing a NY trip must
    // not pull ambiguous addresses toward LA). Falls back to the caller's own profile.
    let fp = who.profile;
    if (body.for_ba && who.profile?.role === "admin") {
      const { data: t } = await db.from("profiles").select("base_lat,base_lng,region").eq("id", String(body.for_ba)).maybeSingle();
      if (t) fp = t;
    }
    const focus = (fp?.base_lat != null && fp?.base_lng != null)
      ? { lat: fp.base_lat, lng: fp.base_lng }
      : (REGION_FOCUS[fp?.region ?? ""] ?? null);

    // ── resolve START: GPS coords > typed address > saved base ──
    let sLat = body.start_lat, sLng = body.start_lng, sLabel: string | null = null;
    if (sLat != null && sLng != null) {
      sLabel = "Current location";
    } else if (body.start_address) {
      const g = await geocode(String(body.start_address), focus);
      if (!g) return manual("Couldn’t find that starting address — enter miles manually.", "geocode_start");
      sLat = g.lat; sLng = g.lng; sLabel = String(body.start_address);
    } else {
      sLat = who.profile?.base_lat; sLng = who.profile?.base_lng; sLabel = who.profile?.base_address ?? "Base";
      if ((sLat == null || sLng == null) && who.profile?.base_address) {
        const g = await geocode(who.profile.base_address, focus);
        if (g) { sLat = g.lat; sLng = g.lng; await db.from("profiles").update({ base_lat: sLat, base_lng: sLng }).eq("id", who.user.id); }
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
          const g = await geocode(disp.address, focus);
          if (g) { dLat = g.lat; dLng = g.lng; await db.from("dispensaries").update({ lat: dLat, lng: dLng }).eq("id", dispensary_id); }
        }
      }
    } else if (body.dest_lat != null && body.dest_lng != null) {
      dLat = body.dest_lat; dLng = body.dest_lng;
    } else if (body.dest_address) {
      const g = await geocode(String(body.dest_address), focus);
      if (g) { dLat = g.lat; dLng = g.lng; }
    } else {
      return json({ ok: false, error: "destination required" }, 400);
    }
    if (dLat == null || dLng == null) return manual("Destination can’t be located — enter miles manually.", "no_dest");

    // ── route ──
    const meters = await drivingMeters({ lat: sLat, lng: sLng }, { lat: dLat, lng: dLng });
    if (meters == null) return manual("Couldn’t compute the route — enter miles manually.", "route_unavailable");
    // sanity cap: a one-way field visit over 300 mi almost always means a wrong
    // geocode match (the SF-Stockton-St bug). Never auto-fill it; ask for manual miles.
    const oneWay = meters / 1609.344;
    if (oneWay > 300) {
      return manual(`That route came out to ~${Math.round(oneWay)} mi one-way — likely a wrong address match. Check the start/destination, or type the miles.`, "implausible_distance");
    }
    const roundtrip = body.roundtrip !== false; // default true
    const miles = Math.round((meters / 1609.344) * (roundtrip ? 2 : 1) * 100) / 100;

    return json({ ok: true, miles, source: "ors", roundtrip, start_label: sLabel, start_lat: sLat, start_lng: sLng });
  } catch (e) {
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
