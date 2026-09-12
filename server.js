// server.js — MakolaOnline.com backend (Node.js + Express + PostgreSQL)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, initSchema, logHistory, getSetting } = require('./db');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function genOrderNo() {
  return 'MKO-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100);
}
function genRef(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
async function getWalletBalance(userId, type) {
  const { rows } = await pool.query('SELECT balance FROM wallet WHERE user_id=$1 AND type=$2', [userId, type]);
  return rows[0] ? Number(rows[0].balance) : 0;
}
async function adjustWallet(client, userId, type, delta) {
  await client.query('UPDATE wallet SET balance = balance + $1 WHERE user_id=$2 AND type=$3', [delta, userId, type]);
}
async function getCashbackPercent() {
  return Number(await getSetting('cashback_percent', process.env.CASHBACK_PERCENT || 3));
}
async function getCashbackExpiryDays() {
  return Number(await getSetting('cashback_expiry_days', 180));
}
function isValidGhanaCard(s) {
  return /^GHA-\d{9}-\d$/.test(s || '');
}

// Sweeps out cashback that's older than the expiry window and hasn't been converted yet.
async function expireCashback(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM wallet_transactions WHERE user_id=$1 AND type='cashback' AND status='approved' AND expires_at < NOW() FOR UPDATE`,
      [userId]
    );
    if (rows.length) {
      const totalExpired = rows.reduce((s, r) => s + Number(r.amount), 0);
      const balRes = await client.query(`SELECT balance FROM wallet WHERE user_id=$1 AND type='cashback' FOR UPDATE`, [userId]);
      const bal = balRes.rows[0] ? Number(balRes.rows[0].balance) : 0;
      const deduct = Math.min(totalExpired, bal);
      if (deduct > 0) await adjustWallet(client, userId, 'cashback', -deduct);
      await client.query(`UPDATE wallet_transactions SET status='expired' WHERE id = ANY($1)`, [rows.map(r => r.id)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('expireCashback failed:', err.message);
  } finally {
    client.release();
  }
}

// No automatic charging. This only keeps the displayed/gating status honest: if the renewal
// date has passed and nobody has renewed yet (manually, or by Admin), it flips to 'past_due' —
// which blocks new products/jobs until the user renews via "Renew Now" or Admin renews them free.
async function syncSubscriptionStatus(sub) {
  if (sub.status === 'active' && new Date(sub.renews_at) < new Date()) {
    await pool.query(`UPDATE subscriptions SET status='past_due' WHERE id=$1`, [sub.id]);
    sub.status = 'past_due';
  }
  return sub;
}

async function checkUserRenewal(userId) {
  const { rows } = await pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [userId]);
  if (rows[0]) await syncSubscriptionStatus(rows[0]);
}

// Finds+validates a coupon for a given audience/user, or throws a friendly error.
async function validateCoupon(code, audience, userId) {
  if (!code) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coupons WHERE code=$1 AND audience=$2 AND is_active=true`,
    [code.toUpperCase(), audience]
  );
  const coupon = rows[0];
  if (!coupon) throw new Error('Invalid coupon code.');
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) throw new Error('This coupon has expired.');
  if (coupon.target_user_id && coupon.target_user_id !== userId) throw new Error('This coupon is not valid for your account.');
  const used = await pool.query('SELECT 1 FROM coupon_redemptions WHERE coupon_id=$1 AND user_id=$2', [coupon.id, userId]);
  if (used.rows.length) throw new Error('You have already used this coupon.');
  return coupon;
}
async function redeemCoupon(client, couponId, userId) {
  await client.query('INSERT INTO coupon_redemptions (coupon_id, user_id) VALUES ($1,$2)', [couponId, userId]);
}

/* ------------------------------------------------------------------ */
/* Flutterwave — all payment/payout API calls live here, inline        */
/* ------------------------------------------------------------------ */

const FLW_BASE = 'https://api.flutterwave.com/v3';

async function flwFetch(path, method = 'GET', body = null) {
  if (!process.env.FLW_SECRET_KEY) throw new Error('FLW_SECRET_KEY is not set in the environment.');
  const res = await fetch(FLW_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') {
    throw new Error(data.message || `Flutterwave request failed (${res.status})`);
  }
  return data;
}

const flw = {
  // Creates a hosted checkout link (customer picks card / bank transfer / mobile money on Flutterwave's own page).
  async createCheckoutLink({ tx_ref, amount, email, name, redirect_url }) {
    const data = await flwFetch('/payments', 'POST', {
      tx_ref,
      amount,
      currency: 'GHS',
      redirect_url,
      customer: { email, name },
      customizations: { title: 'MakolaOnline Wallet Deposit', description: 'Deposit into your MakolaOnline wallet' },
    });
    return data.data.link;
  },

  // Server-side confirmation — never trust the redirect/webhook payload alone.
  async verifyTransaction(transactionId) {
    const data = await flwFetch(`/transactions/${transactionId}/verify`, 'GET');
    return data.data; // { status, amount, currency, tx_ref, ... }
  },

  // Confirms a bank account is real and returns the account holder's name (fraud check + typo protection).
  async resolveAccount({ account_number, account_bank }) {
    const data = await flwFetch('/accounts/resolve', 'POST', { account_number, account_bank });
    return data.data; // { account_number, account_name }
  },

  async listGhanaBanks() {
    const data = await flwFetch('/banks/GH', 'GET');
    return data.data; // [{ id, code, name }]
  },

  // Sends money out to a bank account — this is the automatic withdrawal disbursement.
  async initiateTransfer({ account_bank, account_number, amount, reference, narration }) {
    const data = await flwFetch('/transfers', 'POST', {
      account_bank, account_number, amount, currency: 'GHS', reference, narration,
    });
    return data.data;
  },
};

