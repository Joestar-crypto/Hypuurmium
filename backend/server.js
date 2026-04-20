/**
 * Hypurrmium Auto-Buy — Backend Server
 *
 * Express API + P/E surveillance worker (every 60s).
 * Uses sql.js (pure JS SQLite) for storage, viem for Hyperliquid signing.
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const initSqlJs = require('sql.js');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const {
  getCurrentPE,
  getMedianPE,
  placeMarketBuy,
  placeMarketSell,
  placeLimitBuy,
  placeLimitSell,
  getUserBalance,
  getAgentAccount,
  getBuilderAddress,
  getBuilderApprovalMaxFeeRate,
} = require('./hyperliquid');
const { alertBuy, alertSell, orderBuy, orderSell } = require('./email-templates');

// ── Config ──

const PORT         = process.env.PORT || 3001;
const HOST         = process.env.HOST || '0.0.0.0';
const DB_PATH      = process.env.DB_PATH || path.join(__dirname, 'autobuy.db');
const SITE_ROOT    = path.resolve(__dirname, '..');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = process.env.EMAIL_FROM || 'Hypurrmium <noreply@hypurrmium.xyz>';
const ADMIN_KEY      = process.env.ADMIN_KEY || '';
const DISABLE_WORKER = /^(1|true|yes)$/i.test(process.env.DISABLE_WORKER || '');
const ALLOW_NULL_ORIGIN = /^(1|true|yes)$/i.test(process.env.ALLOW_NULL_ORIGIN || '');
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://hypurrmium.xyz,https://www.hypurrmium.xyz,http://localhost:3000,http://localhost:8080')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HYPERLIQUID_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const DEFILLAMA_FEES_URL = 'https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyRevenue';
const DEFILLAMA_PROTOCOL_URL = 'https://api.llama.fi/protocol/hyperliquid';

// ── Database (sql.js) ──

let db; // initialized in main()

function ensureDbDirectory() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

/** Save database to disk */
function saveDb() {
  ensureDbDirectory();
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/** Run a query and return all rows as objects */
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** Run a query and return first row as object, or null */
function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Execute a statement (INSERT/UPDATE/DELETE) with params, auto-save */
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

const USDC_COMPARISON_EPSILON = 1e-6;

function getNominalBudgetDelta(strategy) {
  return Math.max(0, Number(strategy?.amount_usdc) || 0);
}

function hasNominalBudgetForNextOrder(strategy) {
  const budgetUsed = Number(strategy?.budget_used) || 0;
  const totalBudget = Number(strategy?.total_budget) || 0;
  return budgetUsed + getNominalBudgetDelta(strategy) <= totalBudget + USDC_COMPARISON_EPSILON;
}

async function getCachedUserUsdcBalance(address, balanceCache = null) {
  const normalizedAddress = String(address || '').toLowerCase();
  if (!normalizedAddress) return 0;
  if (balanceCache && balanceCache.has(normalizedAddress)) {
    return balanceCache.get(normalizedAddress);
  }

  const usdc = await getUserBalance(normalizedAddress);
  if (balanceCache) balanceCache.set(normalizedAddress, usdc);
  return usdc;
}

// ── Resend Email ──

async function sendEmail(to, { subject, html }, templateName, address) {
  if (!RESEND_API_KEY || !to) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[Email] Resend error:', data);
      if (templateName) dbRun('INSERT INTO email_log (address, template, subject, recipient, status) VALUES (?,?,?,?,?)', [address || '', templateName, subject, to, 'failed']);
    } else {
      console.log(`[Email] Sent to ${to}: "${subject}"`);
      if (templateName) dbRun('INSERT INTO email_log (address, template, subject, recipient, status) VALUES (?,?,?,?,?)', [address || '', templateName, subject, to, 'sent']);
    }
  } catch (err) {
    console.warn('[Email] Failed to send:', err.message);
    if (templateName) dbRun('INSERT INTO email_log (address, template, subject, recipient, status) VALUES (?,?,?,?,?)', [address || '', templateName, subject, to, 'error']);
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  ensureDbDirectory();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Initialize schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Migrations — add columns if missing (must run before UNIQUE migration)
  try { db.exec('ALTER TABLE strategies ADD COLUMN notify_email TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN side TEXT NOT NULL DEFAULT \'buy\''); } catch(e) {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN alert_metric TEXT NOT NULL DEFAULT \'mc\''); } catch(e) {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN price_source TEXT NOT NULL DEFAULT \'spot\''); } catch(e) {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN market_type TEXT NOT NULL DEFAULT \'spot\''); } catch(e) {}

  // Email log table
  db.exec(`CREATE TABLE IF NOT EXISTS email_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    address    TEXT NOT NULL,
    template   TEXT NOT NULL,
    subject    TEXT,
    recipient  TEXT,
    status     TEXT NOT NULL DEFAULT 'sent',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Migration: remove UNIQUE constraint on address to allow multiple strategies per wallet
  try {
    const idx = dbGet("SELECT sql FROM sqlite_master WHERE type='table' AND name='strategies'");
    if (idx && idx.sql && idx.sql.includes('UNIQUE')) {
      // First ensure no NULLs in columns that will be NOT NULL
      db.exec("UPDATE strategies SET alert_metric = 'mc' WHERE alert_metric IS NULL");
      db.exec("UPDATE strategies SET price_source = 'spot' WHERE price_source IS NULL");
      db.exec("UPDATE strategies SET side = 'buy' WHERE side IS NULL");
      // Drop stale temp table from any previous failed attempt
      db.exec('DROP TABLE IF EXISTS strategies_new');
      db.exec(`CREATE TABLE strategies_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        agent_authorized INTEGER NOT NULL DEFAULT 0,
        pe_trigger REAL NOT NULL,
        order_type TEXT NOT NULL DEFAULT 'market',
        alert_metric TEXT NOT NULL DEFAULT 'mc',
        price_source TEXT NOT NULL DEFAULT 'spot',
        limit_offset_pct REAL,
        amount_usdc REAL NOT NULL,
        max_triggers INTEGER NOT NULL DEFAULT 3,
        triggers_used INTEGER NOT NULL DEFAULT 0,
        total_budget REAL NOT NULL,
        budget_used REAL NOT NULL DEFAULT 0,
        cooldown_seconds INTEGER NOT NULL DEFAULT 14400,
        last_triggered_at TEXT,
        expires_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        notify_email TEXT,
        notify_enabled INTEGER NOT NULL DEFAULT 0,
        side TEXT NOT NULL DEFAULT 'buy',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`INSERT INTO strategies_new
        (id, address, agent_authorized, pe_trigger, order_type, alert_metric, price_source,
         limit_offset_pct, amount_usdc, max_triggers, triggers_used, total_budget, budget_used,
         cooldown_seconds, last_triggered_at, expires_at, active, notify_email, notify_enabled,
         side, created_at)
        SELECT id, address, agent_authorized, pe_trigger, order_type, alert_metric, price_source,
         limit_offset_pct, amount_usdc, max_triggers, triggers_used, total_budget, budget_used,
         cooldown_seconds, last_triggered_at, expires_at, active, notify_email, notify_enabled,
         side, created_at
        FROM strategies`);
      db.exec('DROP TABLE strategies');
      db.exec('ALTER TABLE strategies_new RENAME TO strategies');
      console.log('[Migration] Removed UNIQUE constraint on strategies.address');
    }
  } catch(e) { console.warn('[Migration] UNIQUE removal skipped:', e.message); }

  try {
    db.run(`
      UPDATE strategies
      SET budget_used = ROUND(COALESCE(triggers_used, 0) * COALESCE(amount_usdc, 0), 8)
      WHERE ABS(COALESCE(budget_used, 0) - (COALESCE(triggers_used, 0) * COALESCE(amount_usdc, 0))) > ?
    `, [USDC_COMPARISON_EPSILON]);
    const normalizedCount = typeof db.getRowsModified === 'function' ? db.getRowsModified() : 0;
    if (normalizedCount > 0) {
      console.log(`[Migration] Normalized budget_used for ${normalizedCount} strategies to nominal per-trigger spend`);
    }
  } catch(e) {
    console.warn('[Migration] Budget normalization skipped:', e.message);
  }

  saveDb();
}

