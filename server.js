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
  ssl: { rejectUnauthorized: false }
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
  console.log('Database ready');
}

function money(n) { return '$' + Number(n).toFixed(2); }

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
    const japServices = await importJAPServices();
    const margin = 2.2;
    let count = 0;
    for (const s of japServices) {
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
      count++;
    }
    res.json({ success: true, count: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM services ORDER BY jap_id');
    res.json(r.rows.map(function(s) {
      return {
        japId: s.jap_id, category: s.category, name: s.name, type: s.type,
        rate: parseFloat(s.rate), min: s.min_qty, max: s.max_qty, myPrice: parseFloat(s.my_price)
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update-price', async (req, res) => {
  const japId = req.body.japId;
  const newPrice = parseFloat(req.body.newPrice);
  await pool.query('UPDATE services SET my_price=$1 WHERE jap_id=$2', [newPrice, String(japId)]);
  res.json({ success: true });
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

    const amount = ((quantity / 1000) * parseFloat(svc.my_price)).toFixed(2);
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

    const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
    const host = req.protocol + '://' + req.get('host');
    const confirmUrl = host + '/api/admin/confirm/' + orderId + '?key=' + encodeURIComponent(adminKey);

    const msg = '<b>ORDER JDID</b>\n\n' +
      order.service_name + '\n' +
      'Link: ' + order.link + '\n' +
      'Qty: ' + order.quantity + '\n' +
      'Total: ' + money(order.amount) + '\n' +
      'Paid: ' + method + '\n' +
      'Ref: ' + paymentRef + '\n' +
      'ID: ' + orderId + '\n\n' +
      'CONFIRM: ' + confirmUrl;

    notifyTelegram(msg);
    res.json({ success: true, orderId: orderId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ADMIN CONFIRM */
app.get('/api/admin/confirm/:orderId', async (req, res) => {
  try {
    const key = decodeURIComponent(req.query.key || '').trim();
    const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
    if (key !== adminKey) {
      return res.status(403).json({ success: false, error: 'Wrong admin key', received: key });
    }
    const r = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.jap_order_id) return res.json({ success: true, message: 'Already sent', japOrderId: order.jap_order_id });

    const jap = await createJAPOrder(order.service_jap_id, order.link, order.quantity);
    if (jap && jap.order) {
      const japCost = ((order.quantity / 1000) * parseFloat(order.jap_rate || 0)).toFixed(2);
      await pool.query(
        `UPDATE orders SET jap_order_id=$1, jap_cost=$2, status='In Progress', completed_at=NULL WHERE id=$3`,
        [String(jap.order), japCost, orderIdSafe(req.params.orderId)]
      );
      notifyTelegram('CONFIRMED ' + req.params.orderId + ' -> JAP order #' + jap.order);
      res.json({ success: true, message: 'Order sent to JAP!', japOrderId: jap.order });
    } else {
      await pool.query(`UPDATE orders SET status='Confirm Failed' WHERE id=$1`, [req.params.orderId]);
      res.status(500).json({ success: false, error: 'JAP error: ' + JSON.stringify(jap) });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function orderIdSafe(id) { return String(id); }

/* ADMIN REJECT */
app.get('/api/admin/reject/:orderId', async (req, res) => {
  const key = decodeURIComponent(req.query.key || '').trim();
  const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
  if (key !== adminKey) return res.status(403).json({ success: false, error: 'Wrong key' });
  await pool.query(`UPDATE orders SET status='Rejected' WHERE id=$1`, [req.params.orderId]);
  res.json({ success: true, message: 'Order rejected' });
});

/* ORDERS LECTURE */
app.get('/api/orders', async (req, res) => {
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
  const r = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.orderId]);
  const order = r.rows[0];
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.jap_order_id) {
    try {
      const s = await checkJAPStatus(order.jap_order_id);
      if (s.status) {
        let newStatus = order.status;
        if (s.status === 'Completed') newStatus = 'Completed';
        if (s.status === 'Canceled') newStatus = 'Canceled';
        if (s.status === 'Partial') newStatus = 'Partial';
        if (newStatus !== order.status) {
          await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [newStatus, req.params.orderId]);
          order.status = newStatus;
        }
        order.japStatus = s.status;
      }
    } catch(e) {}
  }
  res.json({
    id: order.id, serviceName: order.service_name, link: order.link,
    quantity: order.quantity, amount: parseFloat(order.amount),
    method: order.method, status: order.status
  });
});

app.get('/api/claims', async (req, res) => {
  const r = await pool.query(`SELECT * FROM orders WHERE status='Pending' ORDER BY created_at DESC`);
  res.json(r.rows);
});

/* ADMIN */
app.post('/api/admin/login', (req, res) => {
  const pass = String(req.body.password || '').trim();
  const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
  if (pass === adminKey) res.json({ success: true });
  else res.status(401).json({ success: false, error: 'Wrong password' });
});

app.get('/api/admin/stats', async (req, res) => {
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
  try {
    const b = await getJAPBalance();
    res.json({ success: true, balance: b.balance, currency: b.currency });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
app.get('/api/best-sellers', async (req, res) => {
  const r = await pool.query(
    `SELECT service_jap_id as jap_id, COUNT(*) as count
     FROM orders WHERE service_jap_id IS NOT NULL
     GROUP BY service_jap_id ORDER BY count DESC LIMIT 12`
  );
  res.json(r.rows);
});
/* RESET DB — ms7 tables l qdam o 3awd sna3hom (gha merra we7da!) */
app.get('/api/reset-db', async (req, res) => {
  try {
    await pool.query('DROP TABLE IF EXISTS services CASCADE');
    await pool.query('DROP TABLE IF EXISTS orders CASCADE');
    await pool.query(`
      CREATE TABLE services (
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
      CREATE TABLE orders (
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
    res.json({ success: true, message: 'Database reset OK — daba dir /api/import-services' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* AUTO-CHECK every 5 min */
setInterval(async function() {
  try {
    const r = await pool.query(`SELECT * FROM orders WHERE jap_order_id IS NOT NULL AND status IN ('In Progress','Processing')`);
    for (const order of r.rows) {
      try {
        const s = await checkJAPStatus(order.jap_order_id);
        if (s.status === 'Completed') await pool.query(`UPDATE orders SET status='Completed', completed_at=NOW() WHERE id=$1`, [order.id]);
        if (s.status === 'Canceled') await pool.query(`UPDATE orders SET status='Canceled' WHERE id=$1`, [order.id]);
        if (s.status === 'Partial') await pool.query(`UPDATE orders SET status='Partial' WHERE id=$1`, [order.id]);
      } catch(e) {}
    }
  } catch(e) {}
}, 5 * 60 * 1000);

/* START */
const PORT = process.env.PORT || 3000;
initDB().then(function() {
  app.listen(PORT, function() {
    console.log('=========================================');
    console.log('  SocialBoost Backend - RUNNING');
    console.log('  Database: PostgreSQL (Neon) - DAIMA');
    console.log('  Port: ' + PORT);
    console.log('=========================================');
  });
}).catch(function(err) {
  console.error('DB init FAILED: ' + err.message);
  process.exit(1);
});