// Verifies the JWT and loads the current user row (so status/role are always fresh).
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not logged in. Please log in.' });

    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    if (user.status === 'banned') {
      return res.status(403).json({ error: 'Your account has been banned for fraud. Please contact admin.' });
    }
    // The logged-in ADMIN_EMAIL always behaves as admin, even if role column says otherwise.
    user.isAdmin = process.env.ADMIN_EMAIL && user.email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Only Admin can do this.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role && !req.user.isAdmin) {
      return res.status(403).json({ error: `You are not a ${role}.` });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* AUTH                                                                */
/* ------------------------------------------------------------------ */

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password, ghana_card } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'This email is already registered.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, ghana_card)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role`,
      [name, email.toLowerCase(), phone || null, hash, ghana_card || null]
    );
    const user = rows[0];

    // Every user gets a shopping + cashback wallet from day one.
    await pool.query(`INSERT INTO wallet (user_id, balance, type) VALUES ($1,0,'available'),($1,0,'cashback'),($1,0,'pending')`, [user.id]);
    await logHistory(user.id, 'register', 'New account opened');

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error while registering.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Your account has been banned.' });

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    const isAdmin = process.env.ADMIN_EMAIL && user.email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
    delete user.password_hash;
    res.json({ token, user: { ...user, isAdmin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error while logging in.' });
  }
});

/* ------------------------------------------------------------------ */
/* HOME — banners + approved products (public)                        */
/* ------------------------------------------------------------------ */

app.get('/api/banners', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM banners WHERE is_active = true ORDER BY id DESC');
  res.json(rows);
});

app.get('/api/products', async (req, res) => {
  const { search, category } = req.query;
  let q = `SELECT p.*, u.name AS reseller_name FROM products p
           JOIN users u ON u.id = p.reseller_id WHERE p.status = 'approved'`;
  const params = [];
  if (search) { params.push(`%${search}%`); q += ` AND p.name ILIKE $${params.length}`; }
  if (category) { params.push(category); q += ` AND p.category = $${params.length}`; }
  q += ' ORDER BY p.created_at DESC';
  const { rows } = await pool.query(q, params);
  res.json(rows);
});

app.get('/api/products/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS reseller_name FROM products p JOIN users u ON u.id = p.reseller_id WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' });
  res.json(rows[0]);
});

/* ------------------------------------------------------------------ */
/* SERVICES — approved jobs (public)                                  */
/* ------------------------------------------------------------------ */

