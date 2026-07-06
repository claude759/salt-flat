// admin-resend-invite: re-send the welcome invite to existing user(s). Temp passwords
// can't be read back, so this issues a FRESH temp password (flagging
// must_change_password) and emails the full invite with the app link. Accepts one
// user_id or a user_ids[] array. Region-scoped and CC'd exactly like account creation.
import { admin, caller, json, preflight } from "../_shared/util.ts";
import { adminCcList, inviteEmail, sendMail } from "../_shared/mail.ts";

const tempPw = () => "wt-" + crypto.randomUUID().replace(/-/g, "").slice(0, 6);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const who = await caller(req);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);
    if (who.profile?.role !== "admin" || who.profile?.active === false) {
      return json({ ok: false, error: "forbidden", message: "Admins only." }, 403);
    }

    const b = await req.json();
    const ids: string[] = Array.isArray(b.user_ids) ? b.user_ids : (b.user_id ? [String(b.user_id)] : []);
    if (!ids.length) return json({ ok: false, error: "bad_input", message: "user_id or user_ids[] required." }, 400);

    const db = admin();
    const callerRegion = who.profile?.region ?? null;
    const results: unknown[] = [];
    for (const user_id of ids) {
      const { data: t } = await db.from("profiles").select("id,email,full_name,region").eq("id", user_id).maybeSingle();
      if (!t || !t.email) { results.push({ user_id, ok: false, error: "not_found" }); continue; }
      if (callerRegion && t.region !== callerRegion) { results.push({ user_id, ok: false, error: "forbidden" }); continue; }
      const password = tempPw();
      const { error: uErr } = await db.auth.admin.updateUserById(user_id, { password });
      if (uErr) { results.push({ user_id, email: t.email, ok: false, error: uErr.message }); continue; }
      await db.from("profiles").update({ must_change_password: true }).eq("id", user_id);
      let emailed = false;
      try {
        const cc = await adminCcList(db, t.email, t.region);
        const { subject, html, text } = inviteEmail(t.full_name, t.email, password);
        await sendMail({ to: t.email, cc, subject, html, text });
        emailed = true;
      } catch (_) { /* best-effort */ }
      results.push({ user_id, email: t.email, ok: true, emailed });
    }
    return json({ ok: true, results });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
