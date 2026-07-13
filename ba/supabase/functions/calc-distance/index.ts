// calc-distance: driving miles from a starting location to a dispensary.
// Geocoding = Photon (komoot, OSM) and routing = OSRM demo — both keyless; the old
// OpenRouteService key got disallowed (403 on every endpoint), which silently killed
// all auto-distance. Start can be GPS coords (start_lat/start_lng), a typed address
// (start_address), or — if neither — the trip owner's saved base address. Round-trip
// by default. Geocoded coords are cached onto the profile/dispensary rows so we only
// geocode once. Any failure returns a graceful 200 {ok:false} so the BA types miles.
import { admin, caller, json, preflight } from "../_shared/util.ts";

const UA = { "User-Agent": "wizardtrees-ba-app/1.0" };

// Keep ambiguous addresses in the BA's part of the country. A bias point only
// RE-RANKS results — "376 stockton st" still matched Stockton St, San Francisco.
// bbox (the BA's whole state) is a HARD filter, so out-of-state matches are
// impossible; the bias point then picks the closest in-state hit.
const REGION_FOCUS: Record<string, { lat: number; lng: number }> = {
  NY: { lat: 40.71, lng: -74.0 },
  CA: { lat: 34.05, lng: -118.24 },
  FL: { lat: 26.12, lng: -80.14 },
};
const REGION_RECT: Record<string, [number, number, number, number]> = {   // [min_lon, min_lat, max_lon, max_lat]
  NY: [-79.90, 40.45, -71.70, 45.05],
  CA: [-124.60, 32.40, -114.00, 42.10],
  FL: [-87.70, 24.30, -79.80, 31.10],
};
async function geocode(address: string, focus?: { lat: number; lng: number } | null, rect?: [number, number, number, number] | null) {
  try {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", address);
    u.searchParams.set("limit", "5");
    if (focus) { u.searchParams.set("lat", String(focus.lat)); u.searchParams.set("lon", String(focus.lng)); }
    if (rect) u.searchParams.set("bbox", rect.join(","));
    const r = await fetch(u, { headers: UA }).then((x) => x.json());
    const f = (r?.features ?? []).find((f: any) => f?.properties?.countrycode === "US" && Array.isArray(f?.geometry?.coordinates));
    return f ? { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] } : null;
  } catch {
    return null;
  }
}
// "376 stockton st" typed by hand ≈ "376 Stockton St, Brooklyn, NY 11206" saved on the
// profile — compare the first 3 normalized tokens (joining hyphenated leading numbers)
const addrSig = (s: string) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/^(\d+) (\d+) /, "$1$2 ").split(" ").slice(0, 3).join(" ");

// one-way driving meters via the OSRM demo router, or null on any failure
async function drivingMeters(o: { lat: number; lng: number }, d: { lat: number; lng: number }) {
  try {
    const u = `https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=false`;
    const r = await fetch(u, { headers: UA }).then((x) => x.json());
    const m = r?.routes?.[0]?.distance;
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

    const db = admin();

    // geocode bias: the trip OWNER's coords/region — when an admin edits a BA's trip
    // (body.for_ba), bias to that BA, not the admin (a CA admin fixing a NY trip must
    // not pull ambiguous addresses toward LA). Falls back to the caller's own profile.
    let fp = who.profile, fpId = who.user.id;
    if (body.for_ba && who.profile?.role === "admin") {
      const { data: t } = await db.from("profiles").select("id,base_address,base_lat,base_lng,region").eq("id", String(body.for_ba)).maybeSingle();
      if (t) { fp = t; fpId = t.id; }
    }
    const focus = (fp?.base_lat != null && fp?.base_lng != null)
      ? { lat: fp.base_lat, lng: fp.base_lng }
      : (REGION_FOCUS[fp?.region ?? ""] ?? null);
    const rect = REGION_RECT[fp?.region ?? ""] ?? null;

    // ── resolve START: GPS coords > typed address > saved base ──
    let sLat = body.start_lat, sLng = body.start_lng, sLabel: string | null = null;
    if (sLat != null && sLng != null) {
      sLabel = "Current location";
    } else if (body.start_address) {
      // a typed start that IS the BA's saved home ("376 stockton st") → use the saved
      // full address / cached coords instead of geocoding the ambiguous short form
      const typed = String(body.start_address);
      const isHome = fp?.base_address && addrSig(typed) === addrSig(fp.base_address);
      if (isHome && fp.base_lat != null && fp.base_lng != null) {
        sLat = fp.base_lat; sLng = fp.base_lng; sLabel = typed;
      } else {
        const g = await geocode(isHome ? fp.base_address : typed, focus, rect);
        if (!g) return manual("Couldn’t find that starting address — enter miles manually.", "geocode_start");
        sLat = g.lat; sLng = g.lng; sLabel = typed;
        if (isHome) await db.from("profiles").update({ base_lat: sLat, base_lng: sLng }).eq("id", fpId);
      }
    } else {
      // no start given → the trip owner's saved base (the BA's, not the admin's, when for_ba)
      sLat = fp?.base_lat; sLng = fp?.base_lng; sLabel = fp?.base_address ?? "Base";
      if ((sLat == null || sLng == null) && fp?.base_address) {
        const g = await geocode(fp.base_address, focus, rect);
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
          const g = await geocode(disp.address, focus, rect);
          if (g) { dLat = g.lat; dLng = g.lng; await db.from("dispensaries").update({ lat: dLat, lng: dLng }).eq("id", dispensary_id); }
        }
      }
    } else if (body.dest_lat != null && body.dest_lng != null) {
      dLat = body.dest_lat; dLng = body.dest_lng;
    } else if (body.dest_address) {
      const g = await geocode(String(body.dest_address), focus, rect);
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