app.get('/api/jobs', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT j.*, u.name AS employer_name FROM jobs j
     JOIN users u ON u.id = j.employer_id WHERE j.status = 'approved' ORDER BY j.created_at DESC`
  );
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* MKO-VENDOR — apply as reseller/employer                            */
/* ------------------------------------------------------------------ */

app.get('/api/plans', async (req, res) => {
  const { type } = req.query;
  const { rows } = await pool.query(
    type ? 'SELECT * FROM plans WHERE type=$1 ORDER BY price' : 'SELECT * FROM plans ORDER BY type, price',
    type ? [type] : []
  );
  res.json(rows);
});

app.post('/api/vendor/apply', authenticate, async (req, res) => {
  const { type, plan_code, coupon_code } = req.body;
  if (!['reseller', 'employer'].includes(type)) return res.status(400).json({ error: 'Choose reseller or employer.' });

  const existing = await pool.query(
    `SELECT * FROM vendor_applications WHERE user_id = $1 AND type = $2 AND status = 'pending'`,
    [req.user.id, type]
  );
  if (existing.rows.length) return res.status(409).json({ error: 'Your application is already pending approval.' });

  const planRes = await pool.query('SELECT * FROM plans WHERE code=$1 AND type=$2', [plan_code, type]);
  const plan = planRes.rows[0];
  if (!plan) return res.status(400).json({ error: 'Please choose a valid plan.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let price = Number(plan.price);
    let coupon = null;
    if (coupon_code) {
      coupon = await validateCoupon(coupon_code, 'new_reseller', req.user.id);
      price = Math.round(price * (1 - coupon.percent_off / 100) * 100) / 100;
    }

    if (price > 0) {
      const bal = await getWalletBalance(req.user.id, 'available');
      if (bal < price) {
        throw new Error(`You need at least GHS ${price} available balance for the ${plan.name} plan's first month. Please deposit first.`);
      }
      const adminRes = await client.query('SELECT id FROM users WHERE email = $1', [(process.env.ADMIN_EMAIL || '').toLowerCase()]);
      const admin = adminRes.rows[0];
      if (!admin) throw new Error('Admin account is not configured yet — cannot process this payment.');

      await adjustWallet(client, req.user.id, 'available', -price);
      await adjustWallet(client, admin.id, 'available', price);
      await client.query(`INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'subscription','approved')`, [req.user.id, -price]);
      await client.query(`INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'subscription','approved')`, [admin.id, price]);
    }
    if (coupon) await redeemCoupon(client, coupon.id, req.user.id);

    const { rows } = await client.query(
      `INSERT INTO vendor_applications (user_id, type, plan_id, price_paid) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, type, plan.id, price]
    );
    await client.query('COMMIT');
    await logHistory(req.user.id, 'vendor_apply', `Applied to become ${type} on the ${plan.name} plan (₵${price})`);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/vendor/status', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_applications WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

app.get('/api/subscription', authenticate, async (req, res) => {
  await checkUserRenewal(req.user.id);
  const { rows } = await pool.query(
    `SELECT s.status, s.renews_at, p.code, p.name, p.price, p.product_limit, p.price_cap
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id=$1`,
    [req.user.id]
  );
  if (!rows[0]) return res.json(null);
  let productCount = null;
  if (req.user.role === 'reseller') {
    const c = await pool.query('SELECT COUNT(*) FROM products WHERE reseller_id=$1', [req.user.id]);
    productCount = Number(c.rows[0].count);
  }
  res.json({ ...rows[0], productCount });
});

// Lets a reseller/employer immediately pay for a renewal (useful right after depositing while
// suspended) or switch to a different plan, optionally using an "existing_reseller" coupon.
app.post('/api/subscription/renew-now', authenticate, async (req, res) => {
  const { plan_code, coupon_code } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query('SELECT * FROM subscriptions WHERE user_id=$1 FOR UPDATE', [req.user.id]);
    const sub = subRes.rows[0];
    if (!sub) throw new Error('No subscription found.');

    let plan;
    if (plan_code) {
      const p = await client.query('SELECT * FROM plans WHERE code=$1', [plan_code]);
      plan = p.rows[0];
      if (!plan) throw new Error('Invalid plan.');
    } else {
      const p = await client.query('SELECT * FROM plans WHERE id=$1', [sub.plan_id]);
      plan = p.rows[0];
    }

    let price = Number(plan.price);
    let coupon = null;
    if (coupon_code) {
      coupon = await validateCoupon(coupon_code, 'existing_reseller', req.user.id);
      price = Math.round(price * (1 - coupon.percent_off / 100) * 100) / 100;
    }

    const bal = await getWalletBalance(req.user.id, 'available');
    if (bal < price) throw new Error(`Insufficient balance — you need ₵${price} to renew.`);

    if (price > 0) {
      await adjustWallet(client, req.user.id, 'available', -price);
      await client.query(`INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'subscription','approved')`, [req.user.id, -price]);
    }
    if (coupon) await redeemCoupon(client, coupon.id, req.user.id);

    await client.query(
      `UPDATE subscriptions SET plan_id=$1, status='active', renews_at=NOW() + INTERVAL '1 month' WHERE user_id=$2`,
      [plan.id, req.user.id]
    );
    await client.query('COMMIT');
    await logHistory(req.user.id, 'subscription_renewed_manual', `${plan.name} — ₵${price}`);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ */
/* RESELLER DASHBOARD — CRUD products                                 */
/* ------------------------------------------------------------------ */

// Runs the lazy renewal check, then returns { subscription, plan } or throws a friendly error.
async function requireActiveSubscription(userId) {
  await checkUserRenewal(userId);
  const { rows } = await pool.query(
    `SELECT s.*, p.* , s.id AS sub_id, p.id AS plan_id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id=$1`,
    [userId]
  );
  const sub = rows[0];
  if (!sub) throw new Error('No active subscription found.');
  if (sub.status !== 'active') throw new Error(`Your ${sub.name} plan is suspended (renewal payment failed). Please deposit and it will renew automatically, or ask Admin to renew you.`);
  return sub;
}

app.get('/api/reseller/products', authenticate, requireRole('reseller'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE reseller_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

app.post('/api/reseller/products', authenticate, requireRole('reseller'), async (req, res) => {
  const { name, price, image, description, category } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price are required.' });
  try {
    const sub = await requireActiveSubscription(req.user.id);
    if (sub.price_cap && Number(price) > Number(sub.price_cap)) {
      return res.status(400).json({ error: `Your ${sub.name} plan can't list items above ₵${sub.price_cap}. Upgrade your plan for higher-value items.` });
    }
    if (sub.product_limit) {
      const countRes = await pool.query('SELECT COUNT(*) FROM products WHERE reseller_id=$1', [req.user.id]);
      if (Number(countRes.rows[0].count) >= sub.product_limit) {
        return res.status(400).json({ error: `Your ${sub.name} plan allows up to ${sub.product_limit} products. Upgrade your plan to add more.` });
      }
    }
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
  const { rows } = await pool.query(
    `INSERT INTO products (reseller_id, name, price, image, description, category)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.id, name, price, image || null, description || null, category || null]
  );
  await logHistory(req.user.id, 'product_create', `Added product: ${name}`);
  res.status(201).json(rows[0]);
});

app.put('/api/reseller/products/:id', authenticate, requireRole('reseller'), async (req, res) => {
  const { name, price, image, description, category } = req.body;
  try {
    const sub = await requireActiveSubscription(req.user.id);
    if (sub.price_cap && Number(price) > Number(sub.price_cap)) {
      return res.status(400).json({ error: `Your ${sub.name} plan can't list items above ₵${sub.price_cap}. Upgrade your plan for higher-value items.` });
    }
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
  const { rows } = await pool.query(
    `UPDATE products SET name=$1, price=$2, image=$3, description=$4, category=$5, status='pending'
     WHERE id=$6 AND reseller_id=$7 RETURNING *`,
    [name, price, image, description, category, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' });
  res.json(rows[0]);
});

