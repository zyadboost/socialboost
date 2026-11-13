require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

/* DATABASE — PostgreSQL (Neon) */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      jap_id VARCHAR(50) PRIMARY KEY,
      category TEXT,
      name TEXT,
      type TEXT,
      rate NUMERIC,
      min_qty INTEGER,
      max_qty INTEGER,
      my_price NUMERIC
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(50) PRIMARY KEY,
      service_jap_id VARCHAR(50),
      service_name TEXT,
      link TEXT,
      quantity INTEGER,
      amount NUMERIC,
      jap_rate NUMERIC,
      jap_order_id VARCHAR(50),
      jap_cost NUMERIC,
      method VARCHAR(30),
      status VARCHAR(30),
      pay_ref TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      paid_at TIMESTAMP,
      completed_at TIMESTAMP
    )`);
    await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      code VARCHAR(30) PRIMARY KEY,
      discount_pct NUMERIC,
      uses_left INTEGER,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(
    `INSERT INTO coupons (code, discount_pct, uses_left, active)
     VALUES ('WELCOME20', 20, 100, true)
     ON CONFLICT (code) DO NOTHING`
  );
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP`);
  console.log('Database ready');
}

function money(n) { return '$' + Number(n).toFixed(2); }

/* ===== SECURITY: ADMIN KEY MOWAHHAD + CHECK ===== */
function adminKey() { return String(process.env.ADMIN_PASSWORD || 'Zyad@26/26@').trim(); }
function checkAdmin(req) {
  var k = String(req.query.key || req.headers['x-admin-key'] || (req.body && req.body.key) || '').trim();
  return k.length > 0 && k === adminKey();
}
/* RATE LIMIT dyal login — 5 attempts f 10 dqay9 / IP */
var loginTries = {};
function loginBlocked(ip) {
  var now = Date.now();
  var t = (loginTries[ip] || []).filter(function(ts){ return now - ts < 10 * 60 * 1000; });
  loginTries[ip] = t;
  return t.length >= 5;
}
function loginFail(ip) {
  if (!loginTries[ip]) loginTries[ip] = [];
  loginTries[ip].push(Date.now());
}

/* ===== 🔐 SECURITY: ADMIN KEY MOWAHHAD + CHECK ===== */
function adminKey() { return String(process.env.ADMIN_PASSWORD || 'Zyad@26/26@').trim(); }
function checkAdmin(req) {
  var k = String(req.query.key || req.headers['x-admin-key'] || (req.body && req.body.key) || '').trim();
  return k.length > 0 && k === adminKey();
}
/* 🚫 RATE LIMIT dyal login — 5 attempts f 10 dqay9 / IP */
var loginTries = {};
function loginBlocked(ip) {
  var now = Date.now();
  var t = (loginTries[ip] || []).filter(function(ts){ return now - ts < 10 * 60 * 1000; });
  loginTries[ip] = t;
  return t.length >= 5;
}
function loginFail(ip) {
  if (!loginTries[ip]) loginTries[ip] = [];
  loginTries[ip].push(Date.now());
}

/* TELEGRAM */
async function notifyTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage',
      { chat_id: process.env.TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch (e) { console.error('TG error: ' + e.message); }
}

/* JAP API */
const JAP_URL = process.env.JAP_API_URL || 'https://justanotherpanel.com/api/v2';
const JAP_KEY = process.env.JAP_API_KEY;

async function importJAPServices() {
  const res = await axios.post(JAP_URL, { key: JAP_KEY, action: 'services' });
  return res.data;
}
async function createJAPOrder(serviceJapId, link, quantity) {
  const res = await axios.post(JAP_URL, {
    key: JAP_KEY, action: 'add',
    service: serviceJapId, link: link, quantity: quantity
  });
  return res.data;
}
async function checkJAPStatus(japOrderId) {
  const res = await axios.post(JAP_URL, { key: JAP_KEY, action: 'status', order: japOrderId });
  return res.data;
}
async function getJAPBalance() {
  const res = await axios.post(JAP_URL, { key: JAP_KEY, action: 'balance' });
  return res.data;
}

