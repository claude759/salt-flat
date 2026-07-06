// admin-create-ba: an admin creates a BA (or another admin) account.
// Verifies the caller is an active admin, then service-role-creates the auth user
// and a matching profiles row (must_change_password = true so they reset on first login).
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

    // best-effort invite email (never fails the account creation), CC'ing the admin team
    let emailed = false;
    try {
      const cc = await adminCcList(db, email, region);
      const html = mailShell("You're set up on the Wizard Trees field app", `
        <p style="margin:0 0 12px">Hi ${esc(full_name || "there")}, an admin just set you up on the Wizard Trees brand-ambassador app.</p>
        ${credBox([["Your login", email], ["Temporary password", password]])}
        <p style="margin:0 0 14px;color:#777;font-size:13px">You'll choose your own password the first time you sign in.</p>
        <p style="margin:0 0 16px">${btn(APP_URL, "Open the app →")}</p>
        <p style="margin:0 0 6px;font-weight:700">What you can do in seconds:</p>
        <ul style="margin:0 0 14px;padding-left:18px;line-height:1.7">
          <li>🚗 <b>Log mileage</b> — by address, a navigation screenshot, or odometer photos (it works out the miles for you)</li>
          <li>🧾 <b>Add expenses</b> — snap a receipt and it fills in the vendor &amp; amount</li>
          <li>📅 <b>Submit each pay period</b> to get reimbursed</li>
          <li>🔐 Turn on <b>Face ID / fingerprint</b> for quick sign-in</li>
        </ul>
        <p style="margin:0;color:#888;font-size:12px">Tip: open this on your phone and "Add to Home Screen" so it feels like a real app.</p>`);
      const text = `Hi ${full_name || "there"}, you've been set up on the Wizard Trees field app.\n\nLogin: ${email}\nTemporary password: ${password} (you'll set your own on first sign-in)\nOpen: ${APP_URL}\n\nWhat you can do: log mileage (by address, a nav screenshot, or odometer photos), add expenses by snapping a receipt, and submit each pay period for reimbursement.`;
      await sendMail({ to: email, cc, subject: "Welcome to the Wizard Trees field app", html, text });
      emailed = true;
    } catch (_) { /* email is best-effort */ }

    return json({ ok: true, user_id: created.user.id, email, emailed });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