app.delete('/api/reseller/products/:id', authenticate, requireRole('reseller'), async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1 AND reseller_id=$2', [req.params.id, req.user.id]);
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* EMPLOYER DASHBOARD — CRUD jobs                                      */
/* ------------------------------------------------------------------ */

app.get('/api/employer/jobs', authenticate, requireRole('employer'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE employer_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

app.post('/api/employer/jobs', authenticate, requireRole('employer'), async (req, res) => {
  const { title, description, salary, location } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  try {
    await requireActiveSubscription(req.user.id);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
  const { rows } = await pool.query(
    `INSERT INTO jobs (employer_id, title, description, salary, location) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.id, title, description || null, salary || null, location || null]
  );
  await logHistory(req.user.id, 'job_create', `Added job: ${title}`);
  res.status(201).json(rows[0]);
});

app.put('/api/employer/jobs/:id', authenticate, requireRole('employer'), async (req, res) => {
  const { title, description, salary, location } = req.body;
  try {
    await requireActiveSubscription(req.user.id);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
  const { rows } = await pool.query(
    `UPDATE jobs SET title=$1, description=$2, salary=$3, location=$4, status='pending'
     WHERE id=$5 AND employer_id=$6 RETURNING *`,
    [title, description, salary, location, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
  res.json(rows[0]);
});

app.delete('/api/employer/jobs/:id', authenticate, requireRole('employer'), async (req, res) => {
  await pool.query('DELETE FROM jobs WHERE id=$1 AND employer_id=$2', [req.params.id, req.user.id]);
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* ADDRESSES — CRUD                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/addresses', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM addresses WHERE user_id = $1', [req.user.id]);
  res.json(rows);
});

app.post('/api/addresses', authenticate, async (req, res) => {
  const { address_line, city, region } = req.body;
  if (!address_line) return res.status(400).json({ error: 'Address is required.' });
  const { rows } = await pool.query(
    `INSERT INTO addresses (user_id, address_line, city, region) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.id, address_line, city || null, region || null]
  );
  res.status(201).json(rows[0]);
});

app.put('/api/addresses/:id', authenticate, async (req, res) => {
  const { address_line, city, region } = req.body;
  const { rows } = await pool.query(
    `UPDATE addresses SET address_line=$1, city=$2, region=$3 WHERE id=$4 AND user_id=$5 RETURNING *`,
    [address_line, city, region, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Address not found.' });
  res.json(rows[0]);
});

app.delete('/api/addresses/:id', authenticate, async (req, res) => {
  await pool.query('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* ORDERS — place + view (wallet-based checkout, reseller escrow)     */
/* ------------------------------------------------------------------ */

app.post('/api/orders', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, coupon_code } = req.body; // [{ product_id, qty }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Your cart is empty.' });

    await client.query('BEGIN');

    let total = 0;
    const priced = [];
    for (const it of items) {
      const { rows } = await client.query(`SELECT * FROM products WHERE id=$1 AND status='approved'`, [it.product_id]);
      const p = rows[0];
      if (!p) throw new Error('One of the items is no longer available or not yet approved.');
      const lineTotal = Number(p.price) * Number(it.qty);
      total += lineTotal;
      priced.push({ product_id: p.id, qty: it.qty, reseller_id: p.reseller_id, lineTotal });
    }

    let chargeTotal = total;
    let coupon = null;
    if (coupon_code) {
      coupon = await validateCoupon(coupon_code, 'shopping', req.user.id);
      chargeTotal = Math.round(total * (1 - coupon.percent_off / 100) * 100) / 100;
    }

    const availableBal = await getWalletBalance(req.user.id, 'available');
    if (availableBal < chargeTotal) {
      throw new Error('Insufficient wallet balance. Please deposit before placing an order.');
    }

    const orderNo = genOrderNo();
    const orderRes = await client.query(
      `INSERT INTO orders (user_id, order_no, total) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, orderNo, chargeTotal]
    );
    const order = orderRes.rows[0];

    for (const it of priced) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1,$2,$3,$4)`,
        [order.id, it.product_id, it.qty, it.lineTotal / it.qty]
      );
      // Resellers still get their full share — a shopping discount is funded by the platform, not the reseller.
      await adjustWallet(client, it.reseller_id, 'pending', it.lineTotal);
    }
    if (coupon) await redeemCoupon(client, coupon.id, req.user.id);

    // Deduct the (possibly discounted) total from the customer's available balance now.
    await adjustWallet(client, req.user.id, 'available', -chargeTotal);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'order','approved')`,
      [req.user.id, -chargeTotal]
    );

    await client.query('COMMIT');
    await logHistory(req.user.id, 'order_placed', `Order ${orderNo} - ₵${total}`);
    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message || 'Order failed.' });
  } finally {
    client.release();
  }
});

app.get('/api/orders', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

app.get('/api/orders/:id', authenticate, async (req, res) => {
  const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  const order = orderRes.rows[0];
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const itemsRes = await pool.query(
    `SELECT oi.*, p.name, p.image FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
    [order.id]
  );
  res.json({ ...order, items: itemsRes.rows });
});

/* ------------------------------------------------------------------ */
/* WALLET — available / cashback / pending                            */
/* ------------------------------------------------------------------ */

app.get('/api/wallet', authenticate, async (req, res) => {
  await expireCashback(req.user.id);
  const { rows } = await pool.query('SELECT * FROM wallet WHERE user_id = $1', [req.user.id]);
  const get = (t) => Number((rows.find(r => r.type === t) || {}).balance || 0);
  const refundRes = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions WHERE user_id=$1 AND type='refund' AND status='approved'`,
    [req.user.id]
  );
  res.json({
    available: get('available'),
    cashback: get('cashback'),
    pending: get('pending'),
    totalRefunded: Number(refundRes.rows[0].total),
    securityCodeSet: !!req.user.security_code_hash,
  });
});

app.get('/api/wallet/cashback', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions WHERE user_id=$1 AND type='cashback' ORDER BY created_at DESC`,
    [req.user.id]
  );
  const available = await getWalletBalance(req.user.id, 'cashback');
  res.json({ all: rows, available });
});

// Move accumulated cashback into the available balance, so it can be spent or withdrawn.
app.post('/api/wallet/cashback/convert', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bal = await getWalletBalance(req.user.id, 'cashback');
    if (bal <= 0) throw new Error('No cashback available to move yet.');
    await adjustWallet(client, req.user.id, 'cashback', -bal);
    await adjustWallet(client, req.user.id, 'available', bal);
    await client.query('COMMIT');
    await logHistory(req.user.id, 'cashback_converted', `₵${bal} moved from Cashback to Available`);
    res.json({ moved: bal });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ---- Security code (5-digit withdrawal PIN) ---- */

app.post('/api/wallet/security-code', authenticate, async (req, res) => {
  const { code, current_code } = req.body;
  if (!/^\d{5}$/.test(code || '')) return res.status(400).json({ error: 'Security code must be exactly 5 digits.' });

  if (req.user.security_code_hash) {
    const ok = current_code && await bcrypt.compare(current_code, req.user.security_code_hash);
    if (!ok) return res.status(401).json({ error: 'Your current security code is incorrect.' });
  }
  const hash = await bcrypt.hash(code, 10);
  await pool.query('UPDATE users SET security_code_hash=$1 WHERE id=$2', [hash, req.user.id]);
  await logHistory(req.user.id, 'security_code_set', 'Withdrawal security code was set/changed');
  res.json({ ok: true });
});

/* ---- Bank accounts (withdrawal destinations) ---- */

app.get('/api/banks', authenticate, async (req, res) => {
  try {
    const banks = await flw.listGhanaBanks();
    res.json(banks);
  } catch (err) {
    res.status(502).json({ error: 'Could not load bank list: ' + err.message });
  }
});

app.get('/api/bank-accounts', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bank_accounts WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

app.post('/api/bank-accounts', authenticate, async (req, res) => {
  const { bank_code, bank_name, account_number } = req.body;
  if (!bank_code || !account_number) return res.status(400).json({ error: 'Bank and account number are required.' });
  try {
    const resolved = await flw.resolveAccount({ account_number, account_bank: bank_code });
    const { rows } = await pool.query(
      `INSERT INTO bank_accounts (user_id, bank_name, bank_code, account_number, account_name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, bank_name, bank_code, account_number, resolved.account_name]
    );
    await logHistory(req.user.id, 'bank_account_added', `${bank_name} — ${account_number} (${resolved.account_name})`);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: 'Could not verify that account: ' + err.message });
  }
});

app.delete('/api/bank-accounts/:id', authenticate, async (req, res) => {
  await pool.query('DELETE FROM bank_accounts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ deleted: true });
});

/* ---- Deposit (Flutterwave hosted checkout — card or bank transfer) ---- */

app.post('/api/wallet/deposit/initiate', authenticate, async (req, res) => {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Enter the amount you want to deposit.' });
  const ref = genRef('MKO-DEP');
  try {
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status, flw_ref) VALUES ($1,$2,'deposit','pending',$3)`,
      [req.user.id, amount, ref]
    );
    const link = await flw.createCheckoutLink({
      tx_ref: ref,
      amount: Number(amount),
      email: req.user.email,
      name: req.user.name,
      redirect_url: `${BASE_URL}/api/wallet/deposit/callback`,
    });
    res.json({ link });
  } catch (err) {
    res.status(502).json({ error: 'Could not start the deposit: ' + err.message });
  }
});

// Flutterwave redirects the customer's browser here after they complete (or cancel) checkout.
// This is a backup confirmation path — the webhook below is the primary, authoritative one.
app.get('/api/wallet/deposit/callback', async (req, res) => {
  const { tx_ref, transaction_id, status } = req.query;
  try {
    if (status === 'successful' && transaction_id) {
      const verified = await flw.verifyTransaction(transaction_id);
      if (verified.status === 'successful' && verified.tx_ref) {
        await creditDepositIfPending(verified.tx_ref, verified.amount);
      }
    }
  } catch (err) {
    console.error('Deposit callback verify failed:', err.message);
  }
  res.redirect(`/#profile?deposit=${status === 'successful' ? 'success' : 'cancelled'}`);
});

// Idempotent helper — credits a pending deposit exactly once, however we learn it succeeded.
async function creditDepositIfPending(txRef, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM wallet_transactions WHERE flw_ref=$1 AND type='deposit' AND status='pending' FOR UPDATE`,
      [txRef]
    );
    const tx = rows[0];
    if (!tx) { await client.query('ROLLBACK'); return; } // already credited, or unknown ref
    await adjustWallet(client, tx.user_id, 'available', Number(amount));
    await client.query(`UPDATE wallet_transactions SET status='approved' WHERE id=$1`, [tx.id]);
    await client.query('COMMIT');
    await logHistory(tx.user_id, 'deposit_approved', `₵${amount} deposited via Flutterwave (${txRef})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('creditDepositIfPending failed:', err.message);
  } finally {
    client.release();
  }
}

/* ---- Withdraw (Flutterwave automatic transfer) ---- */

app.post('/api/wallet/withdraw', authenticate, async (req, res) => {
  const { bank_account_id, amount, security_code } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!req.user.security_code_hash) return res.status(400).json({ error: 'Please set your 5-digit security code first.' });
  const codeOk = await bcrypt.compare(security_code || '', req.user.security_code_hash);
  if (!codeOk) return res.status(401).json({ error: 'Incorrect security code.' });

  const bankRes = await pool.query('SELECT * FROM bank_accounts WHERE id=$1 AND user_id=$2', [bank_account_id, req.user.id]);
  const bank = bankRes.rows[0];
  if (!bank) return res.status(404).json({ error: 'Bank account not found.' });

  const client = await pool.connect();
  const ref = genRef('MKO-WD');
  try {
    await client.query('BEGIN');
    const bal = await getWalletBalance(req.user.id, 'available');
    if (bal < amt) throw new Error('Insufficient available balance.');

    await adjustWallet(client, req.user.id, 'available', -amt);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status, flw_ref, bank_account_id) VALUES ($1,$2,'withdraw','pending',$3,$4)`,
      [req.user.id, -amt, ref, bank.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    return res.status(400).json({ error: err.message });
  }
  client.release();

  // Ask Flutterwave to send the money. If this submission itself fails, refund immediately.
  try {
    await flw.initiateTransfer({
      account_bank: bank.bank_code,
      account_number: bank.account_number,
      amount: amt,
      reference: ref,
      narration: 'MakolaOnline Withdrawal',
    });
    await logHistory(req.user.id, 'withdraw_requested', `₵${amt} to ${bank.bank_name} ${bank.account_number}`);
    res.status(201).json({ ok: true, reference: ref });
  } catch (err) {
    const refundClient = await pool.connect();
    try {
      await refundClient.query('BEGIN');
      await adjustWallet(refundClient, req.user.id, 'available', amt);
      await refundClient.query(`UPDATE wallet_transactions SET status='rejected' WHERE flw_ref=$1`, [ref]);
      await refundClient.query('COMMIT');
    } catch (e2) {
      await refundClient.query('ROLLBACK');
    } finally {
      refundClient.release();
    }
    res.status(502).json({ error: 'Withdrawal could not be sent, your balance has been refunded: ' + err.message });
  }
});

/* ---- Flutterwave webhook — the authoritative source of truth ---- */

app.post('/api/webhooks/flutterwave', express.json(), async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }
  const event = req.body;
  try {
    if (event.event === 'charge.completed' && event.data?.status === 'successful') {
      const verified = await flw.verifyTransaction(event.data.id);
      if (verified.status === 'successful') {
        await creditDepositIfPending(verified.tx_ref, verified.amount);
      }
    } else if (event.event === 'transfer.completed') {
      const ref = event.data?.reference;
      const txRes = await pool.query(`SELECT * FROM wallet_transactions WHERE flw_ref=$1 AND type='withdraw'`, [ref]);
      const tx = txRes.rows[0];
      if (tx && tx.status === 'pending') {
        if (event.data.status === 'SUCCESSFUL') {
          await pool.query(`UPDATE wallet_transactions SET status='approved' WHERE id=$1`, [tx.id]);
          await logHistory(tx.user_id, 'withdraw_completed', `₵${Math.abs(tx.amount)} sent successfully`);
        } else {
          // Transfer failed on Flutterwave's side — refund the customer.
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await adjustWallet(client, tx.user_id, 'available', Math.abs(Number(tx.amount)));
            await client.query(`UPDATE wallet_transactions SET status='rejected' WHERE id=$1`, [tx.id]);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
          await logHistory(tx.user_id, 'withdraw_failed', `₵${Math.abs(tx.amount)} withdrawal failed, refunded`);
        }
      }
    }
  } catch (err) {
    console.error('Webhook handling error:', err.message);
  }
  res.json({ ok: true }); // always 200 so Flutterwave doesn't endlessly retry
});

/* ------------------------------------------------------------------ */
/* PROFILE + HISTORY                                                   */
/* ------------------------------------------------------------------ */

app.get('/api/profile', authenticate, async (req, res) => {
  const user = { ...req.user };
  delete user.password_hash;
  res.json(user);
});

app.get('/api/history', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* NOTIFICATIONS (admin broadcasts, read via a bell icon)              */
/* ------------------------------------------------------------------ */

app.get('/api/notifications', authenticate, async (req, res) => {
  const audienceMatch = req.user.role === 'customer' ? ['everyone', 'customers'] : ['everyone', 'resellers'];
  const { rows } = await pool.query(
    `SELECT n.*, (nr.id IS NOT NULL) AS is_read FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1
     WHERE n.audience = ANY($2) ORDER BY n.created_at DESC LIMIT 30`,
    [req.user.id, audienceMatch]
  );
  res.json(rows);
});

app.post('/api/notifications/:id/read', authenticate, async (req, res) => {
  await pool.query(
    `INSERT INTO notification_reads (notification_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* ADMIN PANEL                                                         */
/* ------------------------------------------------------------------ */

app.get('/api/admin/vendor-applications', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT va.*, u.name, u.email FROM vendor_applications va JOIN users u ON u.id = va.user_id
     WHERE va.status='pending' ORDER BY va.created_at`
  );
  res.json(rows);
});

app.post('/api/admin/vendor-applications/:id/:decision', authenticate, requireAdmin, async (req, res) => {
  const { id, decision } = req.params;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`UPDATE vendor_applications SET status=$1 WHERE id=$2 RETURNING *`, [status, id]);
    const app_ = rows[0];
    if (!app_) throw new Error('Application not found.');

    if (status === 'approved') {
      await client.query('UPDATE users SET role=$1 WHERE id=$2', [app_.type, app_.user_id]);
      await client.query(
        `INSERT INTO subscriptions (user_id, plan_id, status, renews_at) VALUES ($1,$2,'active', NOW() + INTERVAL '1 month')
         ON CONFLICT (user_id) DO UPDATE SET plan_id=$2, status='active', renews_at=NOW() + INTERVAL '1 month'`,
        [app_.user_id, app_.plan_id]
      );
    } else if (Number(app_.price_paid) > 0) {
      await adjustWallet(client, app_.user_id, 'available', Number(app_.price_paid));
      await client.query(`INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'refund','approved')`, [app_.user_id, Number(app_.price_paid)]);
    }
    await client.query('COMMIT');
    await logHistory(app_.user_id, 'vendor_application_' + status, `Type: ${app_.type}`);
    res.json(app_);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/admin/products', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS reseller_name FROM products p JOIN users u ON u.id=p.reseller_id ORDER BY p.created_at DESC`
  );
  res.json(rows);
});

app.post('/api/admin/products/:id/:decision', authenticate, requireAdmin, async (req, res) => {
  const status = req.params.decision === 'approve' ? 'approved' : 'rejected';
  const { rows } = await pool.query('UPDATE products SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  res.json(rows[0]);
});

app.get('/api/admin/jobs', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT j.*, u.name AS employer_name FROM jobs j JOIN users u ON u.id=j.employer_id ORDER BY j.created_at DESC`
  );
  res.json(rows);
});

app.post('/api/admin/jobs/:id/:decision', authenticate, requireAdmin, async (req, res) => {
  const status = req.params.decision === 'approve' ? 'approved' : 'rejected';
  const { rows } = await pool.query('UPDATE jobs SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  res.json(rows[0]);
});

// Deposits are automatic via Flutterwave now — this just gives Admin visibility into recent activity.
app.get('/api/admin/deposits', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT wt.*, u.name, u.email FROM wallet_transactions wt JOIN users u ON u.id=wt.user_id
     WHERE wt.type='deposit' ORDER BY wt.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

// Admin sees the TOTAL money in the system across everyone (oversight only —
// this is not Admin's own money and cannot be withdrawn). Admin's own withdrawable
// balance is separate: only their own deposits + vendor application fees.
app.get('/api/admin/wallet-summary', authenticate, requireAdmin, async (req, res) => {
  const totals = await pool.query(
    `SELECT type, COALESCE(SUM(balance),0) AS total FROM wallet GROUP BY type`
  );
  const totalByType = {};
  totals.rows.forEach(r => { totalByType[r.type] = Number(r.total); });
  const adminAvailable = await getWalletBalance(req.user.id, 'available');
  res.json({
    totalAvailable: totalByType.available || 0,
    totalCashback: totalByType.cashback || 0,
    totalPending: totalByType.pending || 0,
    adminAvailable, // this is the only figure Admin can actually withdraw
  });
});

app.get('/api/admin/orders', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name, u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC`
  );
  res.json(rows);
});

app.put('/api/admin/orders/:id/status', authenticate, requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['processing', 'shipped', 'completed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) throw new Error('Order not found.');

    const updated = await client.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    const newOrder = updated.rows[0];

    // Only settle escrow once per order, and only when moving into a terminal state.
    if (!order.escrow_settled && (status === 'completed' || status === 'rejected')) {
      const itemsRes = await client.query(
        `SELECT oi.*, p.reseller_id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
        [order.id]
      );

      if (status === 'completed') {
        // Release each reseller's held share from pending -> available.
        for (const item of itemsRes.rows) {
          const lineAmt = Number(item.price) * item.qty;
          await adjustWallet(client, item.reseller_id, 'pending', -lineAmt);
          await adjustWallet(client, item.reseller_id, 'available', lineAmt);
          await client.query(
            `INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'pending_release','approved')`,
            [item.reseller_id, lineAmt]
          );
        }
        // Give the customer cashback on the full order total (rate + expiry are admin-configurable).
        const cashbackPercent = await getCashbackPercent();
        if (cashbackPercent > 0) {
          const cashbackAmt = Math.round(Number(order.total) * cashbackPercent) / 100;
          const expiryDays = await getCashbackExpiryDays();
          await adjustWallet(client, order.user_id, 'cashback', cashbackAmt);
          await client.query(
            `INSERT INTO wallet_transactions (user_id, amount, type, status, expires_at) VALUES ($1,$2,'cashback','approved', NOW() + ($3 || ' days')::INTERVAL)`,
            [order.user_id, cashbackAmt, String(expiryDays)]
          );
        }
      } else if (status === 'rejected') {
        // Cancel each reseller's held escrow — the sale didn't go through.
        for (const item of itemsRes.rows) {
          const lineAmt = Number(item.price) * item.qty;
          await adjustWallet(client, item.reseller_id, 'pending', -lineAmt);
        }
        // Refund the customer in full.
        await adjustWallet(client, order.user_id, 'available', Number(order.total));
        await client.query(
          `INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'refund','approved')`,
          [order.user_id, Number(order.total)]
        );
      }

      await client.query('UPDATE orders SET escrow_settled = true WHERE id = $1', [order.id]);
    }

    await client.query('COMMIT');
    await logHistory(newOrder.user_id, 'order_status_' + status, `Order ${newOrder.order_no}`);
    res.json(newOrder);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, phone, role, status, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/admin/users/:id/ban', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE users SET status='banned' WHERE id=$1 RETURNING id, name, email`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await logHistory(rows[0].id, 'auto_ban', 'Zero Tolerance to Fraud — account banned automatically/by admin');
  res.json(rows[0]);
});

app.post('/api/admin/users/:id/unban', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE users SET status='active' WHERE id=$1 RETURNING id, name, email`, [req.params.id]);
  res.json(rows[0]);
});

// Admin resets anyone's forgotten withdrawal security code — confirm their identity yourself first.
app.post('/api/admin/users/reset-security-code', authenticate, requireAdmin, async (req, res) => {
  const { email, new_code } = req.body;
  if (!/^\d{5}$/.test(new_code || '')) return res.status(400).json({ error: 'Security code must be exactly 5 digits.' });
  const hash = await bcrypt.hash(new_code, 10);
  const { rows } = await pool.query('UPDATE users SET security_code_hash=$1 WHERE email=$2 RETURNING id, name, email', [hash, (email || '').toLowerCase()]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await logHistory(rows[0].id, 'security_code_reset_by_admin', 'Withdrawal security code reset by Admin');
  res.json({ ok: true, user: rows[0] });
});

// Full order + wallet history for one user, for support/dispute cases.
app.get('/api/admin/users/lookup', authenticate, requireAdmin, async (req, res) => {
  const { email } = req.query;
  const userRes = await pool.query('SELECT id, name, email, phone, role, status, ghana_card, created_at FROM users WHERE email=$1', [(email || '').toLowerCase()]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const [orders, wallet, txs] = await Promise.all([
    pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [user.id]),
    pool.query('SELECT * FROM wallet WHERE user_id=$1', [user.id]),
    pool.query('SELECT * FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [user.id]),
  ]);
  res.json({ user, orders: orders.rows, wallet: wallet.rows, transactions: txs.rows });
});

// Admin creates a fully-verified reseller/employer directly — no self-serve KYC.
app.post('/api/admin/vendors/add-manual', authenticate, requireAdmin, async (req, res) => {
  const {
    name, phone, ghana_card, email, business_name, business_category, business_address, business_region,
    bank_code, bank_name, account_number, plan_code, type,
  } = req.body;
  if (!['reseller', 'employer'].includes(type)) return res.status(400).json({ error: 'Choose reseller or employer.' });
  if (!name || !email) return res.status(400).json({ error: 'Full name and email are required.' });
  if (ghana_card && !isValidGhanaCard(ghana_card)) return res.status(400).json({ error: 'Ghana Card must look like GHA-XXXXXXXXX-X.' });

  const planRes = await pool.query('SELECT * FROM plans WHERE code=$1 AND type=$2', [plan_code, type]);
  const plan = planRes.rows[0];
  if (!plan) return res.status(400).json({ error: 'Please choose a valid plan.' });

  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (existing.rows.length) return res.status(409).json({ error: 'This email is already registered.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tempPassword = crypto.randomBytes(5).toString('hex');
    const hash = await bcrypt.hash(tempPassword, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, phone, password_hash, role, ghana_card, business_name, business_category, business_address, business_region, added_by_admin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id, name, email`,
      [name, email.toLowerCase(), phone || null, hash, type, ghana_card || null, business_name || null, business_category || null, business_address || null, business_region || null]
    );
    const user = userRes.rows[0];
    await client.query(`INSERT INTO wallet (user_id, balance, type) VALUES ($1,0,'available'),($1,0,'cashback'),($1,0,'pending')`, [user.id]);

    if (bank_code && account_number) {
      const resolved = await flw.resolveAccount({ account_number, account_bank: bank_code }).catch(() => null);
      await client.query(
        `INSERT INTO bank_accounts (user_id, bank_name, bank_code, account_number, account_name) VALUES ($1,$2,$3,$4,$5)`,
        [user.id, bank_name, bank_code, account_number, resolved ? resolved.account_name : null]
      );
    }

    // Admin-added vendors start active immediately — no payment collected.
    await client.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, renews_at) VALUES ($1,$2,'active', NOW() + INTERVAL '1 month')`,
      [user.id, plan.id]
    );

    await client.query('COMMIT');
    await logHistory(user.id, 'added_by_admin', `Added as ${type} on ${plan.name} plan by Admin`);
    res.status(201).json({ user, temp_password: tempPassword });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ---- Coupons ---- */

app.get('/api/admin/coupons', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM coupons WHERE is_active=true ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/admin/coupons', authenticate, requireAdmin, async (req, res) => {
  const { code, percent_off, audience, target_email, expires_at } = req.body;
  if (!code || !percent_off || !audience) return res.status(400).json({ error: 'Code, % off, and audience are required.' });
  let target_user_id = null;
  if (target_email) {
    const u = await pool.query('SELECT id FROM users WHERE email=$1', [target_email.toLowerCase()]);
    if (!u.rows[0]) return res.status(404).json({ error: 'That person was not found.' });
    target_user_id = u.rows[0].id;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (code, percent_off, audience, target_user_id, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [code.toUpperCase(), percent_off, audience, target_user_id, expires_at || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message.includes('duplicate') ? 'That coupon code is already in use.' : err.message });
  }
});

app.delete('/api/admin/coupons/:id', authenticate, requireAdmin, async (req, res) => {
  await pool.query('UPDATE coupons SET is_active=false WHERE id=$1', [req.params.id]);
  res.json({ deactivated: true });
});

/* ---- Notifications ---- */

app.post('/api/admin/notifications', authenticate, requireAdmin, async (req, res) => {
  const { message, audience } = req.body;
  if (!message || !['everyone', 'resellers', 'customers'].includes(audience)) {
    return res.status(400).json({ error: 'Message and a valid audience are required.' });
  }
  const { rows } = await pool.query('INSERT INTO notifications (audience, message) VALUES ($1,$2) RETURNING *', [audience, message]);
  res.status(201).json(rows[0]);
});

/* ---- Settings (cashback %, cashback expiry days) ---- */

app.get('/api/admin/settings', authenticate, requireAdmin, async (req, res) => {
  res.json({
    cashback_percent: await getCashbackPercent(),
    cashback_expiry_days: await getCashbackExpiryDays(),
  });
});

app.put('/api/admin/settings', authenticate, requireAdmin, async (req, res) => {
  const { cashback_percent, cashback_expiry_days } = req.body;
  if (cashback_percent != null) {
    await pool.query(`INSERT INTO settings (key,value) VALUES ('cashback_percent',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(cashback_percent)]);
  }
  if (cashback_expiry_days != null) {
    await pool.query(`INSERT INTO settings (key,value) VALUES ('cashback_expiry_days',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(cashback_expiry_days)]);
  }
  res.json({ ok: true });
});

/* ---- Subscriptions (admin oversight + free manual renew) ---- */

app.get('/api/admin/subscriptions', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, u.name, u.email, p.name AS plan_name, p.price FROM subscriptions s
     JOIN users u ON u.id = s.user_id JOIN plans p ON p.id = s.plan_id ORDER BY s.renews_at`
  );
  res.json(rows);
});