// ── Express App ──

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || (origin === 'null' && ALLOW_NULL_ORIGIN)) {
      return cb(null, true);
    }
    cb(new Error('CORS not allowed'));
  },
}));

// ── Validation helpers ──

function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function validateStrategyConfig(config) {
  const errors = [];
  if (typeof config.pe_trigger !== 'number' || config.pe_trigger <= 0 || config.pe_trigger > 200)
    errors.push('pe_trigger must be between 0 and 200');
  if (!['market', 'limit'].includes(config.order_type))
    errors.push('order_type must be "market" or "limit"');
  if (config.order_type === 'limit' && (typeof config.limit_offset_pct !== 'number' || config.limit_offset_pct >= 0))
    errors.push('limit_offset_pct must be negative for limit orders');
  if (typeof config.amount_usdc !== 'number' || config.amount_usdc < 10 || config.amount_usdc > 100000)
    errors.push('amount_usdc must be between 10 and 100,000');
  if (!Number.isInteger(config.max_triggers) || config.max_triggers < 1 || config.max_triggers > 100)
    errors.push('max_triggers must be 1-100');
  if (typeof config.total_budget !== 'number' || config.total_budget < config.amount_usdc)
    errors.push('total_budget must be >= amount_usdc');
  if (!Number.isInteger(config.cooldown_seconds) || config.cooldown_seconds < 60)
    errors.push('cooldown_seconds must be >= 60');
  if (config.expires_at) {
    if (isNaN(Date.parse(config.expires_at)))
      errors.push('expires_at must be a valid ISO date');
    if (new Date(config.expires_at) <= new Date())
      errors.push('expires_at must be in the future');
  }
  if (config.side && !['buy', 'sell'].includes(config.side))
    errors.push('side must be "buy" or "sell"');
  if (config.alert_metric && !['mc', 'fdv', 'price'].includes(config.alert_metric))
    errors.push('alert_metric must be "mc", "fdv", or "price"');
  if (config.price_source && !['spot', 'median'].includes(config.price_source))
    errors.push('price_source must be "spot" or "median"');
  if (config.market_type && !['spot', 'perp'].includes(config.market_type))
    errors.push('market_type must be "spot" or "perp"');
  return errors;
}

function normalizePeMetric(metric) {
  return metric === 'fdv' ? 'fdv' : 'mc';
}

function parseBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

async function fetchUpstreamJson(url, options = {}) {
  const upstreamRes = await fetch(url, options);
  const rawText = await upstreamRes.text();

  if (!upstreamRes.ok) {
    const error = new Error(`Upstream request failed (${upstreamRes.status}) for ${url}`);
    error.status = upstreamRes.status;
    error.detail = rawText;
    throw error;
  }

  try {
    return JSON.parse(rawText);
  } catch (_error) {
    const error = new Error(`Upstream returned invalid JSON for ${url}`);
    error.status = 502;
    error.detail = rawText;
    throw error;
  }
}

function sendSiteFile(res, relativePath) {
  res.sendFile(path.join(SITE_ROOT, relativePath));
}

function isAgentConfigured() {
  try {
    getAgentAccount();
    return true;
  } catch (error) {
    return false;
  }
}

function isBuilderConfigured() {
  return !!String(process.env.BUILDER_ADDRESS || '').trim();
}

