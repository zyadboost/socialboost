require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

let pool = null;

function initPool() {
  let cs = process.env.POSTGRES_URL_PRIVATE || process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL is not set!');
  cs = cs.trim();
  if (cs.indexOf('=') !== -1 && cs.indexOf('postgresql://') !== 0) {
    cs = cs.substring(cs.indexOf('postgresql://'));
  }
  console.log('DB: connecting to:', cs.replace(/:[^:@]+@/, ':****@'));
  pool = new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', (e) => console.error('PG pool error:', e.message));
}

async function initDB(retries) {
  retries = retries || 10;
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS services (jap_id INTEGER PRIMARY KEY, category TEXT, name TEXT, type TEXT, rate NUMERIC, min INTEGER, max INTEGER, my_price NUMERIC)');
      await pool.query(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, service_jap_id INTEGER, service_name TEXT, link TEXT,
        quantity INTEGER, amount NUMERIC, jap_rate NUMERIC, method TEXT, status TEXT,
        pay_ref TEXT, jap_order_id TEXT, jap_cost NUMERIC, date TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), paid_at TIMESTAMPTZ
      )`);
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS jap_cost NUMERIC');
      console.log('✅ Database tables ready');
      return;
    } catch (err) {
      console.error('DB init attempt ' + i + '/' + retries + ' failed:', err.message);
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

const JAP_URL = process.env.JAP_API_URL;
const JAP_KEY = process.env.JAP_API_KEY;

async function createJAPOrder(serviceJapId, link, quantity) {
  try {
    const res = await axios.post(JAP_URL, { key: JAP_KEY, action: 'add', service: serviceJapId, link: link, quantity: quantity });
    return { success: true, japOrderId: res.data.order };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function checkJAPStatus(japOrderId) {
  try {
    const res = await axios.post(JAP_URL, { key: JAP_KEY, action: 'status', order: japOrderId });
    return res.data;
  } catch (err) { return { error: err.message }; }
}

/* ================= 📱 TELEGRAM ================= */
async function sendTelegram(order) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) { console.log('Telegram: missing token/chatId'); return; }

    const confirmUrl = 'https://socialboost-store.com/api/admin/confirm/' + order.id + '?key=' + encodeURIComponent(process.env.ADMIN_PASSWORD || '');
    const me = order.method === 'usdt' ? '₿ USDT' : order.method === 'paypal' ? '🅿️ PayPal' :
      order.method === 'binance' ? '🅿️ Binance Pay' : order.method === 'skrill' ? '💳 Skrill' : '📧 PayPal Transfer';

    const msg = '🛒 *ORDER JDID!*\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📦 ' + (order.service_name || '') + '\n' +
      '🔗 ' + (order.link || '') + '\n' +
      '🔢 Qty: ' + order.quantity + '\n' +
      '💰 Total: *$' + order.amount + '*\n' +
      '💳 Paid: ' + me + '\n' +
      '🧾 Ref: ' + (order.pay_ref || '—') + '\n' +
      '🆔 ' + order.id + '\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '👉 ✅ CONFIRM DELIVERY: ' + confirmUrl;

    await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', {
      chat_id: chatId, text: msg, parse_mode: 'Markdown'
    });
    console.log('📱 Telegram sent:', order.id);
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

/* ================= 💰 PAYPAL ================= */
let ppToken = null, ppTokenExpiry = 0;

async function getPayPalAccessToken() {
  if (ppToken && Date.now() < ppTokenExpiry) return ppToken;
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET).toString('base64');
  const res = await axios.post('https://api-m.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    { headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' } });
  ppToken = res.data.access_token;
  ppTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return ppToken;
}

/* ================= 📦 IMPORT SERVICES ================= */
let importRunning = false;
let importCount = 0;

app.get('/api/import-services', async (req, res) => {
  if (importRunning) return res.json({ success: true, message: 'Import already running', imported: importCount });
  importRunning = true;
  importCount = 0;
  res.json({ success: true, message: 'Import started! Check /api/import-status in 3-5 minutes' });
  try {
    const response = await axios.post(JAP_URL, { key: JAP_KEY, action: 'services' });
    const services = response.data;
    await pool.query('DELETE FROM services');
    for (let i = 0; i < services.length; i += 100) {
      const batch = services.slice(i, i + 100);
      const values = [];
      const params = [];
      batch.forEach((s, j) => {
        const base = j * 8;
        values.push('($' + (base+1) + ',$' + (base+2) + ',$' + (base+3) + ',$' + (base+4) + ',$' + (base+5) + ',$' + (base+6) + ',$' + (base+7) + ',$' + (base+8) + ')');
        params.push(s.service, s.category, s.name, s.type, parseFloat(s.rate), parseInt(s.min), parseInt(s.max), (parseFloat(s.rate) * 3).toFixed(2));
      });
      await pool.query('INSERT INTO services (jap_id, category, name, type, rate, min, max, my_price) VALUES ' + values.join(',') + ' ON CONFLICT (jap_id) DO NOTHING', params);
      importCount = Math.min(i + 100, services.length);
      console.log('Import: ' + importCount + '/' + services.length);
    }
    console.log('✅ Import DONE:', importCount);
  } catch (err) {
    console.error('Import error:', err.message);
  } finally {
    importRunning = false;
  }
});

app.get('/api/import-status', (req, res) => {
  res.json({ running: importRunning, imported: importCount });
});

/* ================= 🌐 SERVICES ================= */
app.get('/api/services', async (req, res) => {
  try {
    const r = await pool.query('SELECT jap_id, category, name, type, rate, min, max, my_price FROM services ORDER BY jap_id ASC');
    res.json(r.rows.map(s => ({
      japId: s.jap_id, category: s.category, name: s.name, type: s.type,
      rate: parseFloat(s.rate), min: s.min, max: s.max, myPrice: parseFloat(s.my_price)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 🛒 MARKETPLACE (server-side filters + pagination) ================= */
app.get('/api/marketplace', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(48, parseInt(req.query.per) || 48);
    const q = (req.query.q || '').trim();
    const platform = (req.query.platform || '').trim();
    const type = (req.query.type || '').trim();
    const minP = parseFloat(req.query.minPrice) || 0;
    const maxP = parseFloat(req.query.maxPrice) || 0;
    const refill = req.query.refill || '';
    const sort = req.query.sort || 'price_asc';

    const where = [];
    const params = [];
    let pi = 1;
    if (q) {
      where.push(`(LOWER(name) LIKE $${pi} OR LOWER(category) LIKE $${pi} OR jap_id::text = $${pi+1})`);
      params.push('%' + q.toLowerCase() + '%', q);
      pi += 2;
    }
    if (platform) {
      where.push(`(LOWER(category) LIKE $${pi})`);
      params.push(platform.split(' ')[0].toLowerCase() + '%');
      pi++;
    }
    if (type) {
      where.push(`(LOWER(name) LIKE $${pi})`);
      params.push('%' + type.toLowerCase() + '%');
      pi++;
    }
    if (minP > 0) { where.push(`my_price >= $${pi}`); params.push(minP); pi++; }
    if (maxP > 0) { where.push(`my_price <= $${pi}`); params.push(maxP); pi++; }
    if (refill === 'yes') where.push(`((name ILIKE '%refill:%' AND name NOT ILIKE '%refill: no%') OR name ILIKE '%guaranteed%')`);
    if (refill === 'no') where.push(`(name ILIKE '%refill: no%' OR name NOT ILIKE '%refill%')`);

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderSQL = { 'price_desc': 'ORDER BY my_price DESC', 'newest': 'ORDER BY jap_id DESC' }[sort] || 'ORDER BY my_price ASC';

    const total = await pool.query('SELECT COUNT(*) as c FROM services ' + whereSQL, params);
    const rows = await pool.query('SELECT * FROM services ' + whereSQL + ' ' + orderSQL + ' LIMIT ' + perPage + ' OFFSET ' + ((page-1)*perPage), params);

    res.json({
      success: true,
      services: rows.rows.map(s => ({
        japId: s.jap_id, category: s.category, name: s.name, type: s.type,
        rate: parseFloat(s.rate), min: s.min, max: s.max, myPrice: parseFloat(s.my_price)
      })),
      total: parseInt(total.rows[0].c),
      page: page,
      perPage: perPage,
      totalPages: Math.ceil(total.rows[0].c / perPage)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Best-sellers: real order stats */
app.get('/api/best-sellers', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT service_jap_id as jap_id, COUNT(*) as cnt
      FROM orders WHERE service_jap_id IS NOT NULL
      GROUP BY service_jap_id ORDER BY cnt DESC LIMIT 6
    `);
    res.json(r.rows);
  } catch (err) {
    res.json([]);
  }
});

