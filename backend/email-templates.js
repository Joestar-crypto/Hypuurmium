/**
 * Hypurrmium — Email Templates for Resend
 *
 * Loads HTML files from /templates and replaces {{PLACEHOLDERS}}.
 *
 * 4 templates:
 *   1. alertBuy    — Alert triggered, buy opportunity detected
 *   2. alertSell   — Alert triggered, sell opportunity detected
 *   3. orderBuy    — Automatic buy order executed
 *   4. orderSell   — Automatic sell order executed
 */

const fs   = require('fs');
const path = require('path');

// ── Load HTML templates once at startup ──

const TEMPLATES_DIR = path.join(__dirname, 'templates');

const tpl = {
  alertBuy:  fs.readFileSync(path.join(TEMPLATES_DIR, 'alert-buy.html'),  'utf-8'),
  alertSell: fs.readFileSync(path.join(TEMPLATES_DIR, 'alert-sell.html'), 'utf-8'),
  orderBuy:  fs.readFileSync(path.join(TEMPLATES_DIR, 'order-buy.html'),  'utf-8'),
  orderSell: fs.readFileSync(path.join(TEMPLATES_DIR, 'order-sell.html'), 'utf-8'),
};

// ── Helpers ──

function metricLabel(metric) {
  if (metric === 'price') return 'Price';
  if (metric === 'fdv') return 'FDV P/E';
  return 'P/E';
}

function formatValue(metric, value) {
  if (metric === 'price') return '$' + Number(value).toFixed(2);
  return Number(value).toFixed(2) + 'x';
}

function formatDate(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/** Replace all {{KEY}} placeholders in an HTML string */
function fill(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : '');
}

// ──────────────────────────────────────────
// 1. ALERT — BUY OPPORTUNITY
// ──────────────────────────────────────────

function alertBuy({ address, metric, triggerValue, currentValue, price, source, date }) {
  const mLabel = metricLabel(metric);
  const vars = {
    METRIC_LABEL:  mLabel,
    WALLET:        shortAddr(address),
    DATE:          formatDate(date),
    SOURCE:        source,
    TRIGGER_VALUE: formatValue(metric, triggerValue),
    CURRENT_VALUE: formatValue(metric, currentValue),
    PRICE:         '$' + Number(price).toFixed(2),
  };
  return {
    subject: `HYPE Buy Alert — ${mLabel} reached ${formatValue(metric, currentValue)}`,
    html: fill(tpl.alertBuy, vars),
  };
}

// ──────────────────────────────────────────
// 2. ALERT — SELL OPPORTUNITY
// ──────────────────────────────────────────

function alertSell({ address, metric, triggerValue, currentValue, price, source, date }) {
  const mLabel = metricLabel(metric);
  const vars = {
    METRIC_LABEL:  mLabel,
    WALLET:        shortAddr(address),
    DATE:          formatDate(date),
    SOURCE:        source,
    TRIGGER_VALUE: formatValue(metric, triggerValue),
    CURRENT_VALUE: formatValue(metric, currentValue),
    PRICE:         '$' + Number(price).toFixed(2),
  };
  return {
    subject: `HYPE Sell Alert — ${mLabel} reached ${formatValue(metric, currentValue)}`,
    html: fill(tpl.alertSell, vars),
  };
}

// ──────────────────────────────────────────
// 3. ORDER EXECUTED — BUY
// ──────────────────────────────────────────

function orderBuy({ address, metric, triggerValue, currentValue, price, source, date, sizeHype, amountUsdc, orderType, status, triggersUsed, maxTriggers, budgetUsed, totalBudget }) {
  const mLabel = metricLabel(metric);
  const vars = {
    METRIC_LABEL:  mLabel,
    WALLET:        shortAddr(address),
    DATE:          formatDate(date),
    SOURCE:        source,
    TRIGGER_VALUE: formatValue(metric, triggerValue),
    CURRENT_VALUE: formatValue(metric, currentValue),
    PRICE:         '$' + Number(price).toFixed(2),
    ORDER_TYPE:    orderType,
    STATUS:        status === 'filled' ? 'Filled' : 'Failed',
    STATUS_COLOR:  status === 'filled' ? '#4db87a' : '#e05252',
    AMOUNT_USDC:   '$' + Number(amountUsdc).toFixed(2),
    SIZE_HYPE:     Number(sizeHype).toFixed(4),
    TRIGGERS_USED: String(triggersUsed),
    MAX_TRIGGERS:  String(maxTriggers),
    BUDGET_USED:   '$' + Number(budgetUsed).toFixed(2),
    TOTAL_BUDGET:  '$' + Number(totalBudget).toFixed(2),
  };
  return {
    subject: `HYPE Bought — ${Number(sizeHype).toFixed(2)} HYPE @ $${Number(price).toFixed(2)}`,
    html: fill(tpl.orderBuy, vars),
  };
}

// ──────────────────────────────────────────
// 4. ORDER EXECUTED — SELL
// ──────────────────────────────────────────

function orderSell({ address, metric, triggerValue, currentValue, price, source, date, sizeHype, amountUsdc, orderType, status, triggersUsed, maxTriggers, budgetUsed, totalBudget }) {
  const mLabel = metricLabel(metric);
  const vars = {
    METRIC_LABEL:  mLabel,
    WALLET:        shortAddr(address),
    DATE:          formatDate(date),
    SOURCE:        source,
    TRIGGER_VALUE: formatValue(metric, triggerValue),
    CURRENT_VALUE: formatValue(metric, currentValue),
    PRICE:         '$' + Number(price).toFixed(2),
    ORDER_TYPE:    orderType,
    STATUS:        status === 'filled' ? 'Filled' : 'Failed',
    STATUS_COLOR:  status === 'filled' ? '#4db87a' : '#e05252',
    AMOUNT_USDC:   '$' + Number(amountUsdc).toFixed(2),
    SIZE_HYPE:     Number(sizeHype).toFixed(4),
    TRIGGERS_USED: String(triggersUsed),
    MAX_TRIGGERS:  String(maxTriggers),
    BUDGET_USED:   '$' + Number(budgetUsed).toFixed(2),
    TOTAL_BUDGET:  '$' + Number(totalBudget).toFixed(2),
  };
  return {
    subject: `HYPE Sold — ${Number(sizeHype).toFixed(2)} HYPE @ $${Number(price).toFixed(2)}`,
    html: fill(tpl.orderSell, vars),
  };
}

module.exports = { alertBuy, alertSell, orderBuy, orderSell };
