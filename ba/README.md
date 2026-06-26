# Wizard Trees — BA Mileage & Expense app

A phone-first PWA where brand ambassadors log **mileage** (auto-distance to a dispensary *or*
odometer photos) and **expenses** (snap a receipt → cost + vendor auto-filled). Admins (Gianni,
Victoria) review, approve, and export a per-BA, per-period reimbursement report.

- **Front-end:** `index.html` (single-file PWA) + `manifest.webmanifest` + `sw.js` + `icons/`.
  Static — deploys with the rest of `salt-flat` to GitHub Pages: `https://claude759.github.io/salt-flat/ba/`.
- **Backend:** a Supabase project (Postgres + Auth + Storage + Edge Functions). All secrets live
  server-side; the browser only ever holds the project URL + anon (public) key.

---

## One-time setup

### 1. Create the Supabase project
1. supabase.com → **New project** (free tier is fine to start). Pick a region near California.
2. Note the **Project URL** and **anon public key** (Settings → API). These go in the app.
3. Note the **service_role key** (Settings → API) — secret, never in the browser.

### 2. Create the database
In the Supabase **SQL Editor**, run **`supabase/setup.sql`** (one paste — it's `schema.sql` +
`policies.sql` concatenated). If you'd rather run them separately, do `schema.sql` then
`policies.sql`, in that order.

### 2b. Lock down auth (important)
In **Authentication → Providers → Email**, turn **OFF** "Allow new users to sign up". Accounts are
created only by an admin via the in-app **Add** button (the `admin-create-ba` function). The schema
already hardcodes `role='ba'` for any auth-side insert, but disabling open signups is defense in
depth so strangers can't self-register at all.

### 3. Deploy the Edge Functions
Install the CLI (`npm i -g supabase`), then from this `ba/` folder:
```bash
supabase login
supabase link --project-ref <your-project-ref>

# secrets (server-side only — never shipped to the browser)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      # receipt + odometer vision (Claude)
supabase secrets set ORS_KEY=...                       # auto-distance + geocoding (OpenRouteService, optional)
# optional: OCR_MODEL=claude-sonnet-4-6  (default; use claude-haiku-4-5 to cut cost)

supabase functions deploy admin-create-ba
supabase functions deploy extract-receipt
supabase functions deploy read-odometer
supabase functions deploy calc-distance
```
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

The **ORS_KEY** is a free OpenRouteService token (openrouteservice.org → sign up → API key; no
credit card). It powers geocoding + driving distance for the trip "Starting location → dispensary"
flow. Without it, auto-distance simply asks the BA to type miles (odometer + manual still work).

### 4. Point the app at your project
Either edit the `CONFIG` block near the top of `index.html`:
```js
const CONFIG = { url: 'https://YOUR-PROJECT.supabase.co', anon: 'YOUR-ANON-KEY' };
```
…or leave the placeholders and set them once per device via **⚙︎ Connection settings** on the
sign-in screen (saved to `localStorage`).

### 5. Create the first admin
The very first account can't be made in-app (no admin exists yet). In Supabase:
1. **Authentication → Users → Add user** → Gianni's email + a password, **Auto-confirm**.
2. SQL Editor:
   ```sql
   update public.profiles
      set role = 'admin', must_change_password = false, full_name = 'Gianni'
    where email = 'gianni@wizardtrees.com';
   ```
Now sign in as Gianni → **Settings → Add** to create Victoria (admin) and every BA. Each new BA
gets a temp password to set on first login, then enrolls Face ID / fingerprint.

### 6. Deploy the front-end
Commit `ba/` to `salt-flat` and push `main`. Live in ~1 min at
`https://claude759.github.io/salt-flat/ba/`. On a phone: open it → **Share → Add to Home Screen**.

---

## Day-to-day

- **BA:** Home shows the current period total. **Log trip** (auto-distance or odometer photos) ·
  **Add expense** (snap receipt). When the period ends, **Submit** — items lock.
- **Admin:** **Dashboard** = per-BA totals for a period. **Review** = submissions awaiting approval
  → open a BA → **Approve all**, or **Reject** individual items with a note. **⬇ CSV** /
  **🖨 Print / PDF** produce the reimbursement report. **Settings** = mileage rate, pay periods,
  BAs, dispensaries.

## Data model & security (quick reference)
- Tables: `profiles, app_settings, dispensaries, pay_periods, trips, expenses, submissions,
  distance_cache`. See `supabase/schema.sql`.
- RLS: a BA reads/writes only their own rows; admins see all + approve. Receipt/odometer photos
  sit in **private** buckets keyed by the BA's user id; admins view via short-lived signed URLs.
- **Server-trusted money:** the per-mile `rate`, the `amount`, and (for the *distance* method) the
  `miles` are all set by a database trigger, not the client — and they **freeze** once an item is
  submitted, so nothing can re-price between a BA's submit and an admin's approve. A BA cannot edit
  their own `role`, `active`, `rate_override`, or server-derived base coordinates (guard trigger).
- **Edge functions** verify the caller is signed in *and active*, and the receipt/odometer readers
  reject any storage path the caller doesn't own (no cross-user photo access).

> These controls came out of a 68-agent adversarial pre-deployment review (Jun 2026). Known
> accepted limitation: the "set a new password on first login" prompt is a client-side nudge, not a
> hard gate — the admin-issued temp password is the real credential until the BA changes it.

## Cost
Free tier covers build + a small team, but **free projects pause after ~1 week idle** and cap file
storage at **1 GB**. For production, **Pro ($25/mo)** removes the pause, adds 100 GB storage +
backups. Claude vision + Maps calls are pennies (distances are cached per base↔dispensary pair;
receipts are compressed to ~150–300 KB before upload).

## Later (not built yet)
- Push approved reimbursements straight into QuickBooks.
- Offline write-queue (currently the app is online-first; the shell loads offline).
- Wrap the PWA with Capacitor for the App Store / Play Store.
