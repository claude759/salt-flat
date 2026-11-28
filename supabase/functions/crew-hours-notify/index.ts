// crew-hours-notify: the Crew hours page's emails (supabase/crew-hours.sql, crew-hours.html).
//   job:'remind'    - cron every half hour (crew-hours-reminders). Sends each reminder once, only while the pay
//                     period is not submitted, at its time in Los Angeles (Gianni 2026-11-28):
//                       friday   the period's last day from 6:30 pm: "submit all hours by Saturday 11 am"
//                       saturday the next day from 11 am: still not submitted
//                       sunday   the day after from 11 am: still not submitted
//                     to the people who enter crew hours (crew_hours_access: can_enter, not can_approve).
//   job:'submitted' - from crew_submit(): tells the approver (Gianni) a period is waiting for approval.
// Sends via Gmail SMTP with the project's GMAIL_USER / GMAIL_APP_PASSWORD (the BA app's mail account).
// Callers prove themselves with the crew_notify_secret held in Vault, checked by crew_notify_authorized(),
// so this function never holds the secret and nobody else can make it send. Self-contained (no _shared
// import): it deploys from the repo root like read-timesheet. Deploy with --no-verify-jwt.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { dueReminder, laNow, periodLabel } from "./schedule.js";

const PAGE_URL = "https://claude759.github.io/salt-flat/crew-hours.html";
const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const FROM_NAME = Deno.env.get("GMAIL_FROM_NAME") ?? "Wizard Trees";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

let _smtp: SMTPClient | null = null;
async function sendMail(to: string[], subject: string, html: string, text: string) {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error("email_not_configured");
  _smtp ??= new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_PASS } },
  });
  const flat = html.replace(/\n\s*/g, "");                       // see ba-notify: no '=20' lines
  const ascii = subject.replace(/[–—]/g, "-").replace(/[^\x20-\x7E]/g, ""); // see ba-notify: ASCII subjects
  await _smtp.send({ from: `${FROM_NAME} <${GMAIL_USER}>`, to, subject: ascii, content: text, html: flat } as never);
}
function dropMail() {
  const c = _smtp;
  _smtp = null;
  try { Promise.resolve(c?.close()).catch(() => {}); } catch { /* already gone */ }
}
function shell(title: string, body: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <div style="background:#2f6b45;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:17px">${esc(title)}</div>
    <div style="border:1px solid #e6e6e6;border-top:0;border-radius:0 0 12px 12px;padding:20px;font-size:15px;line-height:1.5">${body}</div>
  </div>`;
}
function button(href: string, label: string) {
  return `<p style="margin:18px 0 4px"><a href="${esc(href)}" style="background:#2f6b45;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${esc(label)}</a></p>`;
}

async function recipients(approvers: boolean): Promise<string[]> {
  const { data, error } = await db.from("crew_hours_access").select("email,can_enter,can_approve,active");
  if (error) throw new Error(error.message);
  return (data || [])
    .filter((a: any) => a.active && (approvers ? a.can_approve : a.can_enter && !a.can_approve))
    .map((a: any) => a.email);
}
async function alreadySent(period: string, kind: string) {
  const { data, error } = await db.from("crew_reminder_log").select("kind").eq("pay_period", period).eq("kind", kind).maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}
async function logSent(period: string, kind: string, to: string[]) {
  const { error } = await db.from("crew_reminder_log").insert({ pay_period: period, kind, sent_to: to.join(", ") });
  if (error && !/duplicate/i.test(error.message)) throw new Error(error.message);
}
async function summary(period: string): Promise<any> {
  const { data, error } = await db.rpc("crew_period_summary", { p_period: period });
  if (error) throw new Error(error.message);
  return data || {};
}

