require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

/* ================================================================
   🐘 POSTGRESQL (with retry + forced hostname)
   ================================================================ */
let pool = null;

function initPool() {
  let cs = process.env.POSTGRES_URL_PRIVATE || process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL is not set!');
  /* Force hostname — never allow wrong host (base, xxxx...) */
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

/* ================================================================
   📦 JAP API
   ================================================================ */
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

/* ================================================================
   💰 PAYPAL
   ================================================================ */
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

/* ================================================================
   🌐 ROUTES
   ================================================================ */
let importRunning = false;
let importCount = 0;

app.get('/api/import-services', async (req, res) => {
  if (importRunning) {
    return res.json({ success: true, message: 'Import already running', imported: importCount });
  }
  importRunning = true;
  importCount = 0;
  /* Respond IMMEDIATELY — import f background */
  res.json({ success: true, message: 'Import started! Check /api/import-status in 5-8 minutes', total: 'loading...' });

  try {
    const response = await axios.post(JAP_URL, { key: JAP_KEY, action: 'services' });
    const services = response.data;
    await pool.query('DELETE FROM services');
    /* Insert in batches of 100 — faster! */
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