app.post('/api/admin/subscriptions/:userId/renew', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE subscriptions SET status='active', renews_at=NOW() + INTERVAL '1 month' WHERE user_id=$1 RETURNING *`,
    [req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Subscription not found.' });
  await logHistory(req.params.userId, 'subscription_renewed_free', 'Renewed by Admin at no charge');
  res.json(rows[0]);
});

app.post('/api/admin/banners', authenticate, requireAdmin, async (req, res) => {
  const { image_url, text, link } = req.body;
  if (!image_url && !text) return res.status(400).json({ error: 'Add a picture, text, or both.' });
  const { rows } = await pool.query(
    'INSERT INTO banners (image_url, text, link) VALUES ($1,$2,$3) RETURNING *',
    [image_url || null, text || null, link || null]
  );
  res.status(201).json(rows[0]);
});

app.put('/api/admin/banners/:id', authenticate, requireAdmin, async (req, res) => {
  const { is_active } = req.body;
  const { rows } = await pool.query('UPDATE banners SET is_active=$1 WHERE id=$2 RETURNING *', [is_active, req.params.id]);
  res.json(rows[0]);
});

app.delete('/api/admin/banners/:id', authenticate, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM banners WHERE id=$1', [req.params.id]);
  res.json({ deleted: true });
});

app.get('/api/admin/history', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.*, u.name, u.email FROM history h JOIN users u ON u.id=h.user_id ORDER BY h.created_at DESC LIMIT 300`
  );
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* Fallback — serve the single-page frontend for any other route      */
/* ------------------------------------------------------------------ */

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 5000;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`🇬🇭 MakolaOnline running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('❌ Failed to initialize database schema:', err.message);
    console.error('   → If you see ECONNREFUSED to ::1 or 127.0.0.1, the app is not reading your database credentials.');
    console.error('   → On Render: set DATABASE_URL in the web service\'s Environment tab to the Postgres "Internal Database URL".');
    console.error('   → Locally: fill in DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT in your .env file.');
    process.exit(1);
  });