/* PAYPAL */
let paypalToken = null;
let paypalTokenExpiry = 0;

async function getPayPalAccessToken() {
  if (paypalToken && Date.now() < paypalTokenExpiry) return paypalToken;
  const pair = process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET;
  const auth = Buffer.from(pair).toString('base64');
  const res = await axios.post(
    'https://api-m.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    { headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  paypalToken = res.data.access_token;
  paypalTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return paypalToken;
}

async function verifyPayPalCapture(captureId) {
  try {
    const token = await getPayPalAccessToken();
    const r = await axios.get(
      'https://api-m.paypal.com/v2/payments/captures/' + captureId,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const cap = r.data;
    if (cap.status === 'COMPLETED') return { success: true, amount: parseFloat(cap.amount.value) };
    return { success: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* SERVICES */
app.get('/api/import-services', async (req, res) => {
  try {
    // 🔒 حماية: خاص المفتاح ديال الأدمن
    if (!checkAdmin(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized — zid ?key=ADMIN_PASSWORD' });
    }
    const japServices = await importJAPServices();
    const margin = 2.2;
    let added = 0, skipped = 0;
    const keptIds = [];
    for (const s of japServices) {
      if (!isCleanService(s.name)) { skipped++; continue; }  // 🧹 بلا ضمان = كيتخطى
      keptIds.push(String(s.service));
      await pool.query(
        `INSERT INTO services (jap_id, category, name, type, rate, min_qty, max_qty, my_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (jap_id) DO UPDATE SET
           category=EXCLUDED.category, name=EXCLUDED.name, type=EXCLUDED.type,
           rate=EXCLUDED.rate, min_qty=EXCLUDED.min_qty, max_qty=EXCLUDED.max_qty,
           my_price=EXCLUDED.my_price`,
        [String(s.service), s.category, s.name, s.type,
         parseFloat(s.rate), parseInt(s.min), parseInt(s.max),
         (parseFloat(s.rate) * margin).toFixed(2)]
      );
      added++;
    }
    // 🗑️ مسح الخدمات القديمة لي بقاو فالقاعدة وما بقاش مقبولين
    let removed = 0;
    if (keptIds.length > 0) {
      const del = await pool.query('DELETE FROM services WHERE NOT (jap_id = ANY($1))', [keptIds]);
      removed = del.rowCount;
    }
    svcCache.data = null; // clear cache
    res.json({ success: true, added: added, skipped: skipped, removed: removed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ⚡ CACHE 10 dqay9 — nqilliw queries l Neon bach ma nharqoouch quota */
var svcCache = { data: null, at: 0 };
var SVC_CACHE_TTL = 10 * 60 * 1000;
app.get('/api/services', async (req, res) => {
  if (svcCache.data && Date.now() - svcCache.at < SVC_CACHE_TTL) return res.json(svcCache.data);
  try {
    const r = await pool.query('SELECT * FROM services ORDER BY jap_id');
    svcCache.data = r.rows.map(function(s) {
      return {
        japId: s.jap_id, category: s.category, name: s.name, type: s.type,
        rate: parseFloat(s.rate), min: s.min_qty, max: s.max_qty, myPrice: parseFloat(s.my_price)
      };
    });
    svcCache.at = Date.now();
    res.json(svcCache.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update-price', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Unauthorized' });
  try {
    const japId = req.body.japId;
    const newPrice = parseFloat(req.body.newPrice);
    await pool.query('UPDATE services SET my_price=$1 WHERE jap_id=$2', [newPrice, String(japId)]);
    svcCache.data = null; // clear cache
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ORDERS */
app.post('/api/create-order', async (req, res) => {
  try {
    const serviceJapId = String(req.body.serviceJapId);
    const link = req.body.link;
    const quantity = parseInt(req.body.quantity);
    const r = await pool.query('SELECT * FROM services WHERE jap_id=$1', [serviceJapId]);
    const svc = r.rows[0];
    if (!svc) return res.status(404).json({ success: false, error: 'Service not found' });

    // 🛡️ ANTI-DOUBLE ORDER: nfs service+link+qty f akher 10 dqay9 w mazal makhlas -> rje3 nafs l'order (mach jdid)
    try {
      const dup = await pool.query(
        `SELECT id, amount FROM orders
          WHERE service_jap_id=$1 AND link=$2 AND quantity=$3
            AND method='pending' AND created_at > NOW() - INTERVAL '10 minutes'
          ORDER BY created_at DESC LIMIT 1`,
        [serviceJapId, link, quantity]
      );
      if (dup.rows[0]) {
        console.log('DEDUP: reuse ' + dup.rows[0].id + ' (blocked duplicate order)');
        return res.json({ success: true, orderId: dup.rows[0].id, amount: parseFloat(dup.rows[0].amount), dedup: true });
      }
    } catch (dedupErr) { console.error('DEDUP check skipped: ' + dedupErr.message); }

       let amount = ((quantity / 1000) * parseFloat(svc.my_price)).toFixed(2);
    if (req.body.coupon) {
      try {
        const cc = await pool.query('SELECT * FROM coupons WHERE code=$1 AND active=true', [String(req.body.coupon).toUpperCase()]);
        const coupon = cc.rows[0];
        if (coupon && (coupon.uses_left === null || coupon.uses_left > 0)) {
          amount = (parseFloat(amount) * (1 - parseFloat(coupon.discount_pct) / 100)).toFixed(2);
        }
      } catch(e) {}
    }
    const orderId = 'ORD-' + Date.now();

    await pool.query(
      `INSERT INTO orders (id, service_jap_id, service_name, link, quantity, amount, jap_rate, method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orderId, serviceJapId, svc.name, link, quantity, amount,
       parseFloat(svc.rate), 'pending', 'Pending']
    );
    res.json({ success: true, orderId: orderId, amount: parseFloat(amount) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/pay-order', async (req, res) => {
  try {
    const orderId = req.body.orderId;
    const method = req.body.method;
    const paymentRef = req.body.paymentRef;
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    // 🛡️ ANTI-DOUBLE: ila l'order tsift la JAP 9bel, mat3awdch (PayPal kay3awd onApprove sautan)
    if (order.jap_order_id) return res.json({ success: true, message: 'Already paid & sent to JAP', order: { id: orderId, status: order.status, japOrderId: order.jap_order_id } });

    let paid = false;
    if (method === 'paypal') {
      const v = await verifyPayPalCapture(paymentRef);
      if (v.success && v.amount >= parseFloat(order.amount)) paid = true;
    }
    if (!paid) return res.status(400).json({ success: false, error: 'Payment verification failed' });

    const jap = await createJAPOrder(order.service_jap_id, order.link, order.quantity);
    if (jap && jap.order) {
      const japCost = ((order.quantity / 1000) * parseFloat(order.jap_rate || 0)).toFixed(2);
      await pool.query(
        `UPDATE orders SET method=$1, pay_ref=$2, paid_at=NOW(), jap_order_id=$3, jap_cost=$4, status='In Progress' WHERE id=$5`,
        [method, paymentRef, String(jap.order), japCost, orderId]
      );
      res.json({ success: true, order: { id: orderId, status: 'In Progress', japOrderId: jap.order } });
    } else {
      await pool.query(`UPDATE orders SET method=$1, pay_ref=$2, paid_at=NOW(), status='Pending Manual' WHERE id=$3`,
        [method, paymentRef, orderId]);
      res.json({ success: true, order: { id: orderId, status: 'Pending Manual' } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* MANUAL CLAIM */
app.post('/api/claim-payment', async (req, res) => {
  try {
    const orderId = req.body.orderId;
    const method = req.body.method;
    const paymentRef = req.body.paymentRef;
    if (!orderId || !method || !paymentRef) {
      return res.status(400).json({ success: false, error: 'Missing data' });
    }
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found: ' + orderId });

    await pool.query(
      `UPDATE orders SET method=$1, pay_ref=$2, status='Pending', claimed_at=NOW() WHERE id=$3`,
      [method, paymentRef, orderId]
    );

    const akey = adminKey();
    const host = req.protocol + '://' + req.get('host');
    const confirmUrl = host + '/api/admin/confirm/' + orderId + '?key=' + encodeURIComponent(adminKey());

    notifyTelegram(
      '📦 <b>ORDER JDID!</b>\n\n' +
      order.service_name + '\n' +
      '🔗 ' + order.link + '\n' +
      '🔢 Qty: ' + order.quantity + '\n' +
      '💰 Total: $' + Number(order.amount).toFixed(2) + '\n' +
      '💳 Paid: ' + method + '\n' +
      '🧾 Ref: ' + paymentRef + '\n' +
      '🆔 ' + orderId + '\n\n' +
      '👉 <a href="' + confirmUrl + '">✅ CONFIRM DELIVERY</a>'
    );

    res.json({ success: true, orderId: orderId });
  } catch (err) {
    console.error('claim-payment ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ADMIN CONFIRM */
app.get('/api/admin/confirm/:orderId', async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Wrong admin key' });
    }
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found: ' + req.params.orderId });
    if (order.jap_order_id) return res.json({ success: true, message: 'Already sent', japOrderId: order.jap_order_id });

    const jap = await createJAPOrder(order.service_jap_id, order.link, order.quantity);
    if (jap && jap.order) {
      const japCost = ((order.quantity / 1000) * parseFloat(order.jap_rate || 0)).toFixed(2);
      await pool.query(
        `UPDATE orders SET jap_order_id=$1, jap_cost=$2, status='In Progress' WHERE id=$3`,
        [String(jap.order), japCost, req.params.orderId]
      );
      console.log('CONFIRMED: ' + req.params.orderId + ' -> JAP #' + jap.order);
      notifyTelegram(
        '✅ <b>CONFIRMED — Order sent to JAP!</b>\n\n' +
        '🆔 ' + req.params.orderId + '\n' +
        '🔢 JAP Order: #' + jap.order + '\n' +
        '📦 ' + (order.service_name || '') + '\n' +
        '🔢 Qty: ' + order.quantity + '\n' +
        '💰 $' + Number(order.amount || 0).toFixed(2) + '\n' +
        '📊 Status: In Progress 🚀'
      );
      res.json({ success: true, message: 'Order sent to JAP!', japOrderId: jap.order });
    } else {
      await pool.query(`UPDATE orders SET status='Confirm Failed' WHERE id=$1`, [req.params.orderId]);
      console.error('JAP ERROR for ' + req.params.orderId + ': ' + JSON.stringify(jap));
      res.status(500).json({ success: false, error: 'JAP error: ' + JSON.stringify(jap) });
    }
  } catch (err) {
    console.error('CONFIRM ERROR: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
function orderIdSafe(id) { return String(id); }

/* ADMIN REJECT */
app.get('/api/admin/reject/:orderId', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Wrong key' });
  try {
    await pool.query(`UPDATE orders SET status='Rejected' WHERE id=$1`, [req.params.orderId]);
    res.json({ success: true, message: 'Order rejected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ♻️ ADMIN REFILL — dhman JAP 30 days: kay3awd yseft followers li tah low */
app.get('/api/admin/refill/:orderId', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Wrong key' });
  try {
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (!order.jap_order_id) return res.status(400).json({ success: false, error: 'Had l-order mazal ma-tsifatch l JAP' });
    const rr = await axios.post(JAP_URL, { key: JAP_KEY, action: 'refill', order: order.jap_order_id });
    notifyTelegram('\u267b\ufe0f <b>REFILL REQUEST</b>\n\n' +
      '\ud83c\udd94 ' + order.id + '\n' +
      '\ud83d\udd22 JAP Order: #' + order.jap_order_id + '\n' +
      '\ud83d\udce6 ' + (order.service_name || '') + '\n' +
      '\ud83d\udd17 ' + (order.link || '') + '\n' +
      '\ud83d\udcca JAP response: ' + JSON.stringify(rr.data));
    res.json({ success: true, jap: rr.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ORDERS LECTURE */
app.get('/api/orders', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
    res.json(r.rows.map(function(o) {
      return {
        id: o.id, serviceJapId: o.service_jap_id, serviceName: o.service_name,
        link: o.link, quantity: o.quantity, amount: parseFloat(o.amount),
        japRate: parseFloat(o.jap_rate), japOrderId: o.jap_order_id,
        japCost: o.jap_cost ? parseFloat(o.jap_cost) : 0,
        method: o.method, status: o.status, payRef: o.pay_ref,
        createdAt: o.created_at
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ error: 'Not found' });
    if (order.jap_order_id) {
      try {
        const s2 = await checkJAPStatus(order.jap_order_id);
        if (s2.status) {
          let newStatus = order.status;
          if (s2.status === 'Completed') newStatus = 'Completed';
          if (s2.status === 'Canceled') newStatus = 'Canceled';
          if (s2.status === 'Partial') newStatus = 'Partial';
          if (newStatus !== order.status) {
            await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [newStatus, req.params.orderId]);
            order.status = newStatus;
          }
          order.japStatus = s2.status;
        }
      } catch(e) {}
    }
    res.json({
      id: order.id, serviceName: order.service_name, link: order.link,
      quantity: order.quantity, amount: parseFloat(order.amount),
      method: order.method, status: order.status
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error - try again' });
  }
});

app.get('/api/claims', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Unauthorized' });
  try {
    const r = await pool.query(`SELECT * FROM orders WHERE status='Pending' ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ADMIN */
app.post('/api/admin/login', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
  if (loginBlocked(ip)) {
    return res.status(429).json({ success: false, error: 'Too many attempts - try again in 10 minutes' });
  }
  const pass = String(req.body.password || '').trim();
  if (pass && pass === adminKey()) {
    delete loginTries[ip];
    res.json({ success: true });
  } else {
    loginFail(ip);
    res.status(401).json({ success: false, error: 'Wrong password!' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Unauthorized' });
  const r = await pool.query(`SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN status='Completed' THEN 1 END) as completed,
    COUNT(CASE WHEN status='In Progress' THEN 1 END) as in_progress,
    COUNT(CASE WHEN status='Pending' THEN 1 END) as pending,
    COALESCE(SUM(CASE WHEN status IN ('Completed','In Progress','Partial') THEN amount ELSE 0 END),0) as revenue,
    COALESCE(SUM(CASE WHEN status IN ('Completed','In Progress','Partial') THEN jap_cost ELSE 0 END),0) as cost
    FROM orders`);
  const s = r.rows[0];
  res.json({
    totalOrders: parseInt(s.total), completed: parseInt(s.completed),
    inProgress: parseInt(s.in_progress), pending: parseInt(s.pending),
    totalRevenue: parseFloat(s.revenue).toFixed(2),
    totalCost: parseFloat(s.cost).toFixed(2),
    totalProfit: (parseFloat(s.revenue) - parseFloat(s.cost)).toFixed(2)
  });
});

app.get('/api/admin/jap-balance', async (req, res) => {
  if (!checkAdmin(req)) return res.status(403).json({ success: false, error: 'Unauthorized' });
  try {
    const b = await getJAPBalance();
    res.json({ success: true, balance: b.balance, currency: b.currency });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ===== SERVICE QUALITY FILTER (خدمات نقية مضمونة فقط) ===== */
const BAD_SERVICE_RE = /no[\s-]*refil|without[\s-]*refill|non[\s-]*refil|no[\s-]*guarantee|no[\s-]*warranty|refill\s*[:=]?\s*(?:none|no\b(?!\s*-?\s*drop))|guarantee\s*[:=]?\s*(?:none|no\b(?!\s*-?\s*drop))|warranty\s*[:=]?\s*(?:none|no\b(?!\s*-?\s*drop))|refill\s*[:=]\s*0\b(?!\s*[-+]?\d)|huge\s*drop|drop\s*[:=]?\s*yes/i;
const GOOD_SERVICE_RE = /refill|guarantee|warranty|lifetime/i;
const PREMIUM_SERVICE_RE = /\breal\b|premium|\bhq\b|high\s*quality|targeted/i;

function isCleanService(name) {
  const n = String(name || '');
  if (BAD_SERVICE_RE.test(n)) return false;   // ⛔ No Refill / No Guarantee = مرفوضة
  return GOOD_SERVICE_RE.test(n);             // ✅ خاصها ضمان باش تدخل
}
function isPremiumService(name) {
  return PREMIUM_SERVICE_RE.test(String(name || ''));
}
/* PAYPAL ROUTES */
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const amount = req.body.amount;
    const description = req.body.description;
    const token = await getPayPalAccessToken();
    const r = await axios.post(
      'https://api-m.paypal.com/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: Number(amount).toFixed(2) },
          description: String(description || 'SocialBoost order').slice(0, 127)
        }]
      },
      { headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, orderId: r.data.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/paypal/capture', async (req, res) => {
  try {
    const orderId = req.body.orderId;
    const token = await getPayPalAccessToken();
    const r = await axios.post(
      'https://api-m.paypal.com/v2/checkout/orders/' + orderId + '/capture',
      {},
      { headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } }
    );
    const order = r.data;
    if (order.status === 'COMPLETED') {
      const amount = parseFloat(order.purchase_units[0].payments.captures[0].amount.value);
      const captureId = order.purchase_units[0].payments.captures[0].id;
      res.json({ success: true, amount: amount, captureId: captureId });
    } else {
      res.json({ success: false, error: 'Payment not completed' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* BEST SELLERS */
var bestCache = { data: null, at: 0 };
app.get('/api/best-sellers', async (req, res) => {
  if (bestCache.data && Date.now() - bestCache.at < SVC_CACHE_TTL) return res.json(bestCache.data);
  try {
    const r = await pool.query(
      `SELECT service_jap_id as jap_id, COUNT(*) as count
       FROM orders WHERE service_jap_id IS NOT NULL
       GROUP BY service_jap_id ORDER BY count DESC LIMIT 12`
    );
    bestCache.data = r.rows;
    bestCache.at = Date.now();
    res.json(bestCache.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/* COUPON CHECK (aman) */
app.get('/api/coupon/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const r = await pool.query('SELECT * FROM coupons WHERE code=$1 AND active=true', [code]);
    const c = r.rows[0];
    if (!c) return res.json({ success: false, error: 'Invalid code' });
    if (c.uses_left !== null && c.uses_left <= 0) return res.json({ success: false, error: 'Code expired' });
    res.json({ success: true, code: c.code, discount: parseFloat(c.discount_pct) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ===== 💳 YOUCAN PAY — CARTE BANCAIRE (MAD) ===== */
const YCP_PRI = String(process.env.YCP_PRIVATE_KEY || '').trim();
const YCP_PUB = String(process.env.YCP_PUBLIC_KEY || '').trim();
const YCP_RATE = parseFloat(process.env.USD_TO_MAD || '10') || 10;
const YCP_BASE = YCP_PRI.indexOf('sandbox') !== -1 ? 'https://youcanpay.com/sandbox' : 'https://youcanpay.com';

app.get('/api/ycp/config', (req, res) => {
  res.json({ enabled: Boolean(YCP_PRI && YCP_PUB), rate: YCP_RATE, pub: YCP_PUB });
});

function ycpMadCents(usd) { return Math.round(parseFloat(usd) * YCP_RATE * 100); }

app.post('/api/ycp/create', async (req, res) => {
  try {
    if (!YCP_PRI || !YCP_PUB) return res.status(400).json({ success: false, error: 'Card payments disabled' });
    const orderId = String(req.body.orderId || '');
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.jap_order_id || order.paid_at) return res.status(400).json({ success: false, error: 'Order already paid' });
    const madCents = ycpMadCents(order.amount);
    if (madCents < 1000) return res.status(400).json({ success: false, error: 'Minimum for card payment: 10 MAD (~$1). Please increase quantity.' });
    const form = new URLSearchParams();
    form.append('pri_key', YCP_PRI);
    form.append('order_id', orderId);
    form.append('amount', String(madCents));
    form.append('currency', 'MAD');
    form.append('success_url', 'https://socialboost-store.com/?card=success&order=' + encodeURIComponent(orderId));
    form.append('error_url', 'https://socialboost-store.com/?card=error&order=' + encodeURIComponent(orderId));
    form.append('metadata[orderId]', orderId);
    form.append('metadata[amountUsd]', String(order.amount));
    const yr = await axios.post(YCP_BASE + '/api/tokenize', form.toString(),
      { headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 25000 });
    const tok = yr.data && yr.data.token;
    if (!tok) return res.status(502).json({ success: false, error: 'YouCanPay error: ' + JSON.stringify(yr.data).slice(0, 200) });
    await pool.query(`UPDATE orders SET pay_ref=$1 WHERE id=$2`, [String(tok), orderId]);
    res.json({ success: true, token: String(tok), amountMad: madCents / 100 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function ycpVerifyPaid(orderId) {
  const q = 'limit=5&filters[0][field]=order_id&filters[0][operator]=%3D&filters[0][value]=' + encodeURIComponent(orderId);
  const r = await axios.get(YCP_BASE + '/api/v2/transactions?' + q, {
    auth: { username: YCP_PRI, password: '' },
    headers: { 'Accept': 'application/json' },
    timeout: 25000
  });
  const list = (r.data && r.data.data) || [];
  return list.find(function (t) { return t && t.status === 'paid'; }) || null;
}

async function ycpFulfill(orderId, tx) {
  const r = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const order = r.rows[0];
  if (!order) return { success: false, error: 'Order not found' };
  if (order.jap_order_id) return { success: true, already: true, japOrderId: order.jap_order_id };
  if (tx && tx.amount && tx.amount.amount) {
    const paidC = Math.round(parseFloat(tx.amount.amount) * 100);
    if (Math.abs(paidC - ycpMadCents(order.amount)) > 100) {
      console.error('YCP amount mismatch for ' + orderId + ' paid=' + paidC + ' expected=' + ycpMadCents(order.amount));
      return { success: false, error: 'Payment amount mismatch' };
    }
  }
  const jap = await createJAPOrder(order.service_jap_id, order.link, order.quantity);
  if (jap && jap.order) {
    const japCost = ((order.quantity / 1000) * parseFloat(order.jap_rate || 0)).toFixed(2);
    await pool.query(`UPDATE orders SET method='card-youcanpay', pay_ref=$1, paid_at=NOW(), jap_order_id=$2, jap_cost=$3, status='In Progress' WHERE id=$4`,
      [String(tx && tx.id ? tx.id : (order.pay_ref || 'card')), String(jap.order), japCost, orderId]);
    notifyTelegram(
      '💳 <b>CARTE BANCAIRE — Order paid!</b>\n\n' +
      '📦 ' + (order.service_name || '') + '\n' +
      '🔗 ' + order.link + '\n' +
      '🔢 Qty: ' + order.quantity + '\n' +
      '💰 $' + Number(order.amount).toFixed(2) + ' (~' + (ycpMadCents(order.amount) / 100).toFixed(2) + ' MAD)\n' +
      '🆔 ' + orderId + '\n' +
      '🚀 Sent to JAP: #' + jap.order
    );
    return { success: true, japOrderId: String(jap.order) };
  }
  await pool.query(`UPDATE orders SET method='card-youcanpay', pay_ref=$1, paid_at=NOW(), status='Pending Manual' WHERE id=$2`,
    [String(tx && tx.id ? tx.id : 'card'), orderId]);
  notifyTelegram('⚠️ Card paid but JAP order failed for ' + orderId + ': ' + JSON.stringify(jap).slice(0, 200));
  return { success: false, error: 'Payment received, delivery will be handled manually' };
}

app.post('/api/ycp/complete', async (req, res) => {
  try {
    const orderId = String(req.body.orderId || '');
    if (!orderId) return res.status(400).json({ success: false, error: 'Missing orderId' });
    const tx = await ycpVerifyPaid(orderId);
    if (!tx) return res.status(402).json({ success: false, error: 'Payment not confirmed yet' });
    const out = await ycpFulfill(orderId, tx);
    res.json(out);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ycp/webhook', async (req, res) => {
  try {
    const tx = (req.body && (req.body.data || req.body)) || {};
    const orderId = tx.order_id || (tx.metadata && tx.metadata.orderId);
    if (tx.status === 'paid' && orderId) { await ycpFulfill(String(orderId), tx); }
  } catch (err) { console.error('YCP webhook error: ' + err.message); }
  res.json({ received: true });
});

/* HEALTH */
app.get('/api/health', (req, res) => res.json({ ok: true, db: dbReady, time: new Date().toISOString() }));
/* AUTO-STATUS CHECK kola sa3a - Neon quota saving */
setInterval(async function() {
  try {
    const r = await pool.query(`SELECT * FROM orders WHERE jap_order_id IS NOT NULL AND status IN ('In Progress','Processing') AND created_at > NOW() - INTERVAL '7 days'`);
    for (const order of r.rows) {
      try {
        const s = await checkJAPStatus(order.jap_order_id);
        if (s.status === 'Completed') await pool.query(`UPDATE orders SET status='Completed', completed_at=NOW() WHERE id=$1`, [order.id]);
        if (s.status === 'Canceled') await pool.query(`UPDATE orders SET status='Canceled' WHERE id=$1`, [order.id]);
        if (s.status === 'Partial') await pool.query(`UPDATE orders SET status='Partial' WHERE id=$1`, [order.id]);
      } catch(e) {}
    }
  } catch(e) {}
}, 60 * 60 * 1000);  // kola sa3a (quota saving)

/* START — ila DB fail, server kaybqa khdam w kay3awd yjarreb (ma kaykhrjch) */
const PORT = process.env.PORT || 3000;
var dbReady = false;
function startServer() {
  if (startServer.done) return;
  startServer.done = true;
  app.listen(PORT, function() {
    console.log('=========================================');
    console.log('  SocialBoost Backend - RUNNING (port ' + PORT + ')');
    console.log('  DB ready: ' + dbReady);
    console.log('=========================================');
  });
}
function tryInitDB(attempt) {
  initDB().then(function() {
    dbReady = true;
    console.log('Database ready - attempt ' + attempt);
    startServer();
  }).catch(function(err) {
    console.error('DB init FAILED (attempt ' + attempt + '): ' + err.message);
    startServer(); // site ybqa mftou7 7ta ila DB ma khdamach
    console.log('Retry DB init f 5 dqay9...');
    setTimeout(function() { tryInitDB(attempt + 1); }, 5 * 60 * 1000);
  });
}
tryInitDB(1);