/* Service detail */
app.get('/api/service/:japId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM services WHERE jap_id = $1', [req.params.japId]);
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
    const s = r.rows[0];
    res.json({ success: true, service: {
      japId: s.jap_id, category: s.category, name: s.name, type: s.type,
      rate: parseFloat(s.rate), min: s.min, max: s.max, myPrice: parseFloat(s.my_price)
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= 📦 ORDERS ================= */
app.post('/api/create-order', async (req, res) => {
  try {
    const { serviceJapId, link, quantity } = req.body;
    const sr = await pool.query('SELECT * FROM services WHERE jap_id = $1', [serviceJapId]);
    const svc = sr.rows[0];
    if (!svc) return res.status(404).json({ success: false, error: 'Service not found' });

    const amount = ((quantity / 1000) * parseFloat(svc.my_price)).toFixed(2);
    const orderId = 'ORD-' + Date.now();

    await pool.query(
      'INSERT INTO orders (id, service_jap_id, service_name, link, quantity, amount, jap_rate, method, status, date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [orderId, serviceJapId, svc.name, link, parseInt(quantity), amount, parseFloat(svc.rate), 'pending', 'Pending', new Date().toLocaleString()]
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
    const or = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = or.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    try {
      const token = await getPayPalAccessToken();
      const cap = await axios.get('https://api-m.paypal.com/v2/payments/captures/' + paymentRef,
        { headers: { 'Authorization': 'Bearer ' + token } });
      if (cap.data.status !== 'COMPLETED') {
        return res.status(400).json({ success: false, error: 'Payment not completed' });
      }
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Payment verification failed: ' + e.message });
    }

    const jap = await createJAPOrder(order.service_jap_id, order.link, order.quantity);
    let status = 'Pending Manual', japOrderId = null;
    if (jap.success) { japOrderId = jap.japOrderId; status = 'In Progress'; }

    await pool.query(
      'UPDATE orders SET method=$1, status=$2, pay_ref=$3, jap_order_id=$4, paid_at=NOW() WHERE id=$5',
      [method, status, paymentRef, japOrderId, orderId]
    );
    const updated = or.rows[0];
    updated.method = method; updated.status = status; updated.pay_ref = paymentRef;
    sendTelegram(updated);
    res.json({ success: true, order: { id: orderId, status: status, amount: order.amount } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/claim-payment', async (req, res) => {
  try {
        const confirmUrl = `${req.protocol}://${req.get('host')}/api/admin/confirm/${order.id}?key=${encodeURIComponent(adminKey2())}`;
    function adminKey2(){ return String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim(); }
    notifyTelegram('🔔 <b>ORDER JDID!</b>\n\n' + order.serviceName + '\n🔗 ' + order.link + '\nQty: ' + order.quantity + '\n💰 ' + money(order.amount) + '\nPaid: ' + order.method + '\nRef: ' + (order.payRef||'—') + '\nID: ' + order.id + '\n\n✅ <a href="' + confirmUrl + '">CONFIRM DELIVERY</a>');
    const orderId = req.body.orderId;
    const method = req.body.method;
    const paymentRef = req.body.paymentRef;
    await pool.query('UPDATE orders SET method=$1, status=$2, pay_ref=$3 WHERE id=$4',
      [method, 'Awaiting Verification', paymentRef || '', orderId]);
    const or = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (or.rows[0]) sendTelegram(or.rows[0]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* 👑 Admin: confirm manual payment → launch JAP */

    const confirmUrl = 'https://socialboost-store.com/api/admin/confirm/' + order.id + '?key=' + encodeURIComponent(process.env.ADMIN_PASSWORD || '');
    const me = order.method === 'usdt' ? '₿ USDT' : order.method === 'paypal' ? '🅿️ PayPal' :
      order.method === 'binance' ? '🅿️ Binance Pay' : order.method === 'skrill' ? '💳 Skrill' : '📧 PayPal Transfer';
 => {
  try {
    if (req.query.key !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, error: 'Wrong admin key' });
    }
    const orderId = req.params.orderId;
    const or = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = or.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    const jap = await createJAPOrder(order.service_jap_id, order.link, order.quantity);
    let status = 'Pending Manual', japOrderId = null;
    if (jap.success) { japOrderId = jap.japOrderId; status = 'In Progress'; }

    await pool.query(
      'UPDATE orders SET status=$1, jap_order_id=$2, paid_at=NOW() WHERE id=$3',
      [status, japOrderId, orderId]
    );
    res.json({ success: true, order: { id: orderId, status: status, japOrderId: japOrderId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* 🔧 Migration */
app.get('/api/admin/migrate', async (req, res) => {
  try {
    if (req.query.key !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, error: 'Wrong admin key' });
    }
    await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS jap_cost NUMERIC');
    res.json({ success: true, message: 'Migration done!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/orders', async (req, res) => {
  const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(r.rows);
});

app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: order.id, serviceName: order.service_name, quantity: order.quantity,
      amount: order.amount, method: order.method, status: order.status, date: order.date
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false, error: 'Wrong password' });
});

app.get('/api/admin/stats', async (req, res) => {
  const r = await pool.query("SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status IN ('In Progress','Completed') THEN amount ELSE 0 END),0) as revenue FROM orders");
  res.json({ totalOrders: parseInt(r.rows[0].total), revenue: parseFloat(r.rows[0].revenue) });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* 🔄 Auto-check JAP statuses kol 5 min */
setInterval(async () => {
  try {
    const r = await pool.query("SELECT id, jap_order_id FROM orders WHERE jap_order_id IS NOT NULL AND status = 'In Progress'");
    for (const order of r.rows) {
      const s = await checkJAPStatus(order.jap_order_id);
      if (s.status === 'Completed') {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['Completed', order.id]);
      } else if (s.status === 'Canceled') {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['Canceled', order.id]);
      }
    }
  } catch(e) { console.error('Auto-check:', e.message); }
}, 5 * 60 * 1000);
/* 📱 TELEGRAM NOTIFY — kayseft message melli kayji order claim */
async function notifyTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (e) { console.error('TG error:', e.message); }
}
const PORT = process.env.PORT || 3000;

async function start() {
  initPool();
  await initDB(10);
  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════');
    console.log('  🔥 SocialBoost + PostgreSQL + Telegram — RUNNING');
    console.log('  → Port ' + PORT);
    console.log('═══════════════════════════════════════════');
  });
}

start().catch(err => {
  console.error('❌ START FAILED:', err.message);
  process.exit(1);
});
