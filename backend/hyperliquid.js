/**
 * Hypurrmium — Hyperliquid interaction layer
 *
 * Functions:
 *   getCurrentPE()
 *   approveAgent(userAddress, signature)
 *   placeMarketBuy(userAddress, amountUsdc)
 *   placeLimitBuy(userAddress, amountUsdc, offsetPct)
 *   revokeAgent(userAddress)
 */

const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http, keccak256, encodePacked, encodeAbiParameters, parseAbiParameters, toHex, numberToHex, pad } = require('viem');
const { arbitrum } = require('viem/chains');
const { encode: msgpackEncode } = require('@msgpack/msgpack');

const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const HL_INFO_URL     = 'https://api.hyperliquid.xyz/info';
const DEFILLAMA_URL   = 'https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyRevenue';
const SUPPLY          = 333_333_333;
const FDV_SUPPLY      = 1_000_000_000;
const REVENUE_WINDOW_DAYS = 30;
const HYPE_TOKEN_ID   = '0x0d01dc56dcaaca66ad901c959b4011ec';
const BURN_CACHE_TTL_MS = 5 * 60 * 1000;
const BUILDER_APPROVAL_MAX_FEE_RATE = process.env.BUILDER_APPROVAL_MAX_FEE_RATE || '0.10%';
const BUILDER_MIN_FEE_BPS = 1;
const BUILDER_BASE_FEE_BPS = 10;
const BUILDER_REQUIRED_PERP_USDC = 100;
const BUILDER_APPROVAL_CACHE_TTL_MS = 5 * 60 * 1000;
const BUILDER_BALANCE_CACHE_TTL_MS = 60 * 1000;
const BURN_ADDRESSES = new Set([
  '0xfefefefefefefefefefefefefefefefefefefefe',
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
].map((address) => address.toLowerCase()));

let burnedSupplyCache = {
  fetchedAt: 0,
  burnedHype: 0,
  circulatingSupply: SUPPLY,
  totalSupply: FDV_SUPPLY,
};

let builderPerpBalanceCache = {
  fetchedAt: 0,
  address: null,
  usdc: 0,
};

const builderApprovalCache = new Map();

// HYPE asset indices on Hyperliquid (resolved lazily)
let HYPE_SPOT_INDEX = null;
let HYPE_PERP_INDEX = null;

// ── EIP-712 domain & types for Hyperliquid exchange actions ──

// Domain for user-signed actions (approveAgent, transfers, etc.)
const HL_DOMAIN = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: 421614,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

// Domain for L1 actions (orders) — uses Exchange domain per HL SDK
const L1_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

// For agent-signed orders the EIP-712 types differ from user-signed ones.
// The "phantom" agent object { source: 'a', connectionId: agentAddress }
// is hashed together with the action.

const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

// ── Agent wallet ──

