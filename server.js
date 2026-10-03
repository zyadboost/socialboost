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
      await pool.query('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, service_jap_id INTEGER, service_name TEXT, link TEXT, quantity INTEGER, amount NUMERIC, jap_rate NUMERIC, method TEXT, status TEXT, pay_ref TEXT, jap_order_id TEXT, jap_cost NUMERIC, date TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');
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

let importRunning = false;
let importCount = 0;
/* 💰 Smart pricing: higher margin on cheap services + minimum floor */
function calcMyPrice(rate) {
  const r = parseFloat(rate);
  let margin;
  if (r < 0.05) margin = 8;        // views (cheap) → 8x
  else if (r < 0.30) margin = 4;   // likes → 4x
  else if (r < 1.00) margin = 3;   // followers → 3x
  else margin = 2.5;               // expensive → 2.5x
  let p = r * margin;
  if (p < 0.15) p = 0.15;          // minimum $0.15 / 1000
  return p.toFixed(2);
}

app.get('/api/import-services', async (req, res) => {
  if (importRunning) {
    return res.json({ success: true, message: 'Import already running', imported: importCount });
  }
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
               /* 🧹 Clean name: hayyad les tags technique */
        let cleanName = (s.name || '')
          .replace(/&amp;/g, '&')
          .replace(/\s*\[(?:Read Description|READ DESCRIPTION|READ DESCRIPTION)\]/gi, '')
          .replace(/(?:\s*\[(?:Max:?\s*[0-9.]+\s*[KM]?)\])+/gi, '')
          .replace(/(?:\s*\[(?:Start Time:?\s*[^\]]*)\])+/gi, '')
          .replace(/(?:\s*\[(?:Speed:?\s*[^\]]*)\])+/gi, '')
          .replace(/(?:\s*\[(?:Refill:?\s*[^\]]*)\])+/gi, '')
          .replace(/\s*\[(?:SPAM\s*(?:ON|OFF)|FLAG\s*OFF|WORKING(?:\s*AFTER\s*UPDATE)?)\]/gi, '')
          .replace(/\s*(?:💧⛔️?|⛔💧|💧⛔|♻️💧⛔|♻️💧|💧|⛔️?|🔥)\s*/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();

        /* 🚫 Skip services khaybin (BOTS, PRANK, Not Guaranteed, etc) */
        const bad = /bots?\b|prank|not guaranteed|can fully drop|high drop|[\d]+\s*%\s*drop|drop\]|no refill.*no refund/i.test(s.name + ' ' + (s.category || ''));
        if (bad) return; /* skip — ma tzadch f site */

        /* 📦 Category m3a9la: Followers / Likes / Views / baqi */
        let cat = s.category || 'Instagram';
        if (/followers/i.test(cleanName)) cat = cat.replace(/[\w\s&+-]*$/,'').trim() + ' Followers';
        else if (/likes/i.test(cleanName)) cat = cat.replace(/[\w\s&+-]*$/,'').trim() + ' Likes';
        else if (/views/i.test(cleanName)) cat = cat.replace(/[\w\s&+-]*$/,'').trim() + ' Views';
        else if (/comments/i.test(cleanName)) cat = cat.replace(/[\w\s&+-]*$/,'').trim() + ' Comments';
        else if (/story/i.test(cleanName)) cat = cat.replace(/[\w\s&+-]*$/,'').trim() + ' Story';
        else if (/reels/i.test(cleanName)) cat = cat.replace(/[\w\s&+-]*$/,'').trim() + ' Reels';
        const cleanCat = cat.replace(/\s{2,}/g,' ').trim();
  
        const myPrice = calcMyPrice(s.rate);
        params.push(s.service, cleanCat, cleanName, s.type, parseFloat(s.rate), parseInt(s.min), parseInt(s.max), myPrice);      });
      await pool.query('INSERT INTO services (jap_id, category, name, type, rate, min, max, my_price) VALUES ' + values.join(',') + ' ON CONFLICT (jap_id) DO NOTHING', params);
      importCount = Math.min(i + 100, services.length);
      console.log('Import progress: ' + importCount + '/' + services.length);
    }
    console.log('✅ Import DONE: ' + importCount + ' services');
  } catch (err) {
    console.error('Import error:', err.message);
  } finally {
    importRunning = false;
  }
});

app.get('/api/import-status', (req, res) => {
  res.json({ running: importRunning, imported: importCount });
});

app.get('/api/services', async (req, res) => {
  try {
    const r = await pool.query('SELECT jap_id, category, name, type, rate, min, max, my_price FROM services ORDER BY jap_id ASC');
    const services = r.rows.map(function(s) {
      return {
        japId: s.jap_id, category: s.category, name: s.name,
        type: s.type, rate: parseFloat(s.rate), min: s.min, max: s.max,
        myPrice: parseFloat(s.my_price)
      };
    });
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-order', async (req, res) => {
  try {
    const serviceJapId = req.body.serviceJapId;
    const link = req.body.link;
    const quantity = req.body.quantity;
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
    let status = 'Pending Manual', japOrderId = null, japCost = null;
    if (jap.success) {
      japOrderId = jap.japOrderId;
      japCost = ((order.quantity / 1000) * parseFloat(order.jap_rate)).toFixed(2);
      status = 'In Progress';
    }

    await pool.query(
      'UPDATE orders SET method=$1, status=$2, pay_ref=$3, jap_order_id=$4, jap_cost=$5, paid_at=NOW() WHERE id=$6',
      [method, status, paymentRef, japOrderId, japCost, orderId]
    );
    res.json({ success: true, order: { id: orderId, status: status, amount: order.amount } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/claim-payment', async (req, res) => {
  try {
    const orderId = req.body.orderId;
    const method = req.body.method;
    const paymentRef = req.body.paymentRef;
    await pool.query('UPDATE orders SET method=$1, status=$2, pay_ref=$3 WHERE id=$4',
      [method, 'Awaiting Verification', paymentRef || '', orderId]);
    res.json({ success: true });
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

const PORT = process.env.PORT || 3000;

async function start() {
  initPool();
  await initDB(10);
  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════');
    console.log('  🔥 SocialBoost + PostgreSQL — RUNNING');
    console.log('  → Port ' + PORT);
    console.log('═══════════════════════════════════════════');
  });
}

start().catch(err => {
  console.error('❌ START FAILED:', err.message);
  process.exit(1);
});
