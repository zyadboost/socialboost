require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

/* ================================================================
   💾 DATABASE (JSON file — simple, khadma mzyan)
   ================================================================ */
const DB_FILE = path.join(__dirname, 'data.json');
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return { orders: [], services: [], clients: [], settings: { margin: 3.0 } }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

/* ================================================================
   📊 STATS HELPERS
   ================================================================ */
function getStats() {
  const db = loadDB();
  const completed = db.orders.filter(o => o.status === 'Completed');
  const totalRevenue = completed.reduce((a,o) => a + (o.amount || 0), 0);
  const totalCost = completed.reduce((a,o) => a + (o.japCost || 0), 0);
  return {
    totalOrders: db.orders.length,
    completed: completed.length,
    inProgress: db.orders.filter(o => o.status === 'In Progress').length,
    pending: db.orders.filter(o => o.status === 'Pending').length,
    totalRevenue: totalRevenue.toFixed(2),
    totalCost: totalCost.toFixed(2),
    totalProfit: (totalRevenue - totalCost).toFixed(2),
    clients: db.clients.length,
    services: db.services.length
  };
}

/* ================================================================
   📦 JAP API INTEGRATION
   ================================================================ */
const JAP_URL = process.env.JAP_API_URL;
const JAP_KEY = process.env.JAP_API_KEY;

/* Import kol services mn JAP (f 1 click) */
async function importJAPServices() {
  const res = await axios.post(JAP_URL, { key: JAP_KEY, action: 'services' });
  return res.data;
}

/* Create order f JAP */
async function createJAPOrder(serviceJapId, link, quantity) {
  const res = await axios.post(JAP_URL, {
    key: JAP_KEY,
    action: 'add',
    service: serviceJapId,
    link: link,
    quantity: quantity
  });
  return res.data;
}

/* Check status dyal order f JAP */
async function checkJAPStatus(japOrderId) {
  const res = await axios.post(JAP_URL, {
    key: JAP_KEY,
    action: 'status',
    order: japOrderId
  });
  return res.data;
}

/* Balance dyalek f JAP */
async function getJAPBalance() {
  const res = await axios.post(JAP_URL, {
    key: JAP_KEY,
    action: 'balance'
  });
  return res.data;
}

/* ================================================================
   💰 PAYPAL SERVER-SIDE (SECURE!)
   ================================================================ */
let paypalToken = null, paypalTokenExpiry = 0;

