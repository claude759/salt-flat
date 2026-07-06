// admin-create-ba: an admin creates a BA (or another admin) account.
// Verifies the caller is an active admin, then service-role-creates the auth user
// and a matching profiles row (must_change_password = true so they reset on first login).
import { admin, caller, json, preflight } from "../_shared/util.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);
    if (who.profile?.role !== "admin" || who.profile?.active === false) {
      return json({ ok: false, error: "forbidden", message: "Admins only." }, 403);
    }

    const b = await req.json();
    const email = String(b.email ?? "").trim().toLowerCase();
    const password = String(b.password ?? "");
    const full_name = (b.full_name ?? "").trim();
    const role = b.role === "admin" ? "admin" : "ba";
    let region = ["CA", "FL", "NY"].includes(b.region) ? b.region : null;
    // Regional admins (admin WITH a region) may only create accounts in their own
    // region — never a universal admin, never another state. Universal admins
    // (region null) may create anyone, anywhere.
    const callerRegion = who.profile?.region ?? null;
    if (callerRegion) {
      if (region !== callerRegion) {
        return json({ ok: false, error: "forbidden", message: `You can only create ${callerRegion} accounts.` }, 403);
      }
      region = callerRegion; // pin it, no universal-admin (null) escapes
    }
    if (!email || password.length < 8) {
      return json({ ok: false, error: "bad_input", message: "Email and an 8+ char temp password are required." }, 400);
    }

    const db = admin();
    const { data: created, error: cErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // no email round-trip; admin vouches for the account
      user_metadata: { full_name, role },
    });
    if (cErr || !created?.user) {
      return json({ ok: false, error: "create_failed", message: cErr?.message ?? "could not create user" }, 400);
    }

    // the on_auth_user_created trigger inserts a base profile (role 'ba'); enrich
    // it here. If this fails, roll back the auth user so we don't strand a
    // half-created, under-privileged account.
    const { error: pErr } = await db.from("profiles").upsert({
      id: created.user.id,
      email,
      full_name: full_name || email,
      role,
      region,
      phone: b.phone ?? null,
      base_address: b.base_address ?? null,
      must_change_password: true,
      active: true,
    }, { onConflict: "id" });
    if (pErr) {
      await db.auth.admin.deleteUser(created.user.id).catch(() => {});
      return json({ ok: false, error: "profile_failed", message: pErr.message }, 400);
    }

    return json({ ok: true, user_id: created.user.id, email });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
