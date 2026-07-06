// admin-reset-ba-password: an admin resets a user's login password to a new
// temporary one. Verifies the caller is an active admin, sets the new password
// via the service role, and flags must_change_password so the user chooses their
// own on next sign-in.
//
// NOTE: passwords are stored as one-way hashes and can never be read back — not
// by an admin, not by this function. This reset is the supported way for an admin
// to restore a user's access; the new temp password is returned once for the
// admin to hand off.
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
    const user_id = String(b.user_id ?? "").trim();
    const password = String(b.password ?? "");
    if (!user_id || password.length < 8) {
      return json({ ok: false, error: "bad_input", message: "user_id and an 8+ char password are required." }, 400);
    }

    const db = admin();
    // only reset real profiles in this app — never arbitrary auth users
    const { data: target, error: tErr } = await db.from("profiles").select("id,email,region").eq("id", user_id).single();
    if (tErr || !target) return json({ ok: false, error: "not_found", message: "No such user." }, 404);
    // regional admins can only reset accounts in their own region
    const callerRegion = who.profile?.region ?? null;
    if (callerRegion && target.region !== callerRegion) {
      return json({ ok: false, error: "forbidden", message: `You can only manage ${callerRegion} accounts.` }, 403);
    }

    const { error: uErr } = await db.auth.admin.updateUserById(user_id, { password });
    if (uErr) return json({ ok: false, error: "reset_failed", message: uErr.message }, 400);

    await db.from("profiles").update({ must_change_password: true }).eq("id", user_id);
    return json({ ok: true, user_id, email: target.email });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