async function getPayPalAccessToken() {
  if (paypalToken && Date.now() < paypalTokenExpiry) return paypalToken;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post('https://api-m.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  paypalToken = res.data.access_token;
  paypalTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return paypalToken;
}

/* Create PayPal order */
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { amount, description } = req.body;
    const token = await getPayPalAccessToken();
    const r = await axios.post('https://api-m.paypal.com/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: Number(amount).toFixed(2) },
        description: String(description || 'SocialBoost order').slice(0, 127)
      }]
    }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
    res.json({ success: true, orderId: r.data.id });
  } catch (err) {
    console.error('PayPal create error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Capture + verify PayPal payment */
app.post('/api/paypal/capture', async (req, res) => {
  try {
    const { orderId } = req.body;
    const token = await getPayPalAccessToken();
    const r = await axios.post(`https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`,
      {}, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
    const order = r.data;
    if (order.status === 'COMPLETED') {
      const amount = parseFloat(order.purchase_units[0].payments.captures[0].amount.value);
      res.json({ success: true, amount, captureId: order.purchase_units[0].payments.captures[0].id });
    } else {
      res.json({ success: false, error: 'Payment not completed' });
    }
  } catch (err) {
    console.error('PayPal capture error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================================================================
   🪙 CRYPTOMUS (USDT) — Automatic invoice + webhook
   ================================================================ */
function cryptomusSign(body) {
  return crypto.createHmac('sha512', process.env.CRYPTOMUS_PAY_KEY)
    .update(JSON.stringify(body)).digest('hex');
}

/* Create USDT invoice */
app.post('/api/usdt/create-invoice', async (req, res) => {
  try {
    const { amount, orderId } = req.body;
    const body = {
      amount: Number(amount).toFixed(2),
      currency: 'USDT',
      order_id: orderId,
      url_callback: `${req.protocol}://${req.get('host')}/api/usdt/webhook`
    };
    const r = await axios.post('https://api.cryptomus.com/v1/payment', body, {
      headers: {
        'merchant': process.env.CRYPTOMUS_MERCHANT,
        'sign': cryptomusSign(body),
        'Content-Type': 'application/json'
      }
    });
    res.json({ success: true, invoiceUrl: r.data.result.url, invoiceId: r.data.result.uuid });
  } catch (err) {
    console.error('Cryptomus error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* USDT Webhook — Cryptomus kay3ayet lina mnin client ykhles */
app.post('/api/usdt/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('USDT Webhook:', data);
    if (data.status === 'paid' || data.status === 'paid_over') {
      const db = loadDB();
      const order = db.orders.find(o => o.id === data.order_id);
      if (order && order.status === 'Pending') {
        order.status = 'In Progress';
        order.paidAt = new Date().toISOString();
        /* Launch order f JAP automatiquement! */
        const jap = await createJAPOrder(order.serviceJapId, order.link, order.quantity);
        if (jap.order) {
          order.japOrderId = jap.order;
          order.japCost = (order.quantity / 1000) * (order.japRate || 0);
        }
        saveDB(db);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   🌐 API ROUTES L SITE
   ================================================================ */

/* ---------- SERVICES ---------- */

/* ---------- MANUAL PAYMENT CLAIMS (Binance/USDT/Transfer) ---------- */
app.post('/api/claim-payment', (req, res) => {
  try {
    const { orderId, method, paymentRef } = req.body;
    const db = loadDB();
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    order.method = method;
    order.payRef = paymentRef || '';
    order.status = 'Awaiting Verification';
    saveDB(db);
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Import services mn JAP (1 click f Admin!) */
app.get('/api/import-services', async (req, res) => {
  try {
    const japServices = await importJAPServices();
    const db = loadDB();
    const margin = db.settings.margin || 3.0;
    db.services = japServices.map(s => ({
      japId: s.service,
      category: s.category,
      name: s.name,
      type: s.type,
      rate: parseFloat(s.rate),
      min: parseInt(s.min),
      max: parseInt(s.max),
      myPrice: (parseFloat(s.rate) * margin).toFixed(2)
    }));
    saveDB(db);
    res.json({ success: true, count: db.services.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Get services (l site) */
app.get('/api/services', (req, res) => {
  const db = loadDB();
  res.json(db.services);
});

/* Update margin (kol prices kaytbdlo automatiquement) */
app.post('/api/update-margin', (req, res) => {
  const { margin } = req.body;
  const db = loadDB();
  db.settings.margin = parseFloat(margin);
  db.services = db.services.map(s => ({
    ...s,
    myPrice: (s.rate * margin).toFixed(2)
  }));
  saveDB(db);
  res.json({ success: true, count: db.services.length });
});

/* Update price dyal service wa7ed */
app.post('/api/update-price', (req, res) => {
  const { japId, newPrice } = req.body;
  const db = loadDB();
  const svc = db.services.find(s => s.japId == japId);
  if (!svc) return res.status(404).json({ success: false });
  svc.myPrice = parseFloat(newPrice);
  saveDB(db);
  res.json({ success: true });
});

/* ---------- ORDERS ---------- */

/* Create order — PAYMENT FIRST, THEN JAP AUTOMATIC */
app.post('/api/create-order', async (req, res) => {
  try {
    const { serviceJapId, link, quantity } = req.body;
    const db = loadDB();
    const svc = db.services.find(s => s.japId == serviceJapId);
    if (!svc) return res.status(404).json({ success: false, error: 'Service not found' });

    const amount = ((quantity / 1000) * svc.myPrice).toFixed(2);
    const orderId = 'ORD-' + Date.now();

    const order = {
      id: orderId,
      serviceJapId,
      serviceName: svc.name,
      link, quantity: parseInt(quantity),
      amount: parseFloat(amount),
      japRate: svc.rate,
      method: 'pending',
      status: 'Pending',
      createdAt: new Date().toISOString()
    };
    db.orders.push(order);
    saveDB(db);

    res.json({ success: true, orderId, amount: parseFloat(amount) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Client ykhles — PayPal capture → order ymchi l JAP automatiquement */
app.post('/api/pay-order', async (req, res) => {
  try {
    const { orderId, method, paymentRef } = req.body;
    const db = loadDB();
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    let paid = false;

    /* PayPal: verify capture server-side */
    if (method === 'paypal') {
      const v = await verifyPayPalCapture(paymentRef);
      if (v.success && v.amount >= order.amount) paid = true;
    }

    if (!paid) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    /* ✅ PAID — Launch f JAP automatiquement! */
    order.method = 'paypal';
    order.payRef = paymentRef;
    order.paidAt = new Date().toISOString();

    const jap = await createJAPOrder(order.serviceJapId, order.link, order.quantity);
    if (jap.order) {
      order.japOrderId = jap.order;
      order.japCost = ((order.quantity / 1000) * order.japRate).toFixed(2);
      order.status = 'In Progress';
    } else {
      order.status = 'Pending Manual';
      order.japError = JSON.stringify(jap);
    }
    saveDB(db);

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function verifyPayPalCapture(captureId) {
  try {
    const token = await getPayPalAccessToken();
    const r = await axios.get(`https://api-m.paypal.com/v2/payments/captures/${captureId}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    const cap = r.data;
    if (cap.status === 'COMPLETED') {
      return { success: true, amount: parseFloat(cap.amount.value) };
    }
    return { success: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* Get orders (admin) */
app.get('/api/orders', (req, res) => {
  const db = loadDB();
  res.json(db.orders.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

/* Check order status mn JAP (automatic every 5 min) */
app.get('/api/order-status/:orderId', async (req, res) => {
  const db = loadDB();
  const order = db.orders.find(o => o.id === req.params.orderId);
  if (!order || !order.japOrderId) return res.status(404).json({ error: 'Not found' });
  const status = await checkJAPStatus(order.japOrderId);
  if (status.status) {
    order.japStatus = status.status;
    if (status.status === 'Completed') order.status = 'Completed';
    if (status.status === 'Canceled') order.status = 'Canceled';
    saveDB(db);
  }
  res.json(order);
});

/* ---------- ADMIN ---------- */

/* Admin login */
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

/* Admin stats */
app.get('/api/admin/stats', (req, res) => {
  res.json(getStats());
});

/* JAP balance */
app.get('/api/admin/jap-balance', async (req, res) => {
  try {
    const b = await getJAPBalance();
    res.json({ success: true, balance: b.balance, currency: b.currency });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* Health */
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ================================================================
   🔄 AUTO-CHECK: kol 5 minutes check JAP status
   ================================================================ */
setInterval(async () => {
  try {
    const db = loadDB();
    let updated = 0;
    for (const order of db.orders) {
      if (order.japOrderId && ['In Progress', 'Processing'].includes(order.status)) {
        try {
          const s = await checkJAPStatus(order.japOrderId);
          if (s.status === 'Completed') { order.status = 'Completed'; order.completedAt = new Date().toISOString(); updated++; }
          if (s.status === 'Canceled') { order.status = 'Canceled'; updated++; }
        } catch(e) { /* skip */ }
      }
    }
    if (updated > 0) saveDB(db);
  } catch(e) { console.error('Auto-check error:', e.message); }
}, 5 * 60 * 1000);

/* ================================================================
   🚀 START
   ================================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════');
  console.log('  🔥 SocialBoost Backend — RUNNING');
  console.log(`  → http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════');
});