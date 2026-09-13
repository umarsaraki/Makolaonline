// db.js — PostgreSQL connection + schema setup for MakolaOnline.com
require('dotenv').config();
const { Pool } = require('pg');

// Render (and most hosts) give you ONE connection string called DATABASE_URL.
// Locally, most people prefer separate DB_USER/DB_HOST/etc fields.
// This supports both — DATABASE_URL wins if it's set.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's hosted Postgres requires SSL, but its self-signed cert
      // fails default verification — this is the standard safe workaround.
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'makolaonline',
      password: process.env.DB_PASSWORD || 'password',
      port: process.env.DB_PORT || 5432,
    });

pool.on('connect', () => console.log('✅ Connected to PostgreSQL (MakolaOnline)'));
pool.on('error', (err) => console.error('❌ Unexpected PostgreSQL error:', err));

// Full schema — matches the spec exactly. Runs safely on every boot.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer','reseller','employer','admin')),
  ghana_card VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','banned')),
  security_code_hash VARCHAR(255),
  business_name VARCHAR(150),
  business_category VARCHAR(150),
  business_address VARCHAR(255),
  business_region VARCHAR(100),
  added_by_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_code_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_category VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_address VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_region VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS added_by_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(100);

-- Subscription plans for Resellers and the single Employer plan (must exist before
-- vendor_applications, which references plan_id).
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('reseller','employer')),
  price NUMERIC(10,2) NOT NULL,
  product_limit INT,     -- NULL = unlimited
  price_cap NUMERIC(10,2), -- NULL = no cap on a single item's price
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_id INT REFERENCES plans(id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','cancelled')),
  renews_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_applications (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('reseller','employer')),
  plan_id INT REFERENCES plans(id),
  price_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  full_address TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  id_type VARCHAR(30),
  id_number VARCHAR(50),
  id_front_url VARCHAR(255),
  id_back_url VARCHAR(255),
  selfie_url VARCHAR(255),
  payout_number VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS plan_id INT REFERENCES plans(id);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS price_paid NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS full_address TEXT;
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS id_type VARCHAR(30);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS id_number VARCHAR(50);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS id_front_url VARCHAR(255);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS id_back_url VARCHAR(255);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS selfie_url VARCHAR(255);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS payout_number VARCHAR(50);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  reseller_id INT REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  image VARCHAR(255),
  description TEXT,
  category VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  employer_id INT REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  description TEXT,
  salary VARCHAR(100),
  location VARCHAR(150),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  order_no VARCHAR(50) UNIQUE NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','shipped','completed','rejected')),
  escrow_settled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS escrow_settled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  qty INT NOT NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS addresses (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  address_line VARCHAR(255) NOT NULL,
  city VARCHAR(100),
  region VARCHAR(100)
);

-- Bank accounts a user has added, used as withdrawal destinations.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  bank_name VARCHAR(100) NOT NULL,
  bank_code VARCHAR(20) NOT NULL,
  account_number VARCHAR(30) NOT NULL,
  account_name VARCHAR(150),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Wallet balances, three per user:
--   available = spendable + withdrawable money (deposits, released sales, converted cashback)
--   cashback  = accumulated cashback, convertible into "available"
--   pending   = a reseller's escrowed sale proceeds, held until the order is marked completed
CREATE TABLE IF NOT EXISTS wallet (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC(10,2) NOT NULL DEFAULT 0,
  type VARCHAR(20) NOT NULL,
  UNIQUE(user_id, type)
);
-- Migrate any old 'shopping' rows from before this redesign, then lock in the new allowed types.
-- Constraint is dropped BEFORE the data migration so a stale old constraint can never block it.
ALTER TABLE wallet DROP CONSTRAINT IF EXISTS wallet_type_check;
UPDATE wallet SET type = 'available' WHERE type = 'shopping';
ALTER TABLE wallet ADD CONSTRAINT wallet_type_check CHECK (type IN ('available','cashback','pending'));

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  flw_ref VARCHAR(100),
  bank_account_id INT REFERENCES bank_accounts(id),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS flw_ref VARCHAR(100);
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS bank_account_id INT REFERENCES bank_accounts(id);
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN ('deposit','withdraw','order','cashback','refund','pending_release','vendor_fee','subscription'));
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_status_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_status_check
  CHECK (status IN ('pending','approved','rejected','expired'));