async function remind(nowISO?: string, dry = false) {
  const { date, mins } = laNow(nowISO ? new Date(nowISO) : new Date());
  const due = dueReminder(date, mins);
  if (!due) return { sent: 0, why: "no reminder due now" };
  const { data: sub, error } = await db.from("crew_submissions").select("status").eq("pay_period", due.period).maybeSingle();
  if (error) throw new Error(error.message);
  if (sub) return { sent: 0, why: `already ${sub.status}` };
  if (await alreadySent(due.period, due.kind)) return { sent: 0, why: `${due.kind} already sent` };
  const to = await recipients(false);
  if (!to.length) return { sent: 0, why: "nobody to remind" };
  const sm = await summary(due.period);
  const label = periodLabel(due.period);
  const so = `So far the page has ${sm.people ?? 0} people and ${Number(sm.hours ?? 0).toLocaleString("en-US")} hours for this pay period.`;
  let subject: string, lead: string;
  if (due.kind === "friday") {
    subject = `Crew hours due Saturday 11 am (${label})`;
    lead = `The pay period ${label} ends today. Please add any sign-in sheets that are still missing and press <b>Submit</b> on the Crew hours page by <b>Saturday at 11 am</b>.`;
  } else if (due.kind === "saturday") {
    subject = `Reminder: crew hours for ${label} were due at 11 am`;
    lead = `The crew hours for ${label} haven't been submitted yet. They were due at 11 am today. Please add anything missing and press <b>Submit</b> on the Crew hours page.`;
  } else {
    subject = `Reminder 2: crew hours for ${label} still not submitted`;
    lead = `The crew hours for ${label} still haven't been submitted. Please press <b>Submit</b> on the Crew hours page today so they can be paid.`;
  }
  const link = `${PAGE_URL}?period=${due.period}`;
  const html = shell("Crew hours", `<p>Hi,</p><p>${lead}</p><p style="color:#555">${esc(so)}</p>${button(link, "Open Crew hours")}`);
  const text = `${lead.replace(/<[^>]+>/g, "")}\n\n${so}\n\n${link}\n`;
  if (dry) return { dry: true, kind: due.kind, period: due.period, to, subject, text };
  try { await sendMail(to, subject, html, text); } catch (e) { dropMail(); throw e; }
  await logSent(due.period, due.kind, to);
  return { sent: to.length, kind: due.kind, period: due.period };
}

async function submitted(period: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period || "")) throw new Error("bad_period");
  if (await alreadySent(period, "submitted")) return { sent: 0, why: "already told" };
  const { data: sub, error } = await db.from("crew_submissions").select("status,submitted_by,summary").eq("pay_period", period).maybeSingle();
  if (error) throw new Error(error.message);
  if (!sub || sub.status !== "submitted") return { sent: 0, why: "not submitted" };
  const to = await recipients(true);
  if (!to.length) return { sent: 0, why: "no approver" };
  const sm = sub.summary || (await summary(period));
  const label = periodLabel(period);
  const who = String(sub.submitted_by || "Someone").split("@")[0];
  const name = who.charAt(0).toUpperCase() + who.slice(1);
  const money = Number(sm.total ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const line = `${sm.people ?? 0} people, ${Number(sm.hours ?? 0).toLocaleString("en-US")} hours, ${money} (${sm.lines ?? 0} lines).`;
  const link = `${PAGE_URL}?period=${period}`;
  const subject = `Crew hours submitted for ${label}`;
  const html = shell("Crew hours submitted",
    `<p>${esc(name)} submitted the crew hours for <b>${esc(label)}</b>.</p><p>${esc(line)}</p>${button(link, "Review and approve")}`);
  const text = `${name} submitted the crew hours for ${label}.\n${line}\n\nReview and approve: ${link}\n`;
  try { await sendMail(to, subject, html, text); } catch (e) { dropMail(); throw e; }
  await logSent(period, "submitted", to);
  return { sent: to.length };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const secret = req.headers.get("x-notify-secret") ?? "";
    const { data: ok, error } = await db.rpc("crew_notify_authorized", { candidate: secret });
    if (error || ok !== true) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    // now and dry are for checking the reminders without waiting for Friday (dry sends and logs nothing)
    if (body.job === "remind") return json(await remind(body.now, body.dry === true));
    if (body.job === "submitted") return json(await submitted(body.pay_period));
    return json({ error: "unknown job" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
