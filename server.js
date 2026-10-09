require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return { orders: [], services: [], clients: [], settings: { margin: 3.0 } }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function money(n) { return '$' + Number(n).toFixed(2); }

/* TELEGRAM NOTIFY */
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
    if (cap.status === 'COMPLETED') {
      return { success: true, amount: parseFloat(cap.amount.value) };
    }
    return { success: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function cryptomusSign(body) {
  return crypto.createHmac('sha512', process.env.CRYPTOMUS_PAY_KEY || '')
    .update(JSON.stringify(body)).digest('hex');
}

/* SERVICES */
app.get('/api/import-services', async (req, res) => {
  try {
    const japServices = await importJAPServices();
    const db = loadDB();
    const margin = (db.settings && db.settings.margin) || 3.0;
    db.services = japServices.map(function(s) {
      return {
        japId: s.service,
        category: s.category,
        name: s.name,
        type: s.type,
        rate: parseFloat(s.rate),
        min: parseInt(s.min),
        max: parseInt(s.max),
        myPrice: (parseFloat(s.rate) * margin).toFixed(2)
      };
    });
    saveDB(db);
    res.json({ success: true, count: db.services.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/services', (req, res) => {
  const db = loadDB();
  res.json(db.services);
});

app.post('/api/update-margin', (req, res) => {
  const margin = parseFloat(req.body.margin);
  const db = loadDB();
  db.settings.margin = margin;
  db.services = db.services.map(function(s) {
    const copy = Object.assign({}, s);
    copy.myPrice = (s.rate * margin).toFixed(2);
    return copy;
  });
  saveDB(db);
  res.json({ success: true, count: db.services.length });
});

app.post('/api/update-price', (req, res) => {
  const japId = req.body.japId;
  const newPrice = parseFloat(req.body.newPrice);
  const db = loadDB();
  const svc = db.services.find(function(s) { return s.japId == japId; });
  if (!svc) return res.status(404).json({ success: false });
  svc.myPrice = newPrice;
  saveDB(db);
  res.json({ success: true });
});

/* ORDERS */
app.post('/api/create-order', async (req, res) => {
  try {
    const serviceJapId = req.body.serviceJapId;
    const link = req.body.link;
    const quantity = parseInt(req.body.quantity);
    const db = loadDB();
    const svc = db.services.find(function(s) { return s.japId == serviceJapId; });
    if (!svc) return res.status(404).json({ success: false, error: 'Service not found' });

    const amount = ((quantity / 1000) * svc.myPrice).toFixed(2);
    const orderId = 'ORD-' + Date.now();

    const order = {
      id: orderId,
      serviceJapId: serviceJapId,
      serviceName: svc.name,
      link: link,
      quantity: quantity,
      amount: parseFloat(amount),
      japRate: svc.rate,
      method: 'pending',
      status: 'Pending',
      createdAt: new Date().toISOString()
    };
    db.orders.push(order);
    saveDB(db);
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
    const db = loadDB();
    const order = db.orders.find(function(o) { return o.id === orderId; });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    let paid = false;
    if (method === 'paypal') {
      const v = await verifyPayPalCapture(paymentRef);
      if (v.success && v.amount >= order.amount) paid = true;
    }
    if (!paid) return res.status(400).json({ success: false, error: 'Payment verification failed' });

    order.method = 'paypal';
    order.payRef = paymentRef;
    order.paidAt = new Date().toISOString();

    const jap = await createJAPOrder(order.serviceJapId, order.link, order.quantity);
    if (jap && jap.order) {
      order.japOrderId = jap.order;
      order.japCost = ((order.quantity / 1000) * (order.japRate || 0)).toFixed(2);
      order.status = 'In Progress';
    } else {
      order.status = 'Pending Manual';
      order.japError = JSON.stringify(jap);
    }
    saveDB(db);
    res.json({ success: true, order: order });
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
    const db = loadDB();
    const order = db.orders.find(function(o) { return o.id === orderId; });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found: ' + orderId });

    order.method = method;
    order.payRef = paymentRef;
    order.status = 'Pending';
    order.claimedAt = new Date().toISOString();
    saveDB(db);

    const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
    const host = req.protocol + '://' + req.get('host');
    const confirmUrl = host + '/api/admin/confirm/' + order.id + '?key=' + encodeURIComponent(adminKey);

    const msg = '<b>ORDER JDID</b>\n\n' +
      order.serviceName + '\n' +
      'Link: ' + order.link + '\n' +
      'Qty: ' + order.quantity + '\n' +
      'Total: ' + money(order.amount) + '\n' +
      'Paid: ' + order.method + '\n' +
      'Ref: ' + (order.payRef || '-') + '\n' +
      'ID: ' + order.id + '\n\n' +
      'CONFIRM: ' + confirmUrl;

    notifyTelegram(msg);
    res.json({ success: true, orderId: order.id });
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
    const db = loadDB();
    const order = db.orders.find(function(o) { return o.id === req.params.orderId; });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.japOrderId) return res.json({ success: true, message: 'Already sent', japOrderId: order.japOrderId });

    const jap = await createJAPOrder(order.serviceJapId, order.link, order.quantity);
    if (jap && jap.order) {
      order.japOrderId = jap.order;
      order.japCost = ((order.quantity / 1000) * (order.japRate || 0)).toFixed(2);
      order.status = 'In Progress';
      order.confirmedAt = new Date().toISOString();
      saveDB(db);
      notifyTelegram('CONFIRMED ' + order.id + ' -> JAP order #' + jap.order);
      res.json({ success: true, message: 'Order sent to JAP!', japOrderId: jap.order });
    } else {
      order.status = 'Confirm Failed';
      order.japError = JSON.stringify(jap);
      saveDB(db);
      res.status(500).json({ success: false, error: 'JAP error: ' + JSON.stringify(jap) });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ADMIN REJECT */
app.get('/api/admin/reject/:orderId', (req, res) => {
  const key = decodeURIComponent(req.query.key || '').trim();
  const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
  if (key !== adminKey) return res.status(403).json({ success: false, error: 'Wrong key' });
  const db = loadDB();
  const order = db.orders.find(function(o) { return o.id === req.params.orderId; });
  if (!order) return res.status(404).json({ success: false, error: 'Not found' });
  order.status = 'Rejected';
  saveDB(db);
  res.json({ success: true, message: 'Order rejected' });
});

/* ORDERS */
app.get('/api/orders', (req, res) => {
  const db = loadDB();
  const sorted = db.orders.slice().sort(function(a, b) {
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  res.json(sorted);
});

app.get('/api/order-status/:orderId', async (req, res) => {
  const db = loadDB();
  const order = db.orders.find(function(o) { return o.id === req.params.orderId; });
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.japOrderId) {
    try {
      const status = await checkJAPStatus(order.japOrderId);
      if (status.status) {
        order.japStatus = status.status;
        if (status.status === 'Completed') order.status = 'Completed';
        if (status.status === 'Canceled') order.status = 'Canceled';
        if (status.status === 'Partial') order.status = 'Partial';
        saveDB(db);
      }
    } catch(e) {}
  }
  res.json(order);
});

app.get('/api/claims', (req, res) => {
  const db = loadDB();
  const pending = db.orders.filter(function(o) { return o.status === 'Pending'; });
  res.json(pending);
});

/* ADMIN */
app.post('/api/admin/login', (req, res) => {
  const pass = String(req.body.password || '').trim();
  const adminKey = String(process.env.ADMIN_PASSWORD || 'Zyad@2025!').trim();
  if (pass === adminKey) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

app.get('/api/admin/stats', (req, res) => {
  const db = loadDB();
  const completed = db.orders.filter(function(o) { return o.status === 'Completed'; });
  const totalRevenue = completed.reduce(function(a, o) { return a + (o.amount || 0); }, 0);
  const totalCost = completed.reduce(function(a, o) { return a + (o.japCost || 0); }, 0);
  res.json({
    totalOrders: db.orders.length,
    completed: completed.length,
    inProgress: db.orders.filter(function(o) { return o.status === 'In Progress'; }).length,
    pending: db.orders.filter(function(o) { return o.status === 'Pending'; }).length,
    totalRevenue: totalRevenue.toFixed(2),
    totalCost: totalCost.toFixed(2),
    totalProfit: (totalRevenue - totalCost).toFixed(2),
    services: db.services.length
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

/* CRYPTOMUS */
app.post('/api/usdt/create-invoice', async (req, res) => {
  try {
    const amount = req.body.amount;
    const orderId = req.body.orderId;
    const body = {
      amount: Number(amount).toFixed(2),
      currency: 'USDT',
      order_id: orderId,
      url_callback: req.protocol + '://' + req.get('host') + '/api/usdt/webhook'
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
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/usdt/webhook', async (req, res) => {
  try {
    const data = req.body;
    if (data.status === 'paid' || data.status === 'paid_over') {
      const db = loadDB();
      const order = db.orders.find(function(o) { return o.id === data.order_id; });
      if (order && order.status === 'Pending') {
        order.status = 'In Progress';
        order.paidAt = new Date().toISOString();
        const jap = await createJAPOrder(order.serviceJapId, order.link, order.quantity);
        if (jap && jap.order) {
          order.japOrderId = jap.order;
          order.japCost = ((order.quantity / 1000) * (order.japRate || 0)).toFixed(2);
        }
        saveDB(db);
        notifyTelegram('USDT AUTO-PAID ' + order.id);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* BEST SELLERS */
app.get('/api/best-sellers', (req, res) => {
  const db = loadDB();
  const counts = {};
  db.orders.forEach(function(o) {
    if (o.serviceJapId) counts[o.serviceJapId] = (counts[o.serviceJapId] || 0) + 1;
  });
  const list = Object.keys(counts).map(function(japId) {
    return { jap_id: japId, count: counts[japId] };
  }).sort(function(a, b) { return b.count - a.count; });
  res.json(list);
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* AUTO-CHECK every 5 min */
setInterval(async function() {
  try {
    const db = loadDB();
    let updated = 0;
    for (const order of db.orders) {
      if (order.japOrderId && order.status !== 'Completed' && order.status !== 'Canceled') {
        try {
          const s = await checkJAPStatus(order.japOrderId);
          if (s.status === 'Completed') { order.status = 'Completed'; updated++; }
          if (s.status === 'Canceled') { order.status = 'Canceled'; updated++; }
          if (s.status === 'Partial') { order.status = 'Partial'; updated++; }
        } catch(e) {}
      }
    }
    if (updated > 0) saveDB(db);
  } catch(e) {}
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('=========================================');
  console.log('  SocialBoost Backend - RUNNING');
  console.log('  Port: ' + PORT);
  console.log('=========================================');
});