function getOrderOidFromPayload(hlResponse) {
  if (!hlResponse) return null;

  let payload = hlResponse;
  try {
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch (e) {
    return null;
  }

  const status = Array.isArray(payload?.response?.data?.statuses) ? payload.response.data.statuses[0] : null;
  const oid = status?.filled?.oid || status?.resting?.oid || null;
  return oid ? String(oid) : null;
}

async function attachOrderExplorerLinks(address, orders) {
  if (!Array.isArray(orders) || !orders.length) return orders || [];

  const candidateOrders = orders
    .map((order) => ({ order, oid: getOrderOidFromPayload(order.hl_response) }))
    .filter(({ order, oid }) => order.status === 'filled' && oid);

  if (!candidateOrders.length) {
    return orders.map((order) => ({ ...order, oid: getOrderOidFromPayload(order.hl_response) }));
  }

  const earliestCreatedAt = candidateOrders.reduce((minValue, { order }) => {
    const timestamp = order.created_at ? new Date(order.created_at).getTime() : Date.now();
    return Math.min(minValue, Number.isFinite(timestamp) ? timestamp : Date.now());
  }, Date.now());
  const startTime = Math.max(0, earliestCreatedAt - 86400000);

  try {
    const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userFillsByTime', user: address, startTime }),
    });

    if (!hlRes.ok) {
      return orders.map((order) => ({ ...order, oid: getOrderOidFromPayload(order.hl_response) }));
    }

    const fills = await hlRes.json();
    const traceMap = new Map();
    (Array.isArray(fills) ? fills : []).forEach((fill) => {
      const oid = fill?.oid ? String(fill.oid) : null;
      const hash = typeof fill?.hash === 'string' && /^0x[0-9a-f]+$/i.test(fill.hash) && !/^0x0+$/i.test(fill.hash)
        ? fill.hash
        : null;
      if (!oid || !hash) return;
      traceMap.set(oid, hash);
    });

    return orders.map((order) => {
      const oid = getOrderOidFromPayload(order.hl_response);
      const txHash = oid ? traceMap.get(oid) || null : null;
      return {
        ...order,
        oid,
        tx_hash: txHash,
        explorer_url: txHash ? `https://app.hyperliquid.xyz/explorer/tx/${encodeURIComponent(txHash)}` : null,
      };
    });
  } catch (e) {
    return orders.map((order) => ({ ...order, oid: getOrderOidFromPayload(order.hl_response) }));
  }
}

// ── Routes ──

/**
 * POST /api/strategies
 * Body: { address, signature, nonce, config: { pe_trigger, order_type, ... } }
 * Always creates a NEW strategy (multi-strategy per wallet).
 */
