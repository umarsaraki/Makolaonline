# MakolaOnline.com

Full-stack E-commerce + Jobs Marketplace for Ghana 🇬🇭

**Stack:** Node.js (Express) · PostgreSQL · Single-file HTML/CSS/JS frontend
**Currency:** GHS ₵ · **Payments:** Manual (MoMo/Bank + Admin approval) — no online gateway yet.

---

## 1. Project files

```
makolaonline/
├── server.js          # Express app + all API routes
├── db.js              # PostgreSQL pool + schema (auto-creates all 11 tables on boot)
├── package.json
├── .env.example        # copy to .env and fill in your own values
├── .gitignore
├── README.md
└── public/
    └── index.html      # the entire frontend — one file, no build step
```

## 2. Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your local Postgres database
createdb makolaonline

# 3. Copy the env file and fill in your DB credentials + secrets
cp .env.example .env

# 4. Run it
npm run dev     # with nodemon, auto-restarts on changes
# or
npm start
```

The server automatically creates every table listed in the schema the first time it boots — no separate migration step needed. Open **http://localhost:5000** and the app is live.

## 3. Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default 5000) |
| `DATABASE_URL` / `DB_USER`,`DB_HOST`,`DB_NAME`,`DB_PASSWORD`,`DB_PORT` | PostgreSQL connection (see section 2) |
| `JWT_SECRET` | Signs login tokens — use a long random string in production |
| `ADMIN_EMAIL` | Whichever registered account uses this email automatically gets full Admin Panel access |
| `BASE_URL` | Your site's own URL, no trailing slash — used to build the Flutterwave return link |
| `FLW_SECRET_KEY` | From Flutterwave Dashboard → Settings → API Keys |
| `FLW_WEBHOOK_HASH` | A secret string you invent — set the same value in Flutterwave Dashboard → Settings → Webhooks → "Secret Hash" |
| `CASHBACK_PERCENT` | % of an order's total given back as cashback once the order is completed (default 3) |
| `VENDOR_APPLICATION_FEE` | GHS fee deducted from a user's Available Balance when they apply to become a Reseller/Employer, credited to Admin (default 50) |

## 4. How it works

- **Sign up / Login** issues a JWT stored in the browser, sent as `Authorization: Bearer <token>` on every request.
- **Admin access** is not a checkbox in the database — whoever logs in with the email in `ADMIN_EMAIL` automatically sees the Admin Panel (inside Profile) with tabs for Wallet, Add Vendor, Applications, Subscriptions, Products, Jobs, Coupons, Deposits, Orders, Users, Banners, Notifications, Settings, User Lookup, and History.
- **Becoming a Reseller/Employer** — two ways:
  - *Self-serve*: user applies on MKO-VENDOR, picks a plan (Starter/Business/Unlimited for resellers, or the single Employer plan), optionally enters a coupon, and the first month's price is deducted from their Available Balance and credited to Admin. Admin still approves before the role/subscription activates; rejecting refunds the payment.
  - *Admin-added*: Admin → Add Vendor creates a fully-verified reseller/employer directly (Ghana Card, bank account, business info) with no payment collected and no self-serve approval step.
- **Products/Jobs**: created as `pending` → only visible on HOME/SERVICES once Admin sets `status = 'approved'`.

### Subscription plans
| Plan | Price/mo | Product limit | Max item price |
|---|---|---|---|
| Starter | ₵20 | 20 | ₵1,000 |
| Business | ₵50 | Unlimited | ₵5,000 |
| Unlimited | ₵100 | Unlimited | Unlimited |
| Employer | ₵100 | Unlimited jobs | — |

Renewal is **never automatic/charged silently** — no background job deducts money on its own. When a plan's due date passes, the subscription is simply marked `past_due` (checked lazily whenever the reseller/employer visits their dashboard) and their ability to add/edit products or jobs is blocked. To reactivate, either the user clicks "Renew Now" in Profile → My Subscription (charges the plan price from their Available Balance right then — if it's insufficient, they deposit first via the normal Wallet flow, then renew), or Admin renews them for free from Admin Panel → Subscriptions. Prices, limits, and caps are seeded in `db.js` — edit the `plans` array there if they ever need to change.

### Coupons
Admin creates percent-off codes for three audiences: **new_reseller** (first-time plan signup), **existing_reseller** (renewal/upgrade), or **shopping** (checkout). Each coupon can be restricted to one person's email or left open to everyone, with an optional expiry. A shopping discount is absorbed by the platform — resellers still receive their full sale amount in escrow.

### Notifications
Admin → Notifications sends a message to Everyone, Resellers only (covers both reseller and employer accounts), or Customers only. Users see unread ones via the 🔔 bell icon in the header.

### Wallet — three balances per user
- **Available** — spendable and withdrawable. Grows from deposits, released sales, and converted cashback.
- **Cashback** — accumulates automatically (a % of each completed order, set in Admin → Settings). A "Move Cashback → Available" button lets the user convert it whenever they like. Unused cashback expires automatically after the configured number of days (default 180).
- **Pending** (Resellers only) — a reseller's share of a sale sits here as escrow the moment an order is placed. It only moves to their Available balance once Admin marks that order **completed**. If Admin marks it **rejected** instead, the held amount is cancelled and the customer is refunded in full (into their Available balance, tracked as "Refund").

### Deposits & Withdrawals — powered by Flutterwave
- **Deposit**: user picks an amount → gets redirected to Flutterwave's hosted checkout (card, bank transfer, or mobile money — Flutterwave handles the entry itself, MakolaOnline never touches card numbers). A webhook (`POST /api/webhooks/flutterwave`) confirms the payment server-side and credits Available balance automatically — this works even if the user closes the app right after paying.
- **Withdraw**: user adds a bank account (verified via Flutterwave's account-resolve API, so the account holder's name is confirmed before saving), sets a **5-digit security code** once, then enters amount + security code to withdraw. On success, Flutterwave's Transfer API sends the money out automatically. If the transfer fails, the amount is refunded back to Available automatically. Admin can reset anyone's forgotten security code from Admin → Users, or the dedicated reset endpoint.
- **Webhook URL to register in Flutterwave Dashboard**: `https://<your-domain>/api/webhooks/flutterwave` — set the Secret Hash there to match `FLW_WEBHOOK_HASH`.
- **Admin's own money**: Admin sees a "Main Wallet" total across *everyone* for oversight only — that money isn't Admin's and can't be withdrawn. Admin's own withdrawable balance is separate: only their own deposits plus plan payments/fees they've collected from vendors.

