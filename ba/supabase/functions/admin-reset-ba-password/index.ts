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
import { adminCcList, APP_URL, btn, credBox, esc, mailShell, sendMail } from "../_shared/mail.ts";

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
    const { data: target, error: tErr } = await db.from("profiles").select("id,email,region,full_name").eq("id", user_id).single();
    if (tErr || !target) return json({ ok: false, error: "not_found", message: "No such user." }, 404);
    // regional admins can only reset accounts in their own region
    const callerRegion = who.profile?.region ?? null;
    if (callerRegion && target.region !== callerRegion) {
      return json({ ok: false, error: "forbidden", message: `You can only manage ${callerRegion} accounts.` }, 403);
    }

    const { error: uErr } = await db.auth.admin.updateUserById(user_id, { password });
    if (uErr) return json({ ok: false, error: "reset_failed", message: uErr.message }, 400);

    await db.from("profiles").update({ must_change_password: true }).eq("id", user_id);

    // best-effort reset email to the user, CC'ing the admin team
    let emailed = false;
    try {
      const cc = await adminCcList(db, target.email);
      const html = mailShell("Your app password was reset", `
        <p style="margin:0 0 12px">Hi ${esc(target.full_name || "there")}, an admin reset your password for the Wizard Trees field app.</p>
        ${credBox([["New temporary password", password]])}
        <p style="margin:0 0 14px;color:#777;font-size:13px">Sign in with it and you'll be prompted to choose a new one.</p>
        <p style="margin:0 0 12px">${btn(APP_URL, "Open the app →")}</p>
        <p style="margin:0;color:#888;font-size:12px">If you didn't expect this, contact your admin.</p>`);
      const text = `Hi ${target.full_name || "there"}, an admin reset your Wizard Trees app password.\nNew temporary password: ${password}\nSign in and choose a new one: ${APP_URL}`;
      await sendMail({ to: target.email, cc, subject: "Your Wizard Trees app password was reset", html, text });
      emailed = true;
    } catch (_) { /* email is best-effort */ }

    return json({ ok: true, user_id, email: target.email, emailed });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