CREATE TABLE IF NOT EXISTS banners (
  id SERIAL PRIMARY KEY,
  image_url VARCHAR(255),
  text VARCHAR(255),
  link VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true
);
ALTER TABLE banners ALTER COLUMN image_url DROP NOT NULL;
ALTER TABLE banners ADD COLUMN IF NOT EXISTS text VARCHAR(255);

CREATE TABLE IF NOT EXISTS history (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(150) NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Discount codes: for shopping checkout, or off a plan payment (new signup or renewal/upgrade).
CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code VARCHAR(30) UNIQUE NOT NULL,
  percent_off INT NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  audience VARCHAR(20) NOT NULL CHECK (audience IN ('new_reseller','existing_reseller','shopping')),
  target_user_id INT REFERENCES users(id), -- NULL = anyone can use it
  expires_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id SERIAL PRIMARY KEY,
  coupon_id INT REFERENCES coupons(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(coupon_id, user_id)
);

-- Admin broadcast notifications, read per-user via a bell icon dropdown.
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  audience VARCHAR(20) NOT NULL CHECK (audience IN ('everyone','resellers','customers')),
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_reads (
  id SERIAL PRIMARY KEY,
  notification_id INT REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(notification_id, user_id)
);

-- Small admin-editable key/value settings (cashback %, cashback expiry days).
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(50) PRIMARY KEY,
  value VARCHAR(255) NOT NULL
);

-- Uploaded photos (products, banners, KYC documents) live right here in our own
-- database — no external image-hosting service involved.
CREATE TABLE IF NOT EXISTS images (
  id SERIAL PRIMARY KEY,
  data BYTEA NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

async function initSchema() {
  await pool.query(SCHEMA);
  // Make sure every existing user has all three wallet rows (covers accounts
  // created before the "pending" wallet type existed).
  await pool.query(`
    INSERT INTO wallet (user_id, balance, type)
    SELECT u.id, 0, t.type
    FROM users u CROSS JOIN (VALUES ('available'),('cashback'),('pending')) AS t(type)
    ON CONFLICT (user_id, type) DO NOTHING
  `);

  // Seed/refresh the subscription plans — these prices are the source of truth.
  const plans = [
    ['starter', 'Starter', 'reseller', 20, 20, 1000],
    ['business', 'Business', 'reseller', 50, null, 5000],
    ['unlimited', 'Unlimited', 'reseller', 100, null, null],
    ['employer', 'Employer Unlimited', 'employer', 100, null, null],
  ];
  for (const [code, name, type, price, product_limit, price_cap] of plans) {
    await pool.query(
      `INSERT INTO plans (code, name, type, price, product_limit, price_cap) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET name=$2, type=$3, price=$4, product_limit=$5, price_cap=$6`,
      [code, name, type, price, product_limit, price_cap]
    );
  }

  // Seed default settings only if not already set (admin edits should stick).
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('cashback_percent','3'), ('cashback_expiry_days','180')
     ON CONFLICT (key) DO NOTHING`
  );

  console.log('✅ Schema ready (20 tables)');
}

async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

// Helper: write a row into history. Never throws — logging must not break a request.
async function logHistory(userId, action, details = '') {
  try {
    await pool.query(
      'INSERT INTO history (user_id, action, details) VALUES ($1, $2, $3)',
      [userId, action, details]
    );
  } catch (err) {
    console.error('History log failed:', err.message);
  }
}

module.exports = { pool, initSchema, logHistory, getSetting };