app.post('/api/strategies', (req, res) => {
  try {
    const { address, signature, nonce, config } = req.body;

    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!signature || typeof signature !== 'string') return res.status(400).json({ error: 'Missing signature' });
    if (!config) return res.status(400).json({ error: 'Missing config' });

    const errors = validateStrategyConfig(config);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    const addr = address.toLowerCase();
    const expiresAt = new Date(config.expires_at).toISOString();
    const agentAuth = req.body.agent_authorized !== undefined ? (req.body.agent_authorized ? 1 : 0) : 1;

    // If editing an existing strategy (id provided), update it
    if (req.body.strategy_id) {
      const existing = dbGet('SELECT id FROM strategies WHERE id = ? AND LOWER(address) = ?', [req.body.strategy_id, addr]);
      if (!existing) return res.status(404).json({ error: 'Strategy not found' });
      dbRun(`UPDATE strategies SET
        agent_authorized = ?, pe_trigger = ?, order_type = ?,
        limit_offset_pct = ?, amount_usdc = ?, max_triggers = ?,
        total_budget = ?, cooldown_seconds = ?, expires_at = ?,
        side = ?, alert_metric = ?, price_source = ?, market_type = ?,
        active = 1, triggers_used = 0, budget_used = 0, last_triggered_at = NULL
        WHERE id = ?`,
        [agentAuth, config.pe_trigger, config.order_type, config.limit_offset_pct || null,
         config.amount_usdc, config.max_triggers, config.total_budget,
         config.cooldown_seconds, expiresAt,
         config.side || 'buy', config.alert_metric || 'mc', config.price_source || 'spot',
         config.market_type || 'spot',
         req.body.strategy_id]);
      const strategy = dbGet('SELECT * FROM strategies WHERE id = ?', [req.body.strategy_id]);
      console.log(`[Strategy] Updated #${strategy.id} for ${address} — PE trigger: ${config.pe_trigger}x`);
      res.json({ ok: true, strategy });
      // Immediate execution: if threshold already met, execute now
      if (agentAuth) {
        setImmediate(() => executeStrategyIfTriggered(strategy));
      }
      return;
    }

    // Create new strategy
    dbRun(`INSERT INTO strategies (address, agent_authorized, pe_trigger, order_type,
      limit_offset_pct, amount_usdc, max_triggers, total_budget,
      cooldown_seconds, expires_at, side, alert_metric, price_source, market_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [addr, agentAuth, config.pe_trigger, config.order_type, config.limit_offset_pct || null,
       config.amount_usdc, config.max_triggers, config.total_budget,
       config.cooldown_seconds, expiresAt,
       config.side || 'buy', config.alert_metric || 'mc', config.price_source || 'spot',
       config.market_type || 'spot']);

    const strategy = dbGet('SELECT * FROM strategies WHERE LOWER(address) = ? ORDER BY id DESC LIMIT 1', [addr]);
    console.log(`[Strategy] Created #${strategy.id} for ${address} — PE trigger: ${config.pe_trigger}x`);
    res.json({ ok: true, strategy });

    // Immediate execution: if strategy is authorized and threshold already met, execute now
    if (agentAuth) {
      setImmediate(() => executeStrategyIfTriggered(strategy));
    }
  } catch (err) {
    console.error('[POST /api/strategies]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/strategies/:address — returns ALL strategies for a wallet
 * Also returns current backend-computed P/E so the dashboard can show any front/back divergence.
 */
app.get('/api/strategies/:address', async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid address' });

  const strategies = dbAll('SELECT * FROM strategies WHERE LOWER(address) = ? AND active = 1 ORDER BY created_at DESC', [address.toLowerCase()]);
  if (!strategies || strategies.length === 0) return res.status(404).json({ error: 'No strategy found' });

  // Always compute fresh MC P/E so the dashboard shows exactly what the backend sees,
  // making any front/backend divergence immediately visible.
  let backendPE = null;
  try {
    const mcData = await getCurrentPE('mc');
    backendPE = { mc: Math.round(mcData.pe * 100) / 100, price: mcData.price };
    const needsFdv = strategies.some(s => normalizePeMetric(s.alert_metric || 'mc') === 'fdv');
    if (needsFdv) {
      const fdvData = await getCurrentPE('fdv');
      backendPE.fdv = Math.round(fdvData.pe * 100) / 100;
    }
  } catch (e) {
    console.warn('[GET /api/strategies] Could not compute backend P/E:', e.message);
  }

  // Backward compat: also return first active strategy as `strategy`
  const active = strategies.find(s => s.active) || strategies[0];
  res.json({ strategy: active, strategies, backendPE });
});

/**
 * PATCH /api/strategies/:address/authorize — mark ALL strategies for this address as authorized
 */
app.patch('/api/strategies/:address/authorize', (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid address' });

  dbRun('UPDATE strategies SET agent_authorized = 1 WHERE LOWER(address) = ?', [address.toLowerCase()]);
  console.log(`[Strategy] Agent authorized for ${address}`);
  res.json({ ok: true });

  // Check all strategies immediately after authorization
  const strats = dbAll('SELECT * FROM strategies WHERE LOWER(address) = ? AND active = 1', [address.toLowerCase()]);
  for (const s of strats) {
    setImmediate(() => executeStrategyIfTriggered(s));
  }
});

/**
 * PATCH /api/strategies/:id/email — save email notification preferences
 */
app.patch('/api/strategies/:id/email', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { email, notify } = req.body;
  if (email && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return res.status(400).json({ error: 'Invalid email' });

  dbRun('UPDATE strategies SET notify_email = ?, notify_enabled = ? WHERE id = ?',
    [email || null, notify ? 1 : 0, id]);
  console.log(`[Strategy] Email notification ${notify ? 'enabled' : 'disabled'} for strategy #${id}`);
  res.json({ ok: true });
});

/**
 * PATCH /api/strategies/:id/pause
 */
app.patch('/api/strategies/:id/pause', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  dbRun('UPDATE strategies SET active = 0 WHERE id = ?', [id]);
  console.log(`[Strategy] Paused #${id}`);
  res.json({ ok: true });
});

/**
 * PATCH /api/strategies/:id/resume
 */
app.patch('/api/strategies/:id/resume', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const strategy = dbGet('SELECT * FROM strategies WHERE id = ?', [id]);
  if (!strategy) return res.status(404).json({ error: 'No strategy found' });
  if (!strategy.agent_authorized) return res.status(400).json({ error: 'Agent not authorized' });

  dbRun('UPDATE strategies SET active = 1 WHERE id = ?', [id]);
  console.log(`[Strategy] Resumed #${id}`);
  res.json({ ok: true });
});

/**
 * DELETE /api/strategies/:id — permanently delete a strategy
 */
app.delete('/api/strategies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  dbRun('DELETE FROM strategies WHERE id = ?', [id]);
  console.log(`[Strategy] Deleted #${id}`);
  res.json({ ok: true, message: 'Strategy deleted.' });
});

/**
 * GET /api/orders/:address
 */
