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
// The new-user invite. The "Open the app" link + plain URL sit ABOVE the (unique)
// credentials box so Gmail can't fold them into its "trimmed repeated content" (…),
// which was hiding the link when several identical invites went out together.
export function inviteEmail(fullName: string, email: string, password: string) {
  const html = mailShell("You're set up on the Wizard Trees field app", `
    <p style="margin:0 0 14px">Hi ${esc(fullName || "there")}, an admin just set you up on the Wizard Trees brand-ambassador app.</p>
    <p style="margin:0 0 6px">${btn(APP_URL, "Open the app →")}</p>
    <p style="margin:0 0 10px;font-size:13px;color:#555">or paste this into your browser: <a href="${esc(APP_URL)}">${esc(APP_URL)}</a></p>
    <p style="margin:0 0 16px;padding:9px 12px;background:#fff6e5;border-left:3px solid #e8a33d;border-radius:6px;font-size:13px"><b>Important:</b> open the link in <b>Safari or Chrome</b> — not the preview inside your email or text app. In those, the sign-in doesn't stick and you'll get an "auth session missing" error when setting your password.</p>
    ${credBox([["Your login", email], ["Temporary password", password]])}
    <p style="margin:0 0 14px;color:#777;font-size:13px">You'll choose your own password the first time you sign in.</p>
    <p style="margin:0 0 6px;font-weight:700">What you can do in seconds:</p>
    <ul style="margin:0 0 14px;padding-left:18px;line-height:1.7">
      <li>🚗 <b>Log mileage</b> — by address, a navigation screenshot, or odometer photos</li>
      <li>🧾 <b>Add expenses</b> — snap a receipt and it fills in the vendor &amp; amount</li>
      <li>📅 <b>Submit each pay period</b> to get reimbursed</li>
      <li>🔐 Turn on <b>Face ID / fingerprint</b> for quick sign-in</li>
    </ul>
    <p style="margin:0;color:#888;font-size:12px">Tip: open this on your phone and "Add to Home Screen" so it feels like a real app.</p>`);
  const text = `Hi ${fullName || "there"}, you've been set up on the Wizard Trees field app.\n\nOpen the app: ${APP_URL}\nIMPORTANT: open that link in Safari or Chrome — NOT the preview inside your email/text app, or the sign-in won't stick ("auth session missing").\n\nLogin: ${email}\nTemporary password: ${password} (you'll set your own on first sign-in)\n\nWhat you can do: log mileage (by address, a nav screenshot, or odometer photos), add expenses by snapping a receipt, and submit each pay period for reimbursement.`;
  return { subject: "Welcome to the Wizard Trees field app", html, text };
}
export function credBox(rows: [string, string][]) {
  return `<div style="background:#f5f4ff;border-radius:10px;padding:12px 14px;margin:12px 0">` +
    rows.map(([k, v]) => `<div style="font-size:12px;color:#555;margin-top:6px">${esc(k)}</div><b style="font-size:15px">${esc(v)}</b>`).join("") +
    `</div>`;
}

// Admins to CC on an account notification about a user in `region`:
//   • Universal Admins (no region) → CC'd on everything.
//   • Regional Admins → CC'd only when the affected user is in their own region.
// Always excludes the recipient and the gusto-sync service account (automation@… has
// no real mailbox, so CC'ing it just bounces).
export async function adminCcList(db: { from: (t: string) => any }, exclude?: string, region?: string | null) {
  const { data } = await db.from("profiles").select("email,region,home_region").eq("role", "admin").eq("active", true).not("email", "is", null);
  const ex = (exclude || "").toLowerCase();
  return [...new Set(
    (data || [])
      .filter((a: { region: string | null; home_region: string | null }) => {
        const scope = notifyScope(a);
        return scope == null || scope === region;
      })
      .map((a: { email: string }) => a.email)
      .filter((e: string) => e && e.toLowerCase() !== ex && !/^automation@/i.test(e)),
  )];
}

// Which region's notifications an admin receives:
//   • a REGIONAL admin (region set) → their own region, as before;
//   • a universal admin who still works a region themselves (home_region set) → that
//     region only, so Amanda gets CA submission alerts and not NY ones;
//   • a pure oversight admin (both null) → null, meaning every region.
// One definition, used by every mail path, so the rules can't drift apart.
export const notifyScope = (p: { region?: string | null; home_region?: string | null } | null | undefined) =>
  (p?.region ?? p?.home_region ?? null);

// The admins to CC about one person's submission/approval: those whose notification
// scope covers that person's own region. `subject` is the BA the mail is ABOUT.
export async function regionCcList(
  db: { from: (t: string) => any },
  subject: { region?: string | null; home_region?: string | null; email?: string | null } | null,
  exclude: (string | null | undefined)[] = [],
) {
  const theirs = notifyScope(subject);
  if (!theirs) return [];
  const { data } = await db.from("profiles").select("email,region,home_region")
    .eq("role", "admin").eq("active", true).not("email", "is", null);
  const ex = new Set(exclude.filter(Boolean).map((e) => String(e).toLowerCase()));
  return [...new Set(
    (data || [])
      .filter((a: { region: string | null; home_region: string | null }) => notifyScope(a) === theirs)
      .map((a: { email: string }) => a.email)
      .filter((e: string) => e && !ex.has(e.toLowerCase()) && !/^automation@/i.test(e)),
  )];
}
