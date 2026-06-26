// calc-distance: driving miles from a starting location to a dispensary, via
// OpenRouteService (free, no credit card). Start can be GPS coords (start_lat/
// start_lng), a typed address (start_address), or — if neither — the caller's
// saved base address. Round-trip by default. Geocoded coords are cached onto the
// profile/dispensary rows so we only geocode once. Any failure returns a graceful
// 200 {ok:false} so the BA just types miles instead.
import { admin, caller, json, preflight } from "../_shared/util.ts";

const ORS_KEY = Deno.env.get("ORS_KEY");

async function geocode(address: string) {
  if (!ORS_KEY) return null;
  try {
    const u = new URL("https://api.openrouteservice.org/geocode/search");
    u.searchParams.set("api_key", ORS_KEY);
    u.searchParams.set("text", address);
    u.searchParams.set("boundary.country", "US");
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

    // ── resolve START: GPS coords > typed address > saved base ──
    let sLat = body.start_lat, sLng = body.start_lng, sLabel: string | null = null;
    if (sLat != null && sLng != null) {
      sLabel = "Current location";
    } else if (body.start_address) {
      const g = await geocode(String(body.start_address));
      if (!g) return manual("Couldn’t find that starting address — enter miles manually.", "geocode_start");
      sLat = g.lat; sLng = g.lng; sLabel = String(body.start_address);
    } else {
      sLat = who.profile?.base_lat; sLng = who.profile?.base_lng; sLabel = who.profile?.base_address ?? "Base";
      if ((sLat == null || sLng == null) && who.profile?.base_address) {
        const g = await geocode(who.profile.base_address);
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
          const g = await geocode(disp.address);
          if (g) { dLat = g.lat; dLng = g.lng; await db.from("dispensaries").update({ lat: dLat, lng: dLng }).eq("id", dispensary_id); }
        }
      }
    } else if (body.dest_lat != null && body.dest_lng != null) {
      dLat = body.dest_lat; dLng = body.dest_lng;
    } else if (body.dest_address) {
      const g = await geocode(String(body.dest_address));
      if (g) { dLat = g.lat; dLng = g.lng; }
    } else {
      return json({ ok: false, error: "destination required" }, 400);
    }
    if (dLat == null || dLng == null) return manual("Destination can’t be located — enter miles manually.", "no_dest");

    // ── route ──
    const meters = await drivingMeters({ lat: sLat, lng: sLng }, { lat: dLat, lng: dLng });
    if (meters == null) return manual("Couldn’t compute the route — enter miles manually.", "route_unavailable");
    const roundtrip = body.roundtrip !== false; // default true
    const miles = Math.round((meters / 1609.344) * (roundtrip ? 2 : 1) * 100) / 100;

    return json({ ok: true, miles, source: "ors", roundtrip, start_label: sLabel, start_lat: sLat, start_lng: sLng });
  } catch (e) {
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
