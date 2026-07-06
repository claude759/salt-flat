// Shared Gmail SMTP sender for the account edge functions (invite / password reset).
// Reads the same GMAIL_* secrets ba-notify uses; sending is always best-effort so a
// mail hiccup never fails the account action that called it.
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const FROM_NAME = Deno.env.get("GMAIL_FROM_NAME") ?? "Wizard Trees";
export const APP_URL = "https://claude759.github.io/salt-flat/ba/";
export const emailConfigured = () => !!(GMAIL_USER && GMAIL_PASS);
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export async function sendMail(opts: { to: string; cc?: string[]; subject: string; html: string; text: string }) {
  if (!emailConfigured()) throw new Error("email_not_configured");
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_PASS } },
  });
  try {
    await client.send({
      from: `${FROM_NAME} <${GMAIL_USER}>`,
      to: opts.to,
      cc: opts.cc && opts.cc.length ? opts.cc : undefined,
      subject: opts.subject,
      content: opts.text,
      html: opts.html,
    });
  } finally {
    await client.close();
  }
}

export function mailShell(title: string, body: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <div style="background:#6c5ce7;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:17px">🌲 ${esc(title)}</div>
    <div style="border:1px solid #e6e6e6;border-top:0;border-radius:0 0 12px 12px;padding:20px">${body}</div>
  </div>`;
}
export function btn(href: string, label: string) {
  return `<a href="${esc(href)}" style="background:#6c5ce7;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:700;display:inline-block">${esc(label)}</a>`;
}
export function credBox(rows: [string, string][]) {
  return `<div style="background:#f5f4ff;border-radius:10px;padding:12px 14px;margin:12px 0">` +
    rows.map(([k, v]) => `<div style="font-size:12px;color:#555;margin-top:6px">${esc(k)}</div><b style="font-size:15px">${esc(v)}</b>`).join("") +
    `</div>`;
}

// the list of admin emails to CC on account notifications: active admins, minus the
// recipient and minus the gusto-sync service account (automation@… has no real mailbox,
// so CC'ing it just bounces).
export async function adminCcList(db: { from: (t: string) => any }, exclude?: string) {
  const { data } = await db.from("profiles").select("email").eq("role", "admin").eq("active", true).not("email", "is", null);
  const ex = (exclude || "").toLowerCase();
  return [...new Set(
    (data || []).map((a: { email: string }) => a.email)
      .filter((e: string) => e && e.toLowerCase() !== ex && !/^automation@/i.test(e)),
  )];
}
