// calc-distance: round-trip driving miles from a BA's saved base to a dispensary.
// Always computed from the caller's OWN profile base (so the cached value the trips
// trigger trusts can't be spoofed by a client-supplied base). Geocodes base +
// dispensary lazily, caches per (ba_id, dispensary), and only calls Google on a
// cache miss. Every Google failure returns a graceful 200 {ok:false} — never a 500
// echoing provider internals — so the client falls back to manual miles.
import { admin, caller, json, preflight } from "../_shared/util.ts";

const MAPS_KEY = Deno.env.get("GOOGLE_MAPS_KEY");

async function geocode(address: string) {
  if (!MAPS_KEY) return null;
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", address);
    u.searchParams.set("key", MAPS_KEY);
    const r = await fetch(u).then((x) => x.json());
    const loc = r?.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch {
    return null;
  }
}

// one-way driving meters, or null on any failure (bad key, no route, quota, network)
async function drivingMetersOneWay(o: { lat: number; lng: number }, d: { lat: number; lng: number }) {
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    u.searchParams.set("origins", `${o.lat},${o.lng}`);
    u.searchParams.set("destinations", `${d.lat},${d.lng}`);
    u.searchParams.set("mode", "driving");
    u.searchParams.set("units", "imperial");
    u.searchParams.set("key", MAPS_KEY!);
    const r = await fetch(u).then((x) => x.json());
    const el = r?.rows?.[0]?.elements?.[0];
    if (el?.status !== "OK") return null;
    return el.distance.value as number;
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

    const { dispensary_id } = await req.json();
    if (!dispensary_id) return json({ ok: false, error: "dispensary_id required" }, 400);
    if (!MAPS_KEY) return manual("Auto-distance unavailable — enter miles manually.", "no_maps_key");

    const db = admin();

    // base = the caller's OWN saved base; geocode the address lazily. If we have to
    // (re)geocode, the base may have moved, so drop this BA's cached distances.
    let baseLat = who.profile?.base_lat;
    let baseLng = who.profile?.base_lng;
    if ((baseLat == null || baseLng == null) && who.profile?.base_address) {
      const g = await geocode(who.profile.base_address);
      if (g) {
        baseLat = g.lat; baseLng = g.lng;
        await db.from("profiles").update({ base_lat: baseLat, base_lng: baseLng }).eq("id", who.user.id);
        await db.from("distance_cache").delete().eq("ba_id", who.user.id); // stale vs new base
      }
    }
    if (baseLat == null || baseLng == null) {
      return manual("Set your home/base address in Profile first.", "no_base");
    }

    const { data: disp } = await db.from("dispensaries").select("*").eq("id", dispensary_id).single();
    if (!disp) return json({ ok: false, error: "dispensary_not_found" }, 404);

    // cache hit (per BA + dispensary)?
    const { data: cached } = await db.from("distance_cache")
      .select("miles_round").eq("ba_id", who.user.id).eq("dispensary_id", dispensary_id).maybeSingle();
    if (cached) return json({ ok: true, miles: Number(cached.miles_round), source: "maps_cache" });

    // geocode dispensary lazily
    let dLat = disp.lat, dLng = disp.lng;
    if ((dLat == null || dLng == null) && disp.address) {
      const g = await geocode(disp.address);
      if (g) { dLat = g.lat; dLng = g.lng; await db.from("dispensaries").update({ lat: dLat, lng: dLng }).eq("id", dispensary_id); }
    }
    if (dLat == null || dLng == null) {
      return manual("Dispensary address missing/uncodable — enter miles manually.", "no_dispensary_location");
    }

    const meters = await drivingMetersOneWay({ lat: baseLat, lng: baseLng }, { lat: dLat, lng: dLng });
    if (meters == null) return manual("Couldn’t compute the route — enter miles manually.", "route_unavailable");

    const milesRound = Math.round((meters / 1609.344) * 2 * 100) / 100; // round trip, 2dp
    await db.from("distance_cache").upsert(
      { ba_id: who.user.id, dispensary_id, miles_round: milesRound },
      { onConflict: "ba_id,dispensary_id" },
    );
    return json({ ok: true, miles: milesRound, source: "maps_live" });
  } catch (e) {
    return json({ ok: false, error: "internal_error" }, 500); // never echo internals
  }
});
