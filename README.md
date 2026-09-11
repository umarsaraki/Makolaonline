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
| `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT` | PostgreSQL connection |
| `JWT_SECRET` | Signs login tokens — use a long random string in production |
| `ADMIN_EMAIL` | Whichever registered account uses this email automatically gets full Admin Panel access |
| `MOMO_NUMBER`, `MOMO_NAME`, `BANK_NAME`, `BANK_ACCOUNT_NUMBER`, `BANK_ACCOUNT_NAME` | Shown to users on the Deposit screen |

## 4. How it works

- **Sign up / Login** issues a JWT stored in the browser, sent as `Authorization: Bearer <token>` on every request.
- **Admin access** is not a checkbox in the database — whoever logs in with the email in `ADMIN_EMAIL` automatically sees the ADMIN tab and can approve vendors, products, jobs, deposits, ban users, and manage banners.
- **Becoming a Reseller/Employer**: user applies on the MKO-VENDOR page → row created in `vendor_applications` (status `pending`) → Admin approves → the user's `role` column updates → their dashboard unlocks on the Profile page.
- **Products/Jobs**: created as `pending` → only visible on HOME/SERVICES once Admin sets `status = 'approved'`.
- **Wallet & Deposits**: user requests a deposit → sends money via the MoMo/Bank details shown → uploads a screenshot link → Admin approves in the Admin Panel → `wallet.balance` increases.
- **Orders**: checkout deducts the total straight from the shopping wallet balance (atomically, in a DB transaction) and creates the order as `processing`. Admin can move it through `shipped` → `completed`, or `rejected`.
- **Cashback**: tracked in `wallet_transactions` with `type='cashback'`; the Wallet tab shows "All Cashback" (every record) and "Available Cashback" (sum of the approved ones).
- **Fraud / Bans**: Admin → Users → Ban writes `status='banned'` on the user and auto-logs it to `history`. A banned user is blocked at the authentication middleware on every request.

## 5. Notes & next steps

- Image/screenshot fields (`product.image`, `banner.image_url`, deposit screenshots) currently take a **URL string** — wire up real file uploads (e.g. Cloudinary or `multer` + S3) when you're ready to go further.
- No online payment gateway is wired in yet, per the brief — everything is manual MoMo/Bank + Admin approval.
- The frontend is one static file (`public/index.html`) using vanilla JS and hash-based routing (`#home`, `#services`, `#vendor`, `#orders`, `#profile`, `#admin`, `#login`, `#register`, `#privacy`, `#help`) — no build tools, no framework, just open it and it talks straight to the API.
