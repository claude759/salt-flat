// ba-notify: outbound email for the BA app. Two jobs, both server-triggered:
//   job:'reminder'  — cron-driven. At 11am America/Los_Angeles the day after a pay
//                     period ends, email every active BA who hasn't submitted.
//   job:'submitted' — DB-trigger-driven. The moment a BA's period flips to
//                     'submitted', email the admin (gianni@wizardtrees.com).
// Sends via Gmail SMTP (app password). Callers prove themselves with a shared
// secret held in Vault — verified by the ba_notify_authorized() RPC, so this
// function never holds the raw secret and randoms can't trigger email blasts.
import { admin, json, preflight } from "../_shared/util.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const APP_URL = "https://claude759.github.io/salt-flat/ba/";
const TZ = "America/Los_Angeles";
const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const FROM_NAME = Deno.env.get("GMAIL_FROM_NAME") ?? "Wizard Trees";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "";

const money = (n: unknown) =>
  "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// current wall-clock date + hour in Los Angeles (DST-correct)
function laParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
// shift a YYYY-MM-DD by n days (noon-anchored so DST can't roll the date)
function addDaysISO(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function periodLabel(p: { label?: string; start_date: string; end_date: string }) {
  return p.label || `${p.start_date} – ${p.end_date}`;
}

let _smtp: SMTPClient | null = null;
async function sendMail(to: string, subject: string, html: string, text: string, cc?: string[]) {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error("email_not_configured");
  _smtp ??= new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_PASS } },
  });
  // collapse template indentation: whitespace-only lines were quoted-printable-encoded
  // and rendered as a literal '=20' in some clients (seen in Gmail)
  const flat = html.replace(/\n\s*/g, "");
  const msg: Record<string, unknown> = { from: `${FROM_NAME} <${GMAIL_USER}>`, to, subject, content: text, html: flat };
  if (cc && cc.length) msg.cc = cc;
  await _smtp.send(msg as never);
}

