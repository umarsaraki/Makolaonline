// server.js — MakolaOnline.com backend (Node.js + Express + PostgreSQL)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initSchema, logHistory } = require('./db');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function genOrderNo() {
  return 'MKO-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100);
}

// Verifies the JWT and loads the current user row (so status/role are always fresh).
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not logged in. Please log in.' });

    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Ba a samu account ba.' });
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
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin kadai zai iya wannan.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role && !req.user.isAdmin) {
      return res.status(403).json({ error: `Kai ba ${role} ba ne.` });
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
    if (existing.rows.length) return res.status(409).json({ error: 'Wannan email an riga an yi rijista dashi.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, ghana_card)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role`,
      [name, email.toLowerCase(), phone || null, hash, ghana_card || null]
    );
    const user = rows[0];

    // Every user gets a shopping + cashback wallet from day one.
    await pool.query(`INSERT INTO wallet (user_id, balance, type) VALUES ($1, 0, 'shopping'), ($1, 0, 'cashback')`, [user.id]);
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
  if (!rows[0]) return res.status(404).json({ error: 'Ba a samu kayan ba.' });
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

app.post('/api/vendor/apply', authenticate, async (req, res) => {
  const { type } = req.body;
  if (!['reseller', 'employer'].includes(type)) return res.status(400).json({ error: 'Zaɓi reseller ko employer.' });

  const existing = await pool.query(
    `SELECT * FROM vendor_applications WHERE user_id = $1 AND type = $2 AND status = 'pending'`,
    [req.user.id, type]
  );
  if (existing.rows.length) return res.status(409).json({ error: 'Your application is already pending approval.' });

  const { rows } = await pool.query(
    `INSERT INTO vendor_applications (user_id, type) VALUES ($1, $2) RETURNING *`,
    [req.user.id, type]
  );
  await logHistory(req.user.id, 'vendor_apply', `Ya nemi zama ${type}`);
  res.status(201).json(rows[0]);
});

app.get('/api/vendor/status', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_applications WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* RESELLER DASHBOARD — CRUD products                                 */
/* ------------------------------------------------------------------ */

app.get('/api/reseller/products', authenticate, requireRole('reseller'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE reseller_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

app.post('/api/reseller/products', authenticate, requireRole('reseller'), async (req, res) => {
  const { name, price, image, description, category } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price are required.' });
  const { rows } = await pool.query(
    `INSERT INTO products (reseller_id, name, price, image, description, category)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.id, name, price, image || null, description || null, category || null]
  );
  await logHistory(req.user.id, 'product_create', `Ya kara kaya: ${name}`);
  res.status(201).json(rows[0]);
});

app.put('/api/reseller/products/:id', authenticate, requireRole('reseller'), async (req, res) => {
  const { name, price, image, description, category } = req.body;
  const { rows } = await pool.query(
    `UPDATE products SET name=$1, price=$2, image=$3, description=$4, category=$5, status='pending'
     WHERE id=$6 AND reseller_id=$7 RETURNING *`,
    [name, price, image, description, category, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ba a samu kayan ba.' });
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
  const { rows } = await pool.query(
    `INSERT INTO jobs (employer_id, title, description, salary, location) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.id, title, description || null, salary || null, location || null]
  );
  await logHistory(req.user.id, 'job_create', `Ya kara aiki: ${title}`);
  res.status(201).json(rows[0]);
});

app.put('/api/employer/jobs/:id', authenticate, requireRole('employer'), async (req, res) => {
  const { title, description, salary, location } = req.body;
  const { rows } = await pool.query(
    `UPDATE jobs SET title=$1, description=$2, salary=$3, location=$4, status='pending'
     WHERE id=$5 AND employer_id=$6 RETURNING *`,
    [title, description, salary, location, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ba a samu aikin ba.' });
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
/* ORDERS — place + view (wallet-based manual payment)                */
/* ------------------------------------------------------------------ */

app.post('/api/orders', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const { items } = req.body; // [{ product_id, qty }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Babu kaya a cikin cart.' });

    await client.query('BEGIN');

    let total = 0;
    const priced = [];
    for (const it of items) {
      const { rows } = await client.query(`SELECT * FROM products WHERE id=$1 AND status='approved'`, [it.product_id]);
      const p = rows[0];
      if (!p) throw new Error('Wani kaya ba ya samuwa ko ba a amince dashi ba.');
      total += Number(p.price) * Number(it.qty);
      priced.push({ product_id: p.id, qty: it.qty });
    }

    const walletRes = await client.query(`SELECT * FROM wallet WHERE user_id=$1 AND type='shopping'`, [req.user.id]);
    const wallet = walletRes.rows[0];
    if (!wallet || Number(wallet.balance) < total) {
      throw new Error('Insufficient wallet balance. Please deposit before placing an order.');
    }

    const orderNo = genOrderNo();
    const orderRes = await client.query(
      `INSERT INTO orders (user_id, order_no, total) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, orderNo, total]
    );
    const order = orderRes.rows[0];

    for (const it of priced) {
      await client.query(`INSERT INTO order_items (order_id, product_id, qty) VALUES ($1,$2,$3)`, [order.id, it.product_id, it.qty]);
    }

    await client.query(`UPDATE wallet SET balance = balance - $1 WHERE user_id=$2 AND type='shopping'`, [total, req.user.id]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'order','approved')`,
      [req.user.id, -total]
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
  if (!order) return res.status(404).json({ error: 'Ba a samu order ba.' });
  const itemsRes = await pool.query(
    `SELECT oi.*, p.name, p.image FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
    [order.id]
  );
  res.json({ ...order, items: itemsRes.rows });
});

/* ------------------------------------------------------------------ */
/* WALLET + CASHBACK                                                   */
/* ------------------------------------------------------------------ */

app.get('/api/wallet', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM wallet WHERE user_id = $1', [req.user.id]);
  const shopping = rows.find(r => r.type === 'shopping') || { balance: 0 };
  const cashback = rows.find(r => r.type === 'cashback') || { balance: 0 };
  res.json({ shopping: Number(shopping.balance), cashback: Number(cashback.balance) });
});

app.get('/api/wallet/cashback', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions WHERE user_id=$1 AND type='cashback' ORDER BY created_at DESC`,
    [req.user.id]
  );
  const available = rows.filter(r => r.status === 'approved').reduce((s, r) => s + Number(r.amount), 0);
  res.json({ all: rows, available });
});

app.post('/api/wallet/deposit', authenticate, async (req, res) => {
  const { amount, screenshot_url } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Enter the amount you want to deposit.' });
  const { rows } = await pool.query(
    `INSERT INTO wallet_transactions (user_id, amount, type, status) VALUES ($1,$2,'deposit','pending') RETURNING *`,
    [req.user.id, amount]
  );
  await logHistory(req.user.id, 'deposit_request', `Deposit request of ₵${amount} (screenshot: ${screenshot_url || 'none'})`);
  res.status(201).json(rows[0]);
});

// Manual payment details shown on the Deposit screen
app.get('/api/wallet/payment-details', authenticate, (req, res) => {
  res.json({
    momo_number: process.env.MOMO_NUMBER || '024xxxxxxx',
    momo_name: process.env.MOMO_NAME || 'MakolaOnline Ltd',
    bank_name: process.env.BANK_NAME || 'GCB Bank',
    bank_account_number: process.env.BANK_ACCOUNT_NUMBER || '',
    bank_account_name: process.env.BANK_ACCOUNT_NAME || '',
  });
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
  const { rows } = await pool.query(`UPDATE vendor_applications SET status=$1 WHERE id=$2 RETURNING *`, [status, id]);
  const app_ = rows[0];
  if (!app_) return res.status(404).json({ error: 'Application not found.' });
  if (status === 'approved') {
    await pool.query('UPDATE users SET role=$1 WHERE id=$2', [app_.type, app_.user_id]);
  }
  await logHistory(app_.user_id, 'vendor_application_' + status, `Type: ${app_.type}`);
  res.json(app_);
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

app.get('/api/admin/deposits', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT wt.*, u.name, u.email FROM wallet_transactions wt JOIN users u ON u.id=wt.user_id
     WHERE wt.type='deposit' AND wt.status='pending' ORDER BY wt.created_at`
  );
  res.json(rows);
});

app.post('/api/admin/deposits/:id/:decision', authenticate, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const status = req.params.decision === 'approve' ? 'approved' : 'rejected';
    const { rows } = await client.query('UPDATE wallet_transactions SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    const tx = rows[0];
    if (!tx) throw new Error('Ba a samu deposit ba.');
    if (status === 'approved') {
      await client.query(`UPDATE wallet SET balance = balance + $1 WHERE user_id=$2 AND type='shopping'`, [tx.amount, tx.user_id]);
    }
    await client.query('COMMIT');
    await logHistory(tx.user_id, 'deposit_' + status, `₵${tx.amount}`);
    res.json(tx);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
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
  const { rows } = await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (rows[0]) await logHistory(rows[0].user_id, 'order_status_' + status, `Order ${rows[0].order_no}`);
  res.json(rows[0]);
});

app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, phone, role, status, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/admin/users/:id/ban', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE users SET status='banned' WHERE id=$1 RETURNING id, name, email`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Ba a samu user ba.' });
  await logHistory(rows[0].id, 'auto_ban', 'Zero Tolerance to Fraud — account banned automatically/by admin');
  res.json(rows[0]);
});

app.post('/api/admin/users/:id/unban', authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE users SET status='active' WHERE id=$1 RETURNING id, name, email`, [req.params.id]);
  res.json(rows[0]);
});

app.post('/api/admin/banners', authenticate, requireAdmin, async (req, res) => {
  const { image_url, link } = req.body;
  const { rows } = await pool.query('INSERT INTO banners (image_url, link) VALUES ($1,$2) RETURNING *', [image_url, link || null]);
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
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route ba ta samuwa ba.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 5000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`🇬🇭 MakolaOnline running on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('❌ Failed to initialize database schema:', err.message);
    console.error('   → If you see ECONNREFUSED to ::1 or 127.0.0.1, the app is not reading your database credentials.');
    console.error('   → On Render: set DATABASE_URL in the web service\'s Environment tab to the Postgres "Internal Database URL".');
    console.error('   → Locally: fill in DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT in your .env file.');
    process.exit(1);
  });