app.get('/api/orders/:address', async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid address' });

  try {
    const orders = dbAll('SELECT * FROM orders WHERE LOWER(address) = ? ORDER BY created_at DESC LIMIT 50', [address.toLowerCase()]);
    const enrichedOrders = await attachOrderExplorerLinks(address.toLowerCase(), orders);
    res.json({ orders: enrichedOrders });
  } catch (err) {
    console.error('[GET /api/orders/:address]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/balance/:address — get USDC and HYPE spot balances
 */
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
    });
    const data = await hlRes.json();
    let usdc = 0, hype = 0;
    if (data.balances) {
      for (const b of data.balances) {
        if (b.coin === 'USDC' || b.token === 0) usdc = parseFloat(b.total || '0');
        if (b.coin === 'HYPE') hype = parseFloat(b.total || '0');
      }
    }
    res.json({ usdc, hype });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

/**
 * GET /api/email-preview/:template — preview email templates in browser
 * Templates: alert-buy, alert-sell, order-buy, order-sell
 */
app.get('/api/email-preview/:template', requireAdmin, (req, res) => {
  const sample = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    metric: 'mc', triggerValue: 12, currentValue: 9.8,
    price: 28.45, source: 'Spot', date: new Date().toISOString(),
    sizeHype: 35.12, amountUsdc: 1000, orderType: 'market',
    status: 'filled', triggersUsed: 2, maxTriggers: 5,
    budgetUsed: 2000, totalBudget: 5000,
  };
  const templates = {
    'alert-buy': () => alertBuy(sample),
    'alert-sell': () => alertSell(sample),
    'order-buy': () => orderBuy(sample),
    'order-sell': () => orderSell(sample),
  };
  const fn = templates[req.params.template];
  if (!fn) return res.status(404).json({ error: 'Template not found. Use: alert-buy, alert-sell, order-buy, order-sell' });
  const { html } = fn();
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

/**
 * GET /api/pe — current P/E data
 */
app.get('/api/pe', async (req, res) => {
  try {
    const metric = normalizePeMetric(req.query.metric);
    const includeBurn = parseBooleanFlag(req.query.includeBurn);
    const pe = await getCurrentPE(metric, { includeBurn });
    res.json(pe);
  } catch (err) {
    console.error('[GET /api/pe]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/defillama/fees', async (_req, res) => {
  try {
    const data = await fetchUpstreamJson(DEFILLAMA_FEES_URL);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/defillama/fees]', err);
    res.status(err.status || 502).json({
      error: 'Failed to fetch DefiLlama fees data',
      detail: err.detail || err.message,
    });
  }
});

app.get('/api/defillama/protocol', async (_req, res) => {
  try {
    const data = await fetchUpstreamJson(DEFILLAMA_PROTOCOL_URL);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/defillama/protocol]', err);
    res.status(err.status || 502).json({
      error: 'Failed to fetch DefiLlama protocol data',
      detail: err.detail || err.message,
    });
  }
});

app.post('/api/hl-info', async (req, res) => {
  try {
    const data = await fetchUpstreamJson(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    res.json(data);
  } catch (err) {
    console.error('[POST /api/hl-info]', err);
    res.status(err.status || 502).json({
      error: 'Failed to fetch Hyperliquid info data',
      detail: err.detail || err.message,
    });
  }
});

app.post('/api/hl-exchange', async (req, res) => {
  try {
    const data = await fetchUpstreamJson(HYPERLIQUID_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    res.json(data);
  } catch (err) {
    console.error('[POST /api/hl-exchange]', err);
    res.status(err.status || 502).json({
      error: 'Failed to fetch Hyperliquid exchange data',
      detail: err.detail || err.message,
    });
  }
});

/**
 * GET /api/agent-address — returns the agent wallet address for frontend signing
 */
app.get('/api/agent-address', (_req, res) => {
  try {
    const account = getAgentAccount();
    let builderAddress = null;
    let builderMaxFeeRate = null;
    try {
      builderAddress = getBuilderAddress();
      builderMaxFeeRate = getBuilderApprovalMaxFeeRate();
    } catch (error) {}
    res.json({
      agentAddress: account.address,
      builderAddress,
      builderMaxFeeRate,
      workerDisabled: DISABLE_WORKER,
    });
  } catch (err) {
    res.status(500).json({
      error: 'Agent not configured',
      detail: err && err.message ? err.message : 'Unknown configuration error',
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    workerDisabled: DISABLE_WORKER,
    agentConfigured: isAgentConfigured(),
    builderConfigured: isBuilderConfigured(),
    emailConfigured: !!RESEND_API_KEY,
  });
});

// ── Admin Dashboard API ──

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin not configured' });
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  try {
    const totalUsers       = dbGet('SELECT COUNT(*) as n FROM strategies')?.n || 0;
    const activeUsers      = dbGet('SELECT COUNT(*) as n FROM strategies WHERE active = 1')?.n || 0;
    const authorizedUsers  = dbGet('SELECT COUNT(*) as n FROM strategies WHERE agent_authorized = 1 AND active = 1')?.n || 0;
    const emailEnabled     = dbGet('SELECT COUNT(*) as n FROM strategies WHERE notify_enabled = 1')?.n || 0;
    const totalOrders      = dbGet('SELECT COUNT(*) as n FROM orders')?.n || 0;
    const filledOrders     = dbGet('SELECT COUNT(*) as n FROM orders WHERE status = "filled"')?.n || 0;
    const failedOrders     = dbGet('SELECT COUNT(*) as n FROM orders WHERE status = "failed"')?.n || 0;
    const totalVolume      = dbGet('SELECT COALESCE(SUM(amount_usdc),0) as n FROM orders WHERE status = "filled"')?.n || 0;
    const totalHype        = dbGet('SELECT COALESCE(SUM(size_hype),0) as n FROM orders WHERE status = "filled"')?.n || 0;
    const totalEmails      = dbGet('SELECT COUNT(*) as n FROM email_log')?.n || 0;
    const emailsSent       = dbGet('SELECT COUNT(*) as n FROM email_log WHERE status = "sent"')?.n || 0;
    const emailsFailed     = dbGet('SELECT COUNT(*) as n FROM email_log WHERE status != "sent"')?.n || 0;
    const buyStrategies    = dbGet('SELECT COUNT(*) as n FROM strategies WHERE side = "buy" AND active = 1')?.n || 0;
    const sellStrategies   = dbGet('SELECT COUNT(*) as n FROM strategies WHERE side = "sell" AND active = 1')?.n || 0;
    const avgTrigger       = dbGet('SELECT COALESCE(AVG(pe_trigger),0) as n FROM strategies WHERE active = 1')?.n || 0;
    const totalBudget      = dbGet('SELECT COALESCE(SUM(total_budget),0) as n FROM strategies WHERE active = 1')?.n || 0;
    const budgetUsed       = dbGet('SELECT COALESCE(SUM(budget_used),0) as n FROM strategies WHERE active = 1')?.n || 0;

    res.json({
      users: { total: totalUsers, active: activeUsers, authorized: authorizedUsers, emailEnabled },
      orders: { total: totalOrders, filled: filledOrders, failed: failedOrders, volumeUsdc: totalVolume, totalHype },
      emails: { total: totalEmails, sent: emailsSent, failed: emailsFailed },
      strategies: { buy: buyStrategies, sell: sellStrategies, avgTrigger: Number(avgTrigger.toFixed(2)), totalBudget, budgetUsed },
    });
  } catch (err) {
    console.error('[Admin]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/admin/orders-history', requireAdmin, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const rows = dbAll(`
      SELECT date(created_at) as day,
             COUNT(*) as total,
             SUM(CASE WHEN status='filled' THEN 1 ELSE 0 END) as filled,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
             COALESCE(SUM(CASE WHEN status='filled' THEN amount_usdc ELSE 0 END),0) as volume
      FROM orders
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day
    `, [days]);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/admin/emails-history', requireAdmin, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const rows = dbAll(`
      SELECT date(created_at) as day,
             COUNT(*) as total,
             SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent,
             SUM(CASE WHEN status!='sent' THEN 1 ELSE 0 END) as failed,
             template
      FROM email_log
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY day, template ORDER BY day
    `, [days]);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  try {
    const users = dbAll(`
      SELECT s.address, s.side, s.alert_metric, s.price_source, s.pe_trigger,
             s.amount_usdc, s.max_triggers, s.triggers_used, s.total_budget, s.budget_used,
             s.active, s.agent_authorized, s.notify_enabled, s.notify_email,
             s.created_at, s.expires_at, s.last_triggered_at,
             (SELECT COUNT(*) FROM orders o WHERE o.strategy_id = s.id) as order_count,
             (SELECT COUNT(*) FROM orders o WHERE o.strategy_id = s.id AND o.status='filled') as filled_count
      FROM strategies s ORDER BY s.created_at DESC
    `);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/admin/recent-orders', requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const orders = dbAll('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [limit]);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/admin/recent-emails', requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const emails = dbAll('SELECT * FROM email_log ORDER BY created_at DESC LIMIT ?', [limit]);
    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Frontend Pages & Assets ──

app.get(['/', '/index.html'], (_req, res) => {
  sendSiteFile(res, 'index.html');
});

app.get(['/docs', '/docs.html'], (_req, res) => {
  sendSiteFile(res, 'docs.html');
});

app.get(['/admin', '/admin.html'], (_req, res) => {
  sendSiteFile(res, 'admin.html');
});

app.get('/Hypurrmium.png', (_req, res) => {
  sendSiteFile(res, 'Hypurrmium.png');
});

app.get('/Hypurrmium2.png', (_req, res) => {
  sendSiteFile(res, 'Hypurrmium2.png');
});

app.get('/Jojo2.webp', (_req, res) => {
  sendSiteFile(res, 'Jojo2.webp');
});

// ── P/E Surveillance Worker ──

// Lock set to prevent concurrent execution of the same strategy
const executingStrategies = new Set();

/**
 * Immediately check and execute a single strategy if its threshold is already met.
 * Called right after strategy creation/update/authorization.
 */
async function executeStrategyIfTriggered(s) {
  if (DISABLE_WORKER) {
    console.log(`[Immediate] Local mode enabled; skipping immediate execution for strategy #${s.id}`);
    return;
  }

  // Prevent concurrent execution for the same strategy (race condition guard)
  if (executingStrategies.has(s.id)) {
    console.log(`[Immediate] Strategy #${s.id} already executing, skipping`);
    return;
  }
  executingStrategies.add(s.id);
  try {
    // Re-read from DB to get latest state
    const strat = dbGet('SELECT * FROM strategies WHERE id = ?', [s.id]);
    if (!strat || !strat.active || !strat.agent_authorized) return;
    if (strat.triggers_used >= strat.max_triggers) return;
    // Budget check only applies to buys (for sells the constraint is HYPE balance, not USDC budget)
    if ((strat.side || 'buy') === 'buy' && !hasNominalBudgetForNextOrder(strat)) return;
    if (new Date(strat.expires_at) <= new Date()) return;
    if (strat.last_triggered_at) {
      const elapsed = (Date.now() - new Date(strat.last_triggered_at).getTime()) / 1000;
      if (elapsed < strat.cooldown_seconds) return;
    }

    const side = strat.side || 'buy';
    const metric = strat.alert_metric || 'mc';
    const source = strat.price_source || 'spot';
    const metricKey = normalizePeMetric(metric);
    const peData = await getCurrentPE(metricKey);
    const currentPE = peData.pe;
    const currentPrice = peData.price;

    let compareValue;
    if (metric === 'price') {
      compareValue = currentPrice;
    } else if (source === 'median') {
      try {
        const medianData = await getMedianPE(metricKey);
        compareValue = medianData.medianPE;
      } catch(e) {
        compareValue = currentPE;
      }
    } else {
      compareValue = currentPE;
    }

    const triggered = side === 'buy' ? compareValue < strat.pe_trigger : compareValue > strat.pe_trigger;
    if (!triggered) {
      console.log(`[Immediate] Strategy #${strat.id} not triggered: ${compareValue.toFixed(2)} vs ${strat.pe_trigger}x`);
      return;
    }

    const nominalBudgetDelta = getNominalBudgetDelta(strat);
    if (side === 'buy') {
      const availableUsdc = await getCachedUserUsdcBalance(strat.address);
      if (availableUsdc + USDC_COMPARISON_EPSILON < nominalBudgetDelta) {
        console.log(`[Immediate] Strategy #${strat.id} wallet exhausted: ${availableUsdc.toFixed(2)} USDC available, ${nominalBudgetDelta.toFixed(2)} required`);
        return;
      }
    }

    const sourceLabel = source === 'median' ? 'Median' : 'Spot';
    const metricLabel = metric === 'price' ? 'Price' : metric === 'fdv' ? 'FDV P/E' : 'MC P/E';
    console.log(`[Immediate] TRIGGERING ${side.toUpperCase()} for ${strat.address} — ${sourceLabel} ${metricLabel} ${compareValue.toFixed(2)} ${side === 'buy' ? '<' : '>'} ${strat.pe_trigger}`);

    // Set last_triggered_at BEFORE placing order to prevent worker from double-triggering
    dbRun(`UPDATE strategies SET last_triggered_at = ? WHERE id = ?`,
      [new Date().toISOString(), strat.id]);

    let result;
    let status = 'filled';
    const mktType = strat.market_type || 'spot';
    try {
      if (side === 'sell') {
        if (strat.order_type === 'market') {
          result = await placeMarketSell(strat.address, strat.amount_usdc, mktType);
        } else {
          result = await placeLimitSell(strat.address, strat.amount_usdc, strat.limit_offset_pct, mktType);
        }
      } else {
        if (strat.order_type === 'market') {
          result = await placeMarketBuy(strat.address, strat.amount_usdc, mktType);
        } else {
          result = await placeLimitBuy(strat.address, strat.amount_usdc, strat.limit_offset_pct, mktType);
        }
      }
    } catch (orderErr) {
      console.error(`[Immediate] Order failed for ${strat.address}:`, orderErr.message);
      result = { response: { error: orderErr.message }, price: currentPrice, size: 0, amountUsdc: 0 };
      status = 'failed';
    }

    dbRun(`INSERT INTO orders (strategy_id, address, pe_at_trigger, price,
      size_hype, amount_usdc, order_type, hl_response, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [strat.id, strat.address, compareValue, result.price || currentPrice,
       result.size || 0, result.amountUsdc || strat.amount_usdc,
       strat.order_type, JSON.stringify(result.response || {}), status, new Date().toISOString()]);

    if (status === 'filled') {
      dbRun(`UPDATE strategies SET triggers_used = triggers_used + 1,
        budget_used = budget_used + ?
        WHERE id = ?`, [nominalBudgetDelta, strat.id]);
    }

    console.log(`[Immediate] Order ${status} for ${strat.address}: ${result.size} HYPE @ $${result.price}`);

    if (status === 'filled' && strat.notify_enabled && strat.notify_email) {
      const emailData = {
        address: strat.address, metric, triggerValue: strat.pe_trigger,
        currentValue: compareValue, price: result.price || currentPrice,
        source: sourceLabel, date: new Date().toISOString(),
        sizeHype: result.size || 0, amountUsdc: result.amountUsdc || strat.amount_usdc,
        orderType: strat.order_type, status,
        triggersUsed: strat.triggers_used + 1,
        maxTriggers: strat.max_triggers,
        budgetUsed: strat.budget_used + nominalBudgetDelta,
        totalBudget: strat.total_budget,
      };
      const tpl = side === 'buy' ? orderBuy(emailData) : orderSell(emailData);
      sendEmail(strat.notify_email, tpl, side === 'buy' ? 'order-buy' : 'order-sell', strat.address);
    }
  } catch (err) {
    console.error(`[Immediate] Error executing strategy #${s.id}:`, err.message);
  } finally {
    executingStrategies.delete(s.id);
  }
}

let workerRunning = false;

async function checkStrategies() {
  if (DISABLE_WORKER) return;
  if (workerRunning) return;
  workerRunning = true;

  try {
    const strategies = dbAll(`
      SELECT * FROM strategies
      WHERE active = 1 AND agent_authorized = 1
        AND triggers_used < max_triggers
        AND datetime(expires_at) > datetime('now')
    `);

    const peSnapshots = {};
    const medianSnapshots = {};
  const userUsdcCache = new Map();

    peSnapshots.mc = await getCurrentPE('mc');
    const currentPrice = peSnapshots.mc.price;
    console.log(`[Worker] MC P/E = ${peSnapshots.mc.pe.toFixed(2)}x | Price = $${currentPrice.toFixed(2)}`);

    const needsFdv = strategies.some(s => normalizePeMetric(s.alert_metric || 'mc') === 'fdv');
    if (needsFdv) {
      peSnapshots.fdv = await getCurrentPE('fdv');
      console.log(`[Worker] FDV P/E = ${peSnapshots.fdv.pe.toFixed(2)}x`);
    }

    const needsMedianMc = strategies.some(s => normalizePeMetric(s.alert_metric || 'mc') === 'mc' && (s.price_source || 'spot') === 'median');
    if (needsMedianMc) {
      try {
        const medianData = await getMedianPE('mc');
        medianSnapshots.mc = medianData.medianPE;
        console.log(`[Worker] Median MC P/E (30d) = ${medianSnapshots.mc.toFixed(2)}x`);
      } catch (e) {
        console.warn('[Worker] Could not compute median MC P/E:', e.message);
      }
    }

    const needsMedianFdv = strategies.some(s => normalizePeMetric(s.alert_metric || 'mc') === 'fdv' && (s.price_source || 'spot') === 'median');
    if (needsMedianFdv) {
      try {
        const medianData = await getMedianPE('fdv');
        medianSnapshots.fdv = medianData.medianPE;
        console.log(`[Worker] Median FDV P/E (30d) = ${medianSnapshots.fdv.toFixed(2)}x`);
      } catch (e) {
        console.warn('[Worker] Could not compute median FDV P/E:', e.message);
      }
    }

    for (const s of strategies) {
      try {
        // Skip if already being executed by another path
        if (executingStrategies.has(s.id)) continue;

        // Re-read strategy from DB to get fresh cooldown/trigger state
        const fresh = dbGet('SELECT * FROM strategies WHERE id = ? AND active = 1 AND agent_authorized = 1', [s.id]);
        if (!fresh) continue;

        const side = fresh.side || 'buy';
        const metric = fresh.alert_metric || 'mc';
        const source = fresh.price_source || 'spot';
        const metricKey = normalizePeMetric(metric);
        const spotPE = peSnapshots[metricKey] ? peSnapshots[metricKey].pe : peSnapshots.mc.pe;

        // Determine the comparison value based on metric + source
        let compareValue;
        if (metric === 'price') {
          compareValue = currentPrice;
        } else {
          compareValue = source === 'median' && medianSnapshots[metricKey] !== undefined
            ? medianSnapshots[metricKey]
            : spotPE;
        }

        console.log(`[Worker] Strategy #${fresh.id} (${side.toUpperCase()}) | ${source === 'median' ? 'Median' : 'Spot'} ${metricKey.toUpperCase()} P/E = ${compareValue.toFixed(2)} | trigger = ${fresh.pe_trigger}x | ${side === 'buy' ? `need < ${fresh.pe_trigger}` : `need > ${fresh.pe_trigger}`}`);

        // Check trigger: buy = below, sell = above
        let triggered;
        if (side === 'buy') {
          triggered = compareValue < fresh.pe_trigger;
        } else {
          triggered = compareValue > fresh.pe_trigger;
        }
        if (!triggered) continue;

        // Check max triggers
        if (fresh.triggers_used >= fresh.max_triggers) continue;

        // Check budget
        // Budget check only applies to buys (for sells the constraint is HYPE balance, not USDC budget)
        if (side === 'buy' && !hasNominalBudgetForNextOrder(fresh)) continue;

        const nominalBudgetDelta = getNominalBudgetDelta(fresh);
        if (side === 'buy') {
          const availableUsdc = await getCachedUserUsdcBalance(fresh.address, userUsdcCache);
          if (availableUsdc + USDC_COMPARISON_EPSILON < nominalBudgetDelta) {
            console.log(`[Worker] Skipping BUY for ${fresh.address} — wallet exhausted (${availableUsdc.toFixed(2)} USDC available, ${nominalBudgetDelta.toFixed(2)} required)`);
            continue;
          }
        }

        // Check cooldown (using fresh DB data)
        if (fresh.last_triggered_at) {
          const lastTrigger = new Date(fresh.last_triggered_at).getTime();
          const elapsed = (Date.now() - lastTrigger) / 1000;
          if (elapsed < fresh.cooldown_seconds) continue;
        }

        // Check expiry
        if (new Date(fresh.expires_at) <= new Date()) continue;

        // Lock this strategy during execution
        executingStrategies.add(s.id);

        const sourceLabel = source === 'median' ? 'Median' : 'Spot';
        const metricLabel = metric === 'price' ? 'Price' : metric === 'fdv' ? 'FDV P/E' : 'MC P/E';
        console.log(`[Worker] TRIGGERING ${side.toUpperCase()} for ${fresh.address} — ${sourceLabel} ${metricLabel} ${compareValue.toFixed(2)} ${side === 'buy' ? '<' : '>'} ${fresh.pe_trigger}`);

        // Set last_triggered_at BEFORE placing order to prevent double-triggering
        dbRun(`UPDATE strategies SET last_triggered_at = ? WHERE id = ?`,
          [new Date().toISOString(), s.id]);

        // Place order
        let result;
        let status = 'filled';
        const mktType = fresh.market_type || 'spot';
        try {
          if (side === 'sell') {
            if (fresh.order_type === 'market') {
              result = await placeMarketSell(fresh.address, fresh.amount_usdc, mktType);
            } else {
              result = await placeLimitSell(fresh.address, fresh.amount_usdc, fresh.limit_offset_pct, mktType);
            }
          } else {
            if (fresh.order_type === 'market') {
              result = await placeMarketBuy(fresh.address, fresh.amount_usdc, mktType);
            } else {
              result = await placeLimitBuy(fresh.address, fresh.amount_usdc, fresh.limit_offset_pct, mktType);
            }
          }
        } catch (orderErr) {
          console.error(`[Worker] Order failed for ${fresh.address}:`, orderErr.message);
          result = { response: { error: orderErr.message }, price: currentPrice, size: 0, amountUsdc: 0 };
          status = 'failed';
        }

        // Log order
        dbRun(`INSERT INTO orders (strategy_id, address, pe_at_trigger, price,
          size_hype, amount_usdc, order_type, hl_response, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.id, fresh.address, compareValue, result.price || currentPrice,
           result.size || 0, result.amountUsdc || fresh.amount_usdc,
           fresh.order_type, JSON.stringify(result.response || {}), status, new Date().toISOString()]);

        // Update strategy counters on success
        if (status === 'filled') {
          dbRun(`UPDATE strategies SET triggers_used = triggers_used + 1,
            budget_used = budget_used + ?
            WHERE id = ?`, [nominalBudgetDelta, s.id]);
        }

        console.log(`[Worker] Order ${status} for ${fresh.address}: ${result.size} HYPE @ $${result.price}`);

        // ── Send email notification (only on success) ──
        if (status === 'filled' && fresh.notify_enabled && fresh.notify_email) {
          const emailData = {
            address: fresh.address,
            metric,
            triggerValue: fresh.pe_trigger,
            currentValue: compareValue,
            price: result.price || currentPrice,
            source: sourceLabel,
            date: new Date().toISOString(),
            sizeHype: result.size || 0,
            amountUsdc: result.amountUsdc || fresh.amount_usdc,
            orderType: fresh.order_type,
            status,
            triggersUsed: fresh.triggers_used + 1,
            maxTriggers: fresh.max_triggers,
            budgetUsed: fresh.budget_used + nominalBudgetDelta,
            totalBudget: fresh.total_budget,
          };
          const tpl = side === 'buy' ? orderBuy(emailData) : orderSell(emailData);
          sendEmail(fresh.notify_email, tpl, side === 'buy' ? 'order-buy' : 'order-sell', fresh.address);
        }

        executingStrategies.delete(s.id);
      } catch (stratErr) {
        executingStrategies.delete(s.id);
        console.error(`[Worker] Error processing strategy ${s.id}:`, stratErr.message);
      }
    }
  } catch (err) {
    console.error('[Worker] Global error:', err.message);
  } finally {
    workerRunning = false;
  }
}

// ── Start ──

async function main() {
  await initDatabase();

  if (!DISABLE_WORKER) {
    // Run worker every 60 seconds
    cron.schedule('* * * * *', () => {
      checkStrategies();
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║  Hypurrmium Auto-Buy Backend             ║`);
    console.log(`  ║  Host: ${HOST.padEnd(35, ' ')}║`);
    console.log(`  ║  Port: ${String(PORT).padEnd(35, ' ')}║`);
    console.log(`  ║  P/E Worker: ${DISABLE_WORKER ? 'disabled (local mode)' : 'every 60s'}${DISABLE_WORKER ? '          ' : '                   '}║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);

    if (!DISABLE_WORKER) {
      // Initial check on startup
      checkStrategies();
    }
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
