# Super Manager & Subscription Model

## Roles

| Role | Stored in | Logs in at | Can do |
|---|---|---|---|
| **Super Manager** | `SuperManagers` (bcrypt passwords) | Login page → **Manager** tab | Verify payments, create/extend/block Admins, manage plans, QR & bank details, other Super Managers |
| **Admin** | `Users` + `AdminAccounts` | Login page → **Admin** tab | Everything the portal did before, within plan limits |
| **Staff** (sub user) | `subusers` | Login page → **Staff** tab | Unchanged; cut off automatically when their Admin's plan expires or is blocked |

`Users` rows **without** an `AdminAccounts` row (pre-existing admins, customer logins) are "legacy" and are never restricted.

## Flow

1. Visitor opens the site → login page with a **Get a Subscription** button (`/subscribe.html`, or **Subscribe** screen in the app).
2. Picks a plan → sees the QR code and bank/UPI details → pays → uploads the screenshot (+ optional UTR).
3. Gets a **Request ID**; can check status anytime with mobile + Request ID.
4. Super Managers are notified: badge + sound + desktop notification in the web portal (polls every 20 s), toast in the app, and optionally a webhook (`SM_NOTIFY_WEBHOOK_URL`).
5. Super Manager opens the request, checks the screenshot, and **Approves**: sets the login mobile + password (auto-generated) and plan. This creates the Admin login (or extends it for a renewal), and shows the credentials with Copy / **Send on WhatsApp**. Or **Rejects** with a reason that the payer sees on the status check.
6. Admin logs in as usual. In the last 7 days a renewal banner appears; **My Subscription** shows the plan, usage, and history. Renewing adds days after the current end date.
7. On expiry/block, Admin and their staff are logged out on their next request and shown a "Renew" link.

## Setup (SUSU9DB_DEV)

```bash
cd mobile-api
cp .env.example .env          # fill DB creds for SUSU9DB_DEV + a NEW JWT_SECRET
npm install
node scripts/migrate.js       # creates the 6 new tables + 3 starter plans (idempotent)
node scripts/create-super-manager.js --mobile 9xxxxxxxxx --password "StrongPass1" --name "Owner"
npm start
```

Then log in on the **Manager** tab, set **QR & Bank Details**, and review the **Plans** (the starter prices are placeholders).

Frontend/app API targets:
- Web: `frontend/js/api.js` (`DEFAULT_API_BASE`) and `frontend/vercel.json` (`/api` rewrite) still point at the original production API. Change both before deploying this copy.
- App: set `EXPO_PUBLIC_API_BASE` (falls back to the original production URL). `expo-image-picker` was added (native module), so build a **new binary**. An OTA update to old builds can't upload screenshots; the app shows a message instead of crashing.

## Config

| Env var | Default | Purpose |
|---|---|---|
| `ALLOW_SELF_REGISTER` | `false` | The old free "New User? Register" signup bypassed payment, so it's closed |
| `SM_NOTIFY_WEBHOOK_URL` | — | JSON POST `{text, content, requestId, ...}` for each new payment |
| `SM_JWT_EXPIRES_IN` | `1d` | Super Manager session length |

## New tables

`SuperManagers`, `SubscriptionPlans`, `PaymentSettings` (single row), `SubscriptionRequests` (screenshots stored as data URLs), `AdminAccounts` (current plan per Admin UID: dates, block flag, limit snapshot), `SubscriptionHistory` (audit log). No existing table is altered. On approve/extend/block, `Users.Status`/`IsActive`/`Validity` are mirrored so the legacy `Login` SP agrees. Column names are detected at runtime because the old code uses both `Validity` and `ValidityDate`.

## API

Public: `GET /api/subscription/plans`, `GET /api/subscription/payment-info`, `POST /api/subscription/request` (20/hour/IP, max 3 open per mobile), `GET /api/subscription/request-status?mobile&requestId`.

Admin: `GET /api/auth/subscription`. `/api/auth/me` and the login response now include `Subscription`.

Super Manager (`/api/sm`, Bearer SM token): `POST login`, `GET me`, `POST change-password`, `GET summary`, `GET notifications`, `GET requests?status&q`, `GET requests/:id`, `POST requests/:id/approve`, `POST requests/:id/reject`, `GET|POST plans`, `PUT plans/:id`, `GET|PUT payment-settings`, `GET|POST admins`, `POST admins/:uid/extend|block|reset-password`, `GET admins/:uid/history`, `GET|POST managers`, `PUT managers/:id`.

Plan limits: `POST /api/admin/subusers` and `POST /api/customer` return `403 PLAN_LIMIT` at the plan's max (blank = unlimited).