- **Orders**: checkout deducts the total from the customer's Available balance (atomically) and creates the order as `processing`, while crediting each reseller's Pending balance. Admin can move it through `shipped` → `completed` (releases Pending → Available + gives cashback) or `rejected` (cancels Pending, refunds the customer).
- **Fraud / Bans**: Admin → Users → Ban writes `status='banned'` on the user and auto-logs it to `history`. A banned user is blocked at the authentication middleware on every request.
- **User Lookup**: Admin → User Lookup finds anyone's full order + wallet history by email, for support/dispute cases.

## 5. Deploying on Render

1. Create a **PostgreSQL** instance on Render first.
2. Open it → copy the **Internal Database URL** (starts with `postgres://...`). Use the *Internal* one, not External, since your web service is also on Render — it's faster and needs no extra SSL setup on your end.
3. Create a **Web Service** on Render, connect it to your GitHub repo.
   - Build Command: `npm install`
   - Start Command: `npm start`
4. In the web service's **Environment** tab, add:
   - `DATABASE_URL` = the Internal Database URL you copied in step 2
   - `JWT_SECRET` = any long random string
   - `ADMIN_EMAIL` = the email that should get Admin Panel access
   - `BASE_URL` = your Render URL, e.g. `https://makolaonline.onrender.com`
   - `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH`
   - Leave `DB_USER`, `DB_HOST`, etc. out entirely — `DATABASE_URL` covers all of them.
5. In your **Flutterwave Dashboard** → Settings → Webhooks, set the webhook URL to `https://<your-render-url>/api/webhooks/flutterwave` and the Secret Hash to the same value as `FLW_WEBHOOK_HASH`.
6. Deploy. If the logs show `ECONNREFUSED ::1:5432` or `127.0.0.1:5432`, it means `DATABASE_URL` isn't set (or isn't spelled exactly that way) in the Environment tab — the app is falling back to "localhost", which doesn't exist on Render.

⚠️ **This update changes several table structures** (wallet types, plans, subscriptions, coupons, notifications, etc). If your test database already has data from before this update, the safest move is to drop and let the app recreate everything fresh (`DROP TABLE wallet, wallet_transactions, vendor_applications, bank_accounts, order_items, orders CASCADE;` then redeploy) — `db.js` auto-creates and re-seeds everything on boot.

## 6. Notes & next steps

- Image/screenshot fields (`product.image`, `banner.image_url`, deposit screenshots) currently take a **URL string** — wire up real file uploads (e.g. Cloudinary or `multer` + S3) when you're ready to go further.
- No online payment gateway is wired in yet, per the brief — everything is manual MoMo/Bank + Admin approval.
- The frontend is one static file (`public/index.html`) using vanilla JS and hash-based routing (`#home`, `#services`, `#vendor`, `#orders`, `#profile`, `#admin`, `#login`, `#register`, `#privacy`, `#help`) — no build tools, no framework, just open it and it talks straight to the API.