function shell(title: string, body: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <div style="background:#6c5ce7;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:17px">🌲 ${esc(title)}</div>
    <div style="border:1px solid #e6e6e6;border-top:0;border-radius:0 0 12px 12px;padding:20px">${body}</div>
  </div>`;
}
function reminderEmail(name: string, p: any) {
  const lbl = esc(periodLabel(p));
  const html = shell("Time to submit your mileage & expenses", `
    <p style="margin:0 0 12px">Hi ${esc(name || "there")},</p>
    <p style="margin:0 0 12px">The pay period <b>${lbl}</b> ended on <b>${esc(p.end_date)}</b>, and we don't have your mileage &amp; expenses yet.</p>
    <p style="margin:0 0 18px">Please open the app and submit them so you can be reimbursed on time.</p>
    <p style="margin:0 0 8px"><a href="${APP_URL}" style="background:#6c5ce7;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:700;display:inline-block">Open the app &amp; submit →</a></p>
    <p style="margin:16px 0 0;color:#888;font-size:12px">If you've already submitted, thank you — you can ignore this.</p>`);
  const text = `Hi ${name || "there"},\n\nThe pay period ${periodLabel(p)} ended ${p.end_date} and we don't have your mileage & expenses yet. Please submit them: ${APP_URL}\n\nIf you've already submitted, ignore this.`;
  return { subject: `Reminder: submit your mileage & expenses (period ending ${p.end_date})`, html, text };
}
function submittedEmail(ba: any, p: any, sub: any) {
  const t = sub?.totals || {};
  const lbl = esc(periodLabel(p));
  const row = (k: string, v: string) => `<tr><td style="padding:4px 0;color:#555">${k}</td><td style="padding:4px 0;text-align:right;font-weight:600">${v}</td></tr>`;
  const html = shell("A BA submitted mileage & expenses", `
    <p style="margin:0 0 12px"><b>${esc(ba?.full_name || "A brand ambassador")}</b> just submitted for the period <b>${lbl}</b>.</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px">
      ${row("Mileage", money(t.mileage))}
      ${row("Expenses (reimburse)", money(t.expenses))}
      ${t.company_card ? row("Company card (not reimbursed)", money(t.company_card)) : ""}
      ${t.labor ? row("Labor (recorded)", money(t.labor)) : ""}
      <tr><td style="padding:8px 0 0;border-top:1px solid #eee;font-weight:700">Reimburse total</td><td style="padding:8px 0 0;border-top:1px solid #eee;text-align:right;font-weight:700">${money(t.total ?? (Number(t.mileage||0)+Number(t.expenses||0)))}</td></tr>
    </table>
    <p style="margin:0"><a href="${APP_URL}" style="background:#6c5ce7;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:700;display:inline-block">Review in the app →</a></p>`);
  const text = `${ba?.full_name || "A BA"} submitted for ${periodLabel(p)}. Mileage ${money(t.mileage)}, Expenses ${money(t.expenses)}, Reimburse total ${money(t.total ?? (Number(t.mileage||0)+Number(t.expenses||0)))}. Review: ${APP_URL}`;
  return { subject: `${ba?.full_name || "A BA"} submitted mileage & expenses (${periodLabel(p)})`, html, text };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const body = await req.json().catch(() => ({}));
    const job = body.job;
    const db = admin();

    // authorize: the shared secret lives in Vault; the RPC returns true/false so
    // we never pull the raw value into this function.
    const secret = req.headers.get("x-notify-secret") ?? "";
    const { data: ok } = await db.rpc("ba_notify_authorized", { candidate: secret });
    if (ok !== true) return json({ ok: false, error: "forbidden" }, 403);

    const dry = body.dry_run === true;      // compute recipients, don't send
    const testTo = body.test_to as string | undefined; // divert real sends to one address

    if (job === "reminder") {
      const force = body.force === true;    // bypass the 11am/once guards for testing
      const { date, hour } = laParts();
      if (!force && hour !== 11) return json({ ok: true, skipped: `not 11am LA (hour ${hour})` });
      // period that ended "yesterday" in LA (force+ended_on lets a test point at a past period)
      const endedOn = (force && typeof body.ended_on === "string") ? body.ended_on : addDaysISO(date, -1);
      const { data: periods } = await db.from("pay_periods").select("*").eq("end_date", endedOn).limit(1);
      const period = periods?.[0];
      if (!period) return json({ ok: true, skipped: `no pay period ended ${endedOn}` });
      if (period.reminder_sent_at && !force) return json({ ok: true, skipped: "reminder already sent for this period" });

      const { data: bas } = await db.from("profiles").select("id,full_name,email").eq("role", "ba").eq("active", true);
      const { data: subs } = await db.from("submissions").select("ba_id").eq("period_id", period.id).in("status", ["submitted", "approved"]);
      const done = new Set((subs || []).map((s) => s.ba_id));
      const targets = (bas || []).filter((b) => !done.has(b.id) && b.email);

      if (dry) return json({ ok: true, period: period.end_date, would_remind: targets.map((b) => ({ name: b.full_name, email: testTo || b.email })) });

      const sent: any[] = [];
      for (const b of targets) {
        const { subject, html, text } = reminderEmail(b.full_name, period);
        const to = testTo || b.email;
        // CC the admin on every reminder (per Gianni 2026-07-18) — skipped on diverted test sends
        const cc = (!testTo && ADMIN_EMAIL && ADMIN_EMAIL !== to) ? [ADMIN_EMAIL] : undefined;
        try { await sendMail(to, subject, html, text, cc); sent.push({ to, ok: true }); }
        catch (e) { sent.push({ to, ok: false, error: String((e as Error)?.message || e) }); }
      }
      // stamp so it never re-sends (skip stamping for test/diverted runs)
      if (!testTo && sent.some((s) => s.ok)) await db.from("pay_periods").update({ reminder_sent_at: new Date().toISOString() }).eq("id", period.id);
      return json({ ok: true, period: period.end_date, reminded: sent });
    }

    if (job === "submitted") {
      const { ba_id, period_id } = body;
      if (!ba_id || !period_id) return json({ ok: false, error: "ba_id and period_id required" }, 400);
      const [{ data: ba }, { data: period }, { data: sub }] = await Promise.all([
        db.from("profiles").select("full_name,email,region").eq("id", ba_id).single(),
        db.from("pay_periods").select("*").eq("id", period_id).single(),
        db.from("submissions").select("*").eq("ba_id", ba_id).eq("period_id", period_id).maybeSingle(),
      ]);
      const to = testTo || ADMIN_EMAIL;
      if (!to) return json({ ok: false, error: "ADMIN_EMAIL not set" }, 200);
      // CC the submitting BA's REGIONAL admins (e.g. Maddy for NY) — active admin
      // profiles whose region matches; never the automation login or the To recipient
      let cc: string[] = [];
      if (ba?.region) {
        const { data: regAdmins } = await db.from("profiles").select("email")
          .eq("role", "admin").eq("region", ba.region).eq("active", true);
        cc = (regAdmins || []).map((a: { email: string }) => a.email)
          .filter((e: string) => e && e !== to && e !== ba?.email && !/^automation@/i.test(e));
      }
      const { subject, html, text } = submittedEmail(ba, period, sub);
      if (dry) return json({ ok: true, would_notify: to, cc, subject });
      await sendMail(to, subject, html, text, cc);
      return json({ ok: true, notified: to, cc });
    }

    return json({ ok: false, error: "unknown job" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