function normalizePrivateKey(value, envName = 'private key') {
  const rawValue = String(value || '').trim();
  if (!rawValue) throw new Error(`${envName} not set`);

  const unquotedValue = rawValue.replace(/^['"]|['"]$/g, '');
  const compactValue = unquotedValue.replace(/\s+/g, '');
  const normalizedValue = compactValue.startsWith('0x') ? compactValue : `0x${compactValue}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedValue)) {
    throw new Error(`${envName} must be 64 hex characters${compactValue.startsWith('0x') ? '' : ' (optionally prefixed with 0x)'}`);
  }

  return normalizedValue;
}

function getAgentAccount() {
  const key = normalizePrivateKey(process.env.AGENT_PRIVATE_KEY, 'AGENT_PRIVATE_KEY');
  return privateKeyToAccount(key);
}

function getBuilderAddress() {
  const addr = process.env.BUILDER_ADDRESS;
  if (!addr) throw new Error('BUILDER_ADDRESS not set');
  return addr;
}

function getBuilderApprovalMaxFeeRate() {
  const value = String(BUILDER_APPROVAL_MAX_FEE_RATE || '0.10%').trim();
  return value.endsWith('%') ? value : `${value}%`;
}

function parsePercentToTenthsBps(value) {
  const numeric = parseFloat(String(value || '').replace('%', '').trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric * 1000);
}

function formatTenthsBpsAsPercent(tenthsBps) {
  const pct = (Number(tenthsBps) || 0) / 1000;
  if (pct <= 0) return '0.00%';
  return `${pct >= 0.1 ? pct.toFixed(2) : pct.toFixed(3)}%`;
}

function computeBuilderFeeTenthsBps(tradeSizeUsdc, marketType = 'spot') {
  const safeTradeSize = Math.max(Number(tradeSizeUsdc) || 0, 1);
  const sizeFactor = Math.max(safeTradeSize / 1000, 1);
  const dynamicBps = BUILDER_BASE_FEE_BPS / Math.sqrt(sizeFactor);
  const absoluteCapTenthsBps = marketType === 'perp' ? 100 : 1000;
  const approvedCapTenthsBps = parsePercentToTenthsBps(getBuilderApprovalMaxFeeRate());
  const effectiveCapTenthsBps = Math.min(absoluteCapTenthsBps, approvedCapTenthsBps || absoluteCapTenthsBps);
  return Math.max(BUILDER_MIN_FEE_BPS * 10, Math.min(effectiveCapTenthsBps, Math.round(dynamicBps * 10)));
}

async function getBuilderPerpUsdcBalance(builderAddress) {
  const normalizedBuilder = String(builderAddress || '').toLowerCase();
  if (!normalizedBuilder) return 0;

  if (
    builderPerpBalanceCache.address === normalizedBuilder
    && builderPerpBalanceCache.fetchedAt
    && (Date.now() - builderPerpBalanceCache.fetchedAt) < BUILDER_BALANCE_CACHE_TTL_MS
  ) {
    return builderPerpBalanceCache.usdc;
  }

  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: normalizedBuilder }),
  }).then(r => r.json());

  const accountValue = parseFloat(res?.marginSummary?.accountValue || '0') || 0;
  const withdrawable = parseFloat(res?.withdrawable || '0') || 0;
  const usdc = Math.max(accountValue, withdrawable, 0);

  builderPerpBalanceCache = {
    fetchedAt: Date.now(),
    address: normalizedBuilder,
    usdc,
  };

  return usdc;
}

async function getApprovedBuilderFeeTenthsBps(userAddress, builderAddress) {
  const normalizedUser = String(userAddress || '').toLowerCase();
  const normalizedBuilder = String(builderAddress || '').toLowerCase();
  if (!normalizedUser || !normalizedBuilder) return 0;

  const cacheKey = `${normalizedUser}:${normalizedBuilder}`;
  const cached = builderApprovalCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < BUILDER_APPROVAL_CACHE_TTL_MS) {
    return cached.tenthsBps;
  }

  try {
    const approval = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'builderFeeApproval', user: normalizedUser, builderAddress: normalizedBuilder }),
    }).then(r => r.json());

    const tenthsBps = parsePercentToTenthsBps(approval?.maxFeeRate || '0%');
    builderApprovalCache.set(cacheKey, { fetchedAt: Date.now(), tenthsBps });
    return tenthsBps;
  } catch (error) {
    return 0;
  }
}

async function resolveBuilderForOrder(userAddress, amountUsdc, marketType = 'spot', isBuy = true) {
  let builderAddress;
  try {
    builderAddress = getBuilderAddress().toLowerCase();
  } catch (error) {
    return { builder: null, reason: 'builder-not-configured' };
  }

  if (marketType === 'spot' && isBuy) {
    return { builder: null, reason: 'spot-buy-no-builder-fee' };
  }

  try {
    const builderPerpUsdc = await getBuilderPerpUsdcBalance(builderAddress);
    if (builderPerpUsdc < BUILDER_REQUIRED_PERP_USDC) {
      return { builder: null, reason: 'builder-perp-balance-too-low', builderPerpUsdc };
    }

    const desiredFeeTenthsBps = computeBuilderFeeTenthsBps(amountUsdc, marketType);
    const approvedFeeTenthsBps = await getApprovedBuilderFeeTenthsBps(userAddress, builderAddress);
    if (approvedFeeTenthsBps < desiredFeeTenthsBps) {
      return {
        builder: null,
        reason: 'builder-fee-not-approved',
        desiredFeeTenthsBps,
        approvedFeeTenthsBps,
      };
    }

    return {
      builder: {
        address: builderAddress,
        fee: desiredFeeTenthsBps,
      },
      reason: 'builder-fee-applied',
      desiredFeeTenthsBps,
      approvedFeeTenthsBps,
      builderPerpUsdc,
    };
  } catch (error) {
    return {
      builder: null,
      reason: 'builder-fee-check-failed',
      error: error.message,
    };
  }
}

// ── Helpers ──

/**
 * Compute the action hash used by Hyperliquid for order signing.
 * Hyperliquid hashes the action with vaultAddress and nonce,
 * then combines it with the agent struct via EIP-712.
 */
function actionHash(action, vaultAddress, nonce) {
  // Hyperliquid uses msgpack for action serialization (matching Python SDK)
  const actionBytes = Buffer.from(msgpackEncode(action));

  // nonce as 8 bytes big-endian
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));

  // vault flag + optional vault address
  const vaultFlag = Buffer.from(vaultAddress ? [0x01] : [0x00]);
  let data = Buffer.concat([actionBytes, nonceBytes, vaultFlag]);

  if (vaultAddress) {
    const addrBytes = Buffer.from(vaultAddress.replace('0x', ''), 'hex');
    data = Buffer.concat([data, addrBytes]);
  }

  return keccak256(new Uint8Array(data));
}

/**
 * Sign an action as the agent wallet using EIP-712 Agent struct.
 */
async function signAsAgent(actionHashHex) {
  const account = getAgentAccount();
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(),
  });

  const connectionId = pad(account.address, { size: 32 });

  const signature = await walletClient.signTypedData({
    domain: HL_DOMAIN,
    types: AGENT_TYPES,
    primaryType: 'Agent',
    message: {
      source: 'a',
      connectionId,
    },
  });
  return signature;
}

async function getBurnedHype() {
  if (burnedSupplyCache.fetchedAt && (Date.now() - burnedSupplyCache.fetchedAt) < BURN_CACHE_TTL_MS) {
    return burnedSupplyCache.burnedHype;
  }

  const tokenDetails = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tokenDetails', tokenId: HYPE_TOKEN_ID }),
  }).then(r => r.json());

  let burnedHype = 0;
  for (const [address, balance] of tokenDetails?.nonCirculatingUserBalances || []) {
    if (!address || !BURN_ADDRESSES.has(String(address).toLowerCase())) continue;
    burnedHype += parseFloat(balance || '0') || 0;
  }

  burnedSupplyCache = {
    fetchedAt: Date.now(),
    burnedHype,
    circulatingSupply: parseFloat(tokenDetails?.circulatingSupply) || SUPPLY,
    totalSupply: parseFloat(tokenDetails?.totalSupply) || FDV_SUPPLY,
  };
  return burnedHype;
}

async function getAdjustedSupply(metric = 'mc', includeBurn = false) {
  const normalizedMetric = metric === 'fdv' ? 'fdv' : 'mc';
  const burnedHype = await getBurnedHype();
  // Use live supply from HL tokenDetails API
  const circulatingSupply = burnedSupplyCache.circulatingSupply || SUPPLY;  // already excludes burn
  const fdvTotal = burnedSupplyCache.totalSupply || FDV_SUPPLY;
  // MC: circulatingSupply already excludes burn — don't subtract again
  // FDV: totalSupply includes everything; subtract burn if requested
  const baseSupply = normalizedMetric === 'fdv' ? fdvTotal : circulatingSupply;
  const adjustedSupply = (normalizedMetric === 'fdv')
    ? Math.max(baseSupply - burnedHype, 1)
    : baseSupply; // no burn adjustment for MC

  return {
    metric: normalizedMetric,
    baseSupply,
    burnedHype,
    adjustedSupply,
    includeBurn,
    supplyUsed: (normalizedMetric === 'fdv' && includeBurn) ? adjustedSupply : baseSupply,
  };
}

function getRecentRevenueWindow(chart, windowDays = REVENUE_WINDOW_DAYS) {
  if (!Array.isArray(chart) || !chart.length) return [];
  return chart.slice(-Math.min(windowDays, chart.length));
}

function getAverageDailyRevenue(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  return entries.reduce((sum, [, value]) => sum + value, 0) / entries.length;
}

// ── Public API ──

/**
 * Fetch the current P/E ratio of HYPE.
 * P/E = Price / (Annualized Revenue / Supply)
 */
async function getCurrentPE(metric = 'mc', options = {}) {
  const normalizedMetric = metric === 'fdv' ? 'fdv' : 'mc';
  const includeBurn = options.includeBurn === true;
  const [priceData, feesData, supplyInfo] = await Promise.all([
    fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    }).then(r => r.json()),
    fetch(DEFILLAMA_URL).then(r => r.json()),
    getAdjustedSupply(normalizedMetric, includeBurn),
  ]);

  // Price
  const hypePrice = parseFloat(priceData['HYPE']);
  if (!hypePrice || isNaN(hypePrice)) throw new Error('Could not fetch HYPE price');

  // Daily revenue from DefiLlama — last entry in totalDataChart
  const chart = feesData.totalDataChart;
  if (!chart || chart.length === 0) throw new Error('No fee data from DefiLlama');

  // Use the last 30 days annualized revenue everywhere for consistency.
  const recentDays = getRecentRevenueWindow(chart);
  const avgDailyRevenue = getAverageDailyRevenue(recentDays);
  const annualizedRevenue = avgDailyRevenue * 365;
  const revenuePerToken = annualizedRevenue / supplyInfo.supplyUsed;
  const pe = hypePrice / revenuePerToken;

  return {
    pe: Math.round(pe * 100) / 100,
    price: hypePrice,
    dailyRevenue: avgDailyRevenue,
    annualizedRevenue,
    metric: normalizedMetric,
    includeBurn,
    baseSupply: supplyInfo.baseSupply,
    burnedHype: supplyInfo.burnedHype,
    supplyUsed: supplyInfo.supplyUsed,
    adjustedSupply: supplyInfo.adjustedSupply,
  };
}

/**
 * Compute the median P/E over the last 30 days using rolling 30-day annualized revenue.
 * Each day gets its own P/E from the rolling 30-day average ending on that day.
 * Returns the median of those daily P/E values alongside the spot P/E.
 */
async function getMedianPE(metric = 'mc', options = {}) {
  const normalizedMetric = metric === 'fdv' ? 'fdv' : 'mc';
  const includeBurn = options.includeBurn === true;
  const [priceData, feesData, supplyInfo] = await Promise.all([
    fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    }).then(r => r.json()),
    fetch(DEFILLAMA_URL).then(r => r.json()),
    getAdjustedSupply(normalizedMetric, includeBurn),
  ]);

  const hypePrice = parseFloat(priceData['HYPE']);
  if (!hypePrice || isNaN(hypePrice)) throw new Error('Could not fetch HYPE price');

  const chart = feesData.totalDataChart;
  if (!chart || chart.length < 2) throw new Error('Not enough fee data for median');

  const startIndex = Math.max(0, chart.length - REVENUE_WINDOW_DAYS);
  const dailyPEs = chart
    .map((entry, index) => {
      if (index < startIndex) return null;
      const window = chart.slice(Math.max(0, index - REVENUE_WINDOW_DAYS + 1), index + 1);
      const avgDailyRevenue = getAverageDailyRevenue(window);
      if (avgDailyRevenue <= 0) return null;
      const annualized = avgDailyRevenue * 365;
      return hypePrice / (annualized / supplyInfo.supplyUsed);
    })
    .filter(v => v !== null)
    .sort((a, b) => a - b);

  if (dailyPEs.length === 0) throw new Error('No valid P/E data for median');

  const mid = Math.floor(dailyPEs.length / 2);
  const medianPE = dailyPEs.length % 2 === 0
    ? (dailyPEs[mid - 1] + dailyPEs[mid]) / 2
    : dailyPEs[mid];

  return {
    medianPE: Math.round(medianPE * 100) / 100,
    price: hypePrice,
    revenueWindowDays: REVENUE_WINDOW_DAYS,
    metric: normalizedMetric,
    includeBurn,
    baseSupply: supplyInfo.baseSupply,
    burnedHype: supplyInfo.burnedHype,
    supplyUsed: supplyInfo.supplyUsed,
    adjustedSupply: supplyInfo.adjustedSupply,
  };
}

/**
 * Resolve the HYPE spot asset index.
 * Native HYPE is traded on the spot market (coin @107, token index 150).
 */
async function resolveHypeSpotIndex() {
  if (HYPE_SPOT_INDEX !== null) return HYPE_SPOT_INDEX;

  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
  }).then(r => r.json());

  const tokens = res[0]?.tokens || [];
  const universe = res[0]?.universe || [];

  for (let i = 0; i < universe.length; i++) {
    const ti = universe[i].tokens || [];
    const names = ti.map(t => tokens[t]?.name).filter(Boolean);
    if (names.includes('HYPE') && names.includes('USDC')) {
      HYPE_SPOT_INDEX = 10000 + universe[i].index;
      console.log(`[HL] Resolved HYPE spot index: ${HYPE_SPOT_INDEX} (universe pos ${i}, index ${universe[i].index}, coin ${universe[i].name})`);
      break;
    }
  }

  if (HYPE_SPOT_INDEX === null) throw new Error('Could not resolve HYPE spot asset index');
  return HYPE_SPOT_INDEX;
}

/**
 * Resolve the HYPE perp asset index.
 */
async function resolveHypePerpIndex() {
  if (HYPE_PERP_INDEX !== null) return HYPE_PERP_INDEX;

  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  }).then(r => r.json());

  const universe = res?.universe || [];
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].name === 'HYPE') {
      HYPE_PERP_INDEX = i;
      console.log(`[HL] Resolved HYPE perp index: ${i}`);
      break;
    }
  }

  if (HYPE_PERP_INDEX === null) throw new Error('Could not resolve HYPE perp asset index');
  return HYPE_PERP_INDEX;
}

/**
 * Resolve HYPE asset index based on market type.
 */
async function resolveHypeAssetIndex(marketType = 'spot') {
  return marketType === 'perp' ? resolveHypePerpIndex() : resolveHypeSpotIndex();
}

/**
 * Get the current HYPE spot mid price from the order book.
 */
async function getHypeSpotPrice() {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin: '@107' }),
  }).then(r => r.json());

  const bestBid = parseFloat(res.levels?.[0]?.[0]?.px);
  const bestAsk = parseFloat(res.levels?.[1]?.[0]?.px);
  if (!bestBid || !bestAsk) throw new Error('Could not fetch HYPE spot order book');
  return { bid: bestBid, ask: bestAsk, mid: (bestBid + bestAsk) / 2 };
}

/**
 * Get the current HYPE perp mid price from allMids.
 */
async function getHypePerpPrice() {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  }).then(r => r.json());

  const mid = parseFloat(res['HYPE']);
  if (!mid) throw new Error('Could not fetch HYPE perp price');
  return { bid: mid, ask: mid, mid };
}

/**
 * Get HYPE price based on market type.
 */
async function getHypePrice(marketType = 'spot') {
  return marketType === 'perp' ? getHypePerpPrice() : getHypeSpotPrice();
}

/**
 * Get user's USDC balance on Hyperliquid spot.
 */
async function getUserBalance(userAddress) {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotClearinghouseState', user: userAddress }),
  }).then(r => r.json());

  let usdc = 0;
  if (res.balances) {
    for (const b of res.balances) {
      if (b.coin === 'USDC' || b.token === 0) {
        usdc = parseFloat(b.total || b.hold || '0');
      }
    }
  }
  return usdc;
}

/**
 * Forward the user's approveAgent signature to Hyperliquid.
 */
async function approveAgent(userAddress, signature, nonce) {
  const agentAccount = getAgentAccount();

  const payload = {
    action: {
      type: 'approveAgent',
      hyperliquidChain: 'Mainnet',
      agentAddress: agentAccount.address,
      agentName: 'Hypurrmium AutoBuy',
      nonce: nonce,
    },
    nonce: nonce,
    signature: {
      r: signature.slice(0, 66),
      s: '0x' + signature.slice(66, 130),
      v: parseInt(signature.slice(130, 132), 16),
    },
    vaultAddress: null,
  };

  const res = await fetch(HL_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (data.status === 'err') throw new Error(data.response || 'approveAgent failed');
  return data;
}

/**
 * Place a market buy order for HYPE on behalf of a user.
 * Market = aggressive IOC limit at price * 1.01 (1% slippage).
 */
async function placeMarketBuy(userAddress, amountUsdc, marketType = 'spot') {
  const assetIndex = await resolveHypeAssetIndex(marketType);
  const { ask } = await getHypePrice(marketType);
  const slippagePrice = Math.round(ask * 1.005 * 1000) / 1000; // 0.5% slippage above best ask
  const sizeHype = Math.ceil((amountUsdc / ask) * 100) / 100; // szDecimals=2, round UP to meet minimum

  console.log(`[HL] Market buy (${marketType}): ${sizeHype} HYPE @ limit $${slippagePrice} (ask $${ask})`);
  return _placeOrder(userAddress, assetIndex, slippagePrice, sizeHype, 'Ioc', true, amountUsdc, marketType);
}

/**
 * Place a market sell order for HYPE on behalf of a user.
 */
async function placeMarketSell(userAddress, amountUsdc, marketType = 'spot') {
  const assetIndex = await resolveHypeAssetIndex(marketType);
  const { bid } = await getHypePrice(marketType);
  const slippagePrice = Math.round(bid * 0.995 * 1000) / 1000; // 0.5% slippage below best bid
  const sizeHype = Math.ceil((amountUsdc / bid) * 100) / 100;

  console.log(`[HL] Market sell (${marketType}): ${sizeHype} HYPE @ limit $${slippagePrice} (bid $${bid})`);
  return _placeOrder(userAddress, assetIndex, slippagePrice, sizeHype, 'Ioc', false, amountUsdc, marketType);
}

/**
 * Place a limit buy order for HYPE on behalf of a user.
 * offsetPct is negative, e.g. -2 means 2% below current price.
 */
async function placeLimitBuy(userAddress, amountUsdc, offsetPct, marketType = 'spot') {
  const assetIndex = await resolveHypeAssetIndex(marketType);
  const { mid } = await getHypePrice(marketType);
  const limitPrice = Math.round(mid * (1 + offsetPct / 100) * 1000) / 1000;
  const sizeHype = Math.ceil((amountUsdc / limitPrice) * 100) / 100;

  console.log(`[HL] Limit buy (${marketType}): ${sizeHype} HYPE @ $${limitPrice} (mid $${mid}, offset ${offsetPct}%)`);
  return _placeOrder(userAddress, assetIndex, limitPrice, sizeHype, 'Gtc', true, amountUsdc, marketType);
}

/**
 * Place a limit sell order for HYPE on behalf of a user.
 * offsetPct is positive, e.g. +2 means 2% above current price.
 */
async function placeLimitSell(userAddress, amountUsdc, offsetPct, marketType = 'spot') {
  const assetIndex = await resolveHypeAssetIndex(marketType);
  const { mid } = await getHypePrice(marketType);
  const limitPrice = Math.round(mid * (1 + offsetPct / 100) * 1000) / 1000;
  const sizeHype = Math.ceil((amountUsdc / limitPrice) * 100) / 100;

  console.log(`[HL] Limit sell (${marketType}): ${sizeHype} HYPE @ $${limitPrice} (mid $${mid}, offset ${offsetPct}%)`);
  return _placeOrder(userAddress, assetIndex, limitPrice, sizeHype, 'Gtc', false, amountUsdc, marketType);
}

/**
 * Internal: place an order signed by the agent wallet on behalf of userAddress.
 */
async function _placeOrder(userAddress, assetIndex, price, size, tif, isBuy = true, amountUsdc = 0, marketType = 'spot') {
  const agentAccount = getAgentAccount();
  const nonce = Date.now();
  const builderInfo = await resolveBuilderForOrder(userAddress, amountUsdc || (price * size), marketType, isBuy);

  const orderAction = {
    type: 'order',
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: price.toString(),
      s: size.toString(),
      r: false,
      t: { limit: { tif } },
    }],
    grouping: 'na',
    ...(builderInfo.builder
      ? {
          builder: {
            b: builderInfo.builder.address,
            f: builderInfo.builder.fee,
          },
        }
      : {}),
  };

  if (builderInfo.builder) {
    console.log(`[HL] Builder fee applied: ${formatTenthsBpsAsPercent(builderInfo.builder.fee)} on ${marketType} order for ${userAddress}`);
  } else if (builderInfo.reason) {
    console.log(`[HL] Builder fee skipped: ${builderInfo.reason}`);
  }

  // Hash the action (used as connectionId in phantom Agent struct)
  const hash = actionHash(orderAction, null, nonce);

  // Sign via EIP-712 Agent struct with L1 domain
  const walletClient = createWalletClient({
    account: agentAccount,
    chain: arbitrum,
    transport: http(),
  });

  // connectionId = actionHash (NOT userAddress) — per Hyperliquid SDK
  const connectionId = hash;

  const signature = await walletClient.signTypedData({
    domain: L1_DOMAIN,
    types: AGENT_TYPES,
    primaryType: 'Agent',
    message: {
      source: 'a',
      connectionId,
    },
  });

  const payload = {
    action: orderAction,
    nonce,
    signature: {
      r: signature.slice(0, 66),
      s: '0x' + signature.slice(66, 130),
      v: parseInt(signature.slice(130, 132), 16),
    },
    vaultAddress: null,
  };

  const res = await fetch(HL_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  console.log('[HL API Response]', JSON.stringify(data));

  // Check for API errors
  if (data.status === 'err') {
    throw new Error(`Hyperliquid order failed: ${data.response || JSON.stringify(data)}`);
  }

  // Extract actual fill data if available
  let filledSize = size;
  let filledPrice = price;
  try {
    const statuses = data?.response?.data?.statuses;
    if (statuses && statuses[0]) {
      const s = statuses[0];
      if (s.filled) {
        filledSize = parseFloat(s.filled.totalSz) || size;
        filledPrice = parseFloat(s.filled.avgPx) || price;
      } else if (s.resting) {
        filledSize = parseFloat(s.resting.sz) || size;
      } else if (s.error) {
        throw new Error(`Order rejected: ${s.error}`);
      }
    }
  } catch (e) {
    if (e.message.startsWith('Order rejected')) throw e;
    // If parsing fails, use intended values
  }

  return {
    response: data,
    price: filledPrice,
    size: filledSize,
    amountUsdc: filledPrice * filledSize,
    builderFeeApplied: !!builderInfo.builder,
    builderFeeTenthsBps: builderInfo.builder ? builderInfo.builder.fee : 0,
    builderFeeRate: builderInfo.builder ? formatTenthsBpsAsPercent(builderInfo.builder.fee) : '0.00%',
    builderFeeReason: builderInfo.reason || null,
  };
}

/**
 * Revoke the agent authorization for a user.
 * Sends approveAgent with agentAddress = 0x0 (revocation).
 */
async function revokeAgent(userAddress) {
  // Revocation must be signed by the USER, not the agent.
  // The frontend should call approveAgent with agentAddress = 0x0.
  // On the backend, we just mark the strategy as inactive.
  // Actual on-chain revocation is done client-side.
  return { status: 'ok', message: 'Strategy deactivated. Revoke agent on-chain via the frontend.' };
}

module.exports = {
  getCurrentPE,
  getMedianPE,
  getHypeSpotPrice,
  approveAgent,
  placeMarketBuy,
  placeMarketSell,
  placeLimitBuy,
  placeLimitSell,
  revokeAgent,
  getUserBalance,
  resolveHypeAssetIndex,
  getAgentAccount,
  getBuilderAddress,
  getBuilderApprovalMaxFeeRate,
};
